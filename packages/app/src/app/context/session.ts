import { createEffect, createMemo, onCleanup } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";
import type { VesloSessionTranscriptSnapshot } from "../lib/veslo-server";

import type {
  Client,
  MessageInfo,
  MessageWithParts,
  OpencodeEvent,
  PendingPermission,
  PendingQuestion,
  ReloadReason,
  ReloadTrigger,
  SessionErrorTurn,
  TodoItem,
} from "../types";
import {
  addOpencodeCacheHint,
  type DirectoryQueryPathMode,
  normalizeDirectoryPath,
  safeStringify,
} from "../utils";
import type { WorkspaceRouting } from "./workspace-routing";
import { perfNow, recordPerfLog } from "../lib/perf-log";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { detectChromeMcpCompletedError } from "../lib/chrome-mcp-error";
import {
  toolNameFromPart,
  toolStateFromPart,
} from "../lib/opencode-part-access";
import {
  readSessionStatus,
  withSessionStatus,
} from "../lib/scoped-session-status";
import {
  appendSessionErrorTurnModel,
  applyCommandDisplayAlias,
  formatSlashCommandDisplay,
  readSessionErrorTurnsForScope,
  scopedSessionAliasKeys,
  sessionErrorTurnScopeKey,
  sortSessionsByActivity,
} from "./session-store-model";
import {
  createSessionTranscriptController,
} from "./session-transcript-controller";
import { createSessionRuntimePrompts } from "./session-runtime-prompts";
import {
  createSessionSelectionController,
  isSessionNotFoundError,
  type SessionOfflineTranscriptLoadResult,
} from "./session-selection-controller";
import { createSessionEventStreamController } from "./session-event-stream";
import {
  createSessionLifecycleRecoveryController,
  type SessionLifecycleRecoveryScope,
  type SessionLifecycleRecoveryStatus,
  type SessionRunDiagnostic,
} from "./session-lifecycle-recovery";
import { createSessionWorkspaceCacheController } from "./session-workspace-cache";
import type { ReconnectNotice, ReconnectState } from "./session-reconnect";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";

export type SessionStore = ReturnType<typeof createSessionStore>;
export type { WorkspaceSessionCache } from "./session-workspace-cache";

type SessionStatusTraceRoot = typeof window & {
  __vesloSessionStatusTrace?: Array<Record<string, unknown>>;
  __vesloSessionStatusSnapshot?: Record<string, string>;
};

type RuntimeEffectTraceRoot = typeof window & {
  __vesloActiveSendTraceId?: string | null;
};

function activeSendTraceId() {
  if (typeof window === "undefined") return null;
  return (window as RuntimeEffectTraceRoot).__vesloActiveSendTraceId ?? null;
}

function recordSessionStatusTrace(event: string, payload?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const root = window as SessionStatusTraceRoot;
    const logs = root.__vesloSessionStatusTrace ?? [];
    logs.push({
      at: new Date().toISOString(),
      ts: Date.now(),
      source: "session",
      event,
      ...(payload ?? {}),
    });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    root.__vesloSessionStatusTrace = logs;
    if (payload?.next && typeof payload.next === "object") {
      root.__vesloSessionStatusSnapshot = payload.next as Record<string, string>;
    }
    console.log("[session:status]", event, payload ?? {});
  } catch {
    // ignore
  }
}

function recordSessionLifecycleRecoveryTrace(event: string, payload?: Record<string, unknown>) {
  recordSessionStatusTrace(event, payload);
  recordSendWorkflowTrace("session-lifecycle-recovery", event, payload);
}

type StoreState = {
  sessions: Session[];
  sessionStatus: Record<string, string>;
  conversationRunDiagnosticsBySessionKey: Record<string, SessionRunDiagnostic>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  commandDisplayByMessageID: Record<string, string>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  events: OpencodeEvent[];
};

const SYNTHETIC_CONTINUE_CONTROL_PATTERN =
  /^\s*continue if you have next steps,\s*or stop and ask for clarification if you are unsure how to proceed\.?\s*$/i;
const COMPACTION_DIAGNOSTIC_WINDOW_MS = 60_000;
const COMPACTION_LOOP_WARN_THRESHOLD = 3;
const COMPACTION_LOOP_WARN_MIN_INTERVAL_MS = 10_000;

export function shouldDeferToolErrorToLifecycle(
  sessionId: string | null | undefined,
  workspaceId: string | null | undefined,
  observe: ((sessionId: string, workspaceId: string) => boolean) | null | undefined,
) {
  const normalizedSessionId = sessionId?.trim() ?? "";
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  return Boolean(
    normalizedSessionId &&
    normalizedWorkspaceId &&
    observe?.(normalizedSessionId, normalizedWorkspaceId),
  );
}

export function createSessionStore(options: {
  client: () => Client | null;
  // VSLO-171 F3Ú4 — workspace routing service. Prefer
  // `options.routing.active()` over `options.client()` for new code.
  routing: WorkspaceRouting;
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  selectSessionScopeKey?: (sessionID: string) => string;
  resolveSessionWorkspaceId?: (sessionID: string) => string | null;
  sessionDirectoryOverrideById?: () => Record<string, string>;
  directoryQueryPathMode?: () => DirectoryQueryPathMode;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  onReconnectNotice?: (notice: ReconnectNotice) => void;
  onReconnectState?: (state: ReconnectState) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onHotReloadApplied?: () => void;
  onSessionLoadComplete?: () => void;
  loadOfflineTranscript?: (sessionID: string, limit: number) => Promise<SessionOfflineTranscriptLoadResult>;
  resolveConversationRunForSession?: (
    sessionID: string,
    workspaceIdHint?: string | null,
    options?: { allowLatest?: boolean },
  ) => SessionLifecycleRecoveryScope | null;
  readConversationRunStatus?: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<SessionLifecycleRecoveryStatus | null>;
  recoverAcceptedConversationRunStatus?: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<SessionLifecycleRecoveryStatus | null>;
  recoverAcceptedConversationTranscript?: (
    scope: SessionLifecycleRecoveryScope,
  ) => Promise<VesloSessionTranscriptSnapshot | null>;
  recoverConversationTranscript?: (scope: {
    workspaceId: string;
    sessionId: string;
    directory?: string | null;
    expectedRunId?: string | null;
  }) => Promise<VesloSessionTranscriptSnapshot | null>;
  lifecycleRecoveryDiagnosticContext?: () => {
    appWorkspaceId?: string | null;
    connectionSnapshot?: Record<string, string | null | undefined> | null;
  };
  conversationReader?: () => {
    listConversations: (
      workspaceId: string,
      directory?: string,
      options?: { sync?: boolean },
    ) => Promise<{ items: Session[]; source?: "sqlite" | "unavailable" }>;
  } | null;
  /**
   * Legacy active-workspace runtime readiness fallback. Browse/live transcript
   * policy is owned by `shouldBrowseSessionFromDb`, so background warmup can
   * make the runtime ready without making ordinary history browsing use
   * `session.messages`.
   */
  engineReady?: () => boolean;
  isWorkspaceRuntimeReady?: (workspaceId: string) => boolean;
  recoverWorkspaceRuntimeForEventStream?: (workspaceId: string) => Promise<boolean> | boolean;
  shouldBrowseSessionFromDb?: (sessionID: string) => boolean;
  onSessionBusyChange?: (sessionId: string, busy: boolean, workspaceId?: string) => void;
  onAssistantResponseObserved?: (sessionId: string) => void;
}) {

  const notifySessionBusy = (sessionId: string, status: string, workspaceId?: string) => {
    recordSessionStatusTrace("notify-busy", {
      sessionId,
      status,
      busy: status !== "idle",
      workspaceId: workspaceId ?? null,
    });
    if (!options.onSessionBusyChange) return;
    options.onSessionBusyChange(sessionId, status !== "idle", workspaceId);
  };

  const sessionDebugEnabled = () => options.developerMode();

  const sessionDebug = (label: string, payload?: unknown) => {
    if (!sessionDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };

  const sessionWarn = (label: string, payload?: unknown) => {
    if (!sessionDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.warn(`[WSWARN] ${label}`);
      } else {
        console.warn(`[WSWARN] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };

  const isWorkspaceRuntimeReady = (workspaceId?: string | null) => {
    const id = workspaceId?.trim() ?? "";
    if (id && options.isWorkspaceRuntimeReady) return options.isWorkspaceRuntimeReady(id);
    return options.engineReady ? options.engineReady() : false;
  };

  const isActiveWorkspaceRuntimeReady = () =>
    isWorkspaceRuntimeReady(options.routing.activeWorkspaceId().trim());

  const resolveSessionWorkspaceId = (sessionID: string) =>
    options.resolveSessionWorkspaceId?.(sessionID)?.trim() ?? "";

  const clientForSession = (sessionID: string) => {
    const workspaceId = resolveSessionWorkspaceId(sessionID);
    return {
      workspaceId,
      client: workspaceId ? options.routing.client(workspaceId) : options.routing.active(),
    };
  };

  const sessionReadPolicy = (sessionID: string, workspaceId: string) => {
    const activeWorkspaceId = options.routing.activeWorkspaceId().trim();
    const foreignWorkspace = Boolean(workspaceId && activeWorkspaceId && workspaceId !== activeWorkspaceId);
    const runtimeReady = workspaceId
      ? isWorkspaceRuntimeReady(workspaceId)
      : isActiveWorkspaceRuntimeReady();
    const configuredBrowseFromDb = options.shouldBrowseSessionFromDb?.(sessionID) ?? false;
    const browseModeOnly = !runtimeReady;
    const browseFromDb = configuredBrowseFromDb || browseModeOnly || foreignWorkspace;
    const liveRecoveryFromUnavailable = Boolean(
      configuredBrowseFromDb &&
      workspaceId &&
      activeWorkspaceId &&
      workspaceId === activeWorkspaceId &&
      runtimeReady &&
      !foreignWorkspace,
    );
    return {
      activeWorkspaceId,
      browseFromDb,
      browseModeOnly,
      configuredBrowseFromDb,
      foreignWorkspace,
      liveRecoveryFromUnavailable,
      sessionWorkspaceId: workspaceId,
    };
  };

  const hasAnyRefreshableRuntime = () => {
    const entryIds = options.routing.entryIds();
    if (entryIds.length > 0) {
      return entryIds.some((workspaceId) => isWorkspaceRuntimeReady(workspaceId));
    }
    return isActiveWorkspaceRuntimeReady();
  };

  const MAX_RELOAD_DETECTION_KEYS = 5000;

  const sessionDirectoryOverrides = () => options.sessionDirectoryOverrideById?.() ?? {};
  const applySessionDirectoryOverride = <T extends Session>(session: T): T => {
    const override = sessionDirectoryOverrides()[session.id]?.trim() ?? "";
    if (!override) return session;
    if ((session.directory ?? "").trim() === override) return session;
    return { ...session, directory: override } as T;
  };
  const resolveSessionDirectory = (session: Pick<Session, "id" | "directory">) =>
    normalizeDirectoryPath(sessionDirectoryOverrides()[session.id] ?? session.directory ?? "");

  const [store, setStore] = createStore<StoreState>({
    sessions: [],
    sessionStatus: {},
    conversationRunDiagnosticsBySessionKey: {},
    sessionErrorTurns: {},
    messages: {},
    parts: {},
    commandDisplayByMessageID: {},
    todos: {},
    pendingPermissions: [],
    pendingQuestions: [],
    events: [],
  });
  const statusWorkspaceId = (workspaceId?: string | null) =>
    workspaceId?.trim() || options.routing.activeWorkspaceId().trim();

  const readStatusForSession = (sessionID: string | null | undefined, workspaceId?: string | null) =>
    readSessionStatus(store.sessionStatus, statusWorkspaceId(workspaceId), sessionID);

  const setSessionStatusForWorkspace = (
    sessionID: string | null | undefined,
    status: string,
    workspaceId?: string | null,
  ) => {
    const id = sessionID?.trim() ?? "";
    if (!id) return;
    setStore("sessionStatus", withSessionStatus(store.sessionStatus, statusWorkspaceId(workspaceId), id, status));
  };

  const conversationRunDiagnosticKeys = (scope: SessionLifecycleRecoveryScope) => {
    const workspaceId = statusWorkspaceId(scope.workspaceId);
    return scopedSessionAliasKeys(workspaceId, [
      scope.sessionId,
      scope.opencodeSessionId,
      scope.conversationId,
    ]);
  };

  function updateConversationRunDiagnosticsForScope(
    scope: SessionLifecycleRecoveryScope,
    status: SessionLifecycleRecoveryStatus | null,
  ) {
    const keys = conversationRunDiagnosticKeys(scope);
    if (keys.length === 0) return;
    if (!status) {
      setStore(
        "conversationRunDiagnosticsBySessionKey",
        produce((draft: Record<string, SessionRunDiagnostic>) => {
          for (const key of keys) delete draft[key];
        }),
      );
      return;
    }

    const diagnostic: SessionRunDiagnostic = {
      ...status,
      sessionId: scope.sessionId,
      workspaceId: statusWorkspaceId(scope.workspaceId),
      conversationId: scope.conversationId,
      opencodeSessionId: scope.opencodeSessionId ?? null,
    };
    setStore(
      "conversationRunDiagnosticsBySessionKey",
      produce((draft: Record<string, SessionRunDiagnostic>) => {
        for (const key of keys) draft[key] = diagnostic;
      }),
    );
  }

  const reloadDetectionSet = new Set<string>();
  const invalidToolDetectionSet = new Set<string>();
  const chromeMcpFailureDetectionSet = new Set<string>();
  let observeToolErrorLifecycle = (_sessionId: string, _workspaceId: string) => false;
  const syntheticContinueEventTimesBySession = new Map<string, number[]>();
  const syntheticContinueLoopLastWarnAtBySession = new Map<string, number>();
  const workspaceSessionIds = new Set<string>();
  const skillPathPattern = /(?:^|[\\/])\.opencode[\\/](skill|skills)[\\/]/i;
  const skillNamePattern = /[\\/]\.opencode[\\/](?:skill|skills)[\\/]+([^\\/]+)/i;
  const commandPathPattern = /(?:^|[\\/])\.opencode[\\/](command|commands)[\\/]/i;
  const commandNamePattern = /[\\/]\.opencode[\\/](?:command|commands)[\\/]+([^\\/]+)/i;
  const agentPathPattern = /(?:^|[\\/])\.opencode[\\/](agent|agents)[\\/]/i;
  const agentNamePattern = /[\\/]\.opencode[\\/](?:agent|agents)[\\/]+([^\\/]+)/i;
  const opencodeConfigPattern = /(?:^|[\\/])opencode\.jsonc?\b/i;
  const opencodePathPattern = /(?:^|[\\/])\.opencode[\\/]/i;
  const vesloConfigPattern = /[\\/]\.opencode[\\/]veslo\.json\b/i;
  const mutatingTools = new Set(["write", "edit", "apply_patch"]);

  const extractSearchText = (value: unknown) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return safeStringify(value);
  };

  const detectReloadReason = (value: unknown): ReloadReason | null => {
    const text = extractSearchText(value);
    if (!text) return null;
    if (vesloConfigPattern.test(text)) return null;
    if (skillPathPattern.test(text)) return "skills";
    if (commandPathPattern.test(text)) return "commands";
    if (agentPathPattern.test(text)) return "agents";
    if (opencodeConfigPattern.test(text)) return "config";
    if (opencodePathPattern.test(text)) return "config";
    return null;
  };

  const detectReloadTriggerFromText = (text: string): ReloadTrigger | null => {
    if (vesloConfigPattern.test(text)) {
      return null;
    }
    if (skillPathPattern.test(text)) {
      const match = text.match(skillNamePattern);
      return {
        type: "skill",
        name: match?.[1],
        action: "updated",
        path: match?.[0],
      };
    }

    if (commandPathPattern.test(text)) {
      const match = text.match(commandNamePattern);
      const raw = match?.[1];
      const name = raw ? raw.replace(/\.md$/i, "") : undefined;
      return {
        type: "command",
        name,
        action: "updated",
        path: match?.[0],
      };
    }

    if (agentPathPattern.test(text)) {
      const match = text.match(agentNamePattern);
      return {
        type: "agent",
        name: match?.[1],
        action: "updated",
        path: match?.[0],
      };
    }

    if (opencodeConfigPattern.test(text) || opencodePathPattern.test(text)) {
      return {
        type: "config",
        action: "updated",
      };
    }
    return null;
  };

  const detectReloadReasonDeep = (value: unknown): ReloadReason | null => {
    if (!value) return null;
    if (typeof value === "string" || typeof value === "number") {
      return detectReloadReason(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const reason = detectReloadReasonDeep(entry);
        if (reason) return reason;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const reason = detectReloadReasonDeep(entry);
        if (reason) return reason;
      }
    }
    return null;
  };

  const detectReloadTriggerDeep = (value: unknown): ReloadTrigger | null => {
    if (!value) return null;
    if (typeof value === "string" || typeof value === "number") {
      return detectReloadTriggerFromText(String(value));
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const trigger = detectReloadTriggerDeep(entry);
        if (trigger) return trigger;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const trigger = detectReloadTriggerDeep(entry);
        if (trigger) return trigger;
      }
    }
    return null;
  };

  const detectReloadFromPart = (part: Part): { reason: ReloadReason; trigger?: ReloadTrigger } | null => {
    if (part.type !== "tool") return null;
    const record = part as Record<string, unknown>;
    const toolName = typeof record.tool === "string" ? record.tool : "";
    if (!mutatingTools.has(toolName)) return null;
    const state = (record.state ?? {}) as Record<string, unknown>;
    const reason =
      detectReloadReasonDeep(state.input) ||
      detectReloadReasonDeep(state.patch) ||
      detectReloadReasonDeep(state.diff);
    if (!reason) return null;
    const trigger =
      detectReloadTriggerDeep(state.input) ||
      detectReloadTriggerDeep(state.patch) ||
      detectReloadTriggerDeep(state.diff);
    return { reason, trigger: trigger ?? undefined };
  };

  const maybeMarkReloadRequired = (part: Part) => {
    if (!options.markReloadRequired) return;
    if (!part?.id || !part.messageID) return;

    const root = normalizeDirectoryPath(options.activeWorkspaceRoot());
    if (root) {
      const session = store.sessions.find((candidate) => candidate.id === part.sessionID) ?? null;
      const sessionRoot = normalizeDirectoryPath(session?.directory ?? "");
      if (!sessionRoot || sessionRoot !== root) {
        return;
      }
    }

    const key = `${part.messageID}:${part.id}`;
    if (reloadDetectionSet.has(key)) return;
    const detection = detectReloadFromPart(part);
    if (!detection) return;
    reloadDetectionSet.add(key);
    options.markReloadRequired(detection.reason, detection.trigger);
  };

  const toolErrorText = (part: Part) => {
    if (part.type !== "tool") return "";
    const state = toolStateFromPart(part);
    const title = typeof state.title === "string" ? state.title : "";
    const error = typeof state.error === "string" ? state.error : "";
    const detail = typeof state.detail === "string" ? state.detail : "";
    return [title, error, detail].filter(Boolean).join("\n");
  };

  const isInvalidToolError = (part: Part) => {
    if (part.type !== "tool") return false;
    const haystack = toolErrorText(part).toLowerCase();
    if (!haystack) return false;
    return (
      haystack.includes("invalid tool") ||
      haystack.includes("model tried to call") ||
      haystack.includes("unavailable tool") ||
      haystack.includes("unknown tool") ||
      haystack.includes("tool not found")
    );
  };

  const invalidToolNextStepHint = (part: Part) => {
    const name = toolNameFromPart(part);
    const lower = name.toLowerCase();
    if (lower.includes("browser") || lower.includes("chrome") || lower.includes("devtools")) {
      return __vesloIndirectT("ui.indirect.chrome_mcp_is_not_ready_yet_open_the_mcp_tab_c_r0vewj", __vesloIndirectLocale());
    }
    return __vesloIndirectT("ui.indirect.try_again_or_switch_to_an_agent_prompt_that_on_1x3e0z", __vesloIndirectLocale());
  };

  const maybeHandleInvalidToolError = (part: Part, sourceWorkspaceId?: string | null) => {
    if (!options.setError) return;
    if (!isInvalidToolError(part)) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (invalidToolDetectionSet.has(key)) return;
    invalidToolDetectionSet.add(key);

    const workspaceId = statusWorkspaceId(sourceWorkspaceId);
    const lifecycleOwnsError = shouldDeferToolErrorToLifecycle(
      part.sessionID,
      workspaceId,
      observeToolErrorLifecycle,
    );
    // A known admitted run retains lifecycle ownership until its exact durable
    // status settles. Non-owned tool failures keep the prior local fallback.
    if (part.sessionID && !lifecycleOwnsError) {
      setSessionStatusForWorkspace(part.sessionID, "idle", workspaceId);
      notifySessionBusy(part.sessionID, "idle", workspaceId);
    }

    const toolName = toolNameFromPart(part).trim();
    const tool = toolName || __vesloIndirectT("ui.indirect.unknown_tool_8c32ki", __vesloIndirectLocale());
    const hint = invalidToolNextStepHint(part);
    options.setError(`Invalid tool call: ${tool}.\n\n${hint}`);
  };

  const maybeHandleChromeMcpCompletedError = (part: Part, sourceWorkspaceId?: string | null) => {
    if (!options.setError) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (chromeMcpFailureDetectionSet.has(key)) return;

    const detected = detectChromeMcpCompletedError(part);
    if (!detected) return;

    chromeMcpFailureDetectionSet.add(key);

    const workspaceId = statusWorkspaceId(sourceWorkspaceId);
    const lifecycleOwnsError = shouldDeferToolErrorToLifecycle(
      part.sessionID,
      workspaceId,
      observeToolErrorLifecycle,
    );
    if (part.sessionID) {
      if (!lifecycleOwnsError) {
        setSessionStatusForWorkspace(part.sessionID, "idle", workspaceId);
        notifySessionBusy(part.sessionID, "idle", workspaceId);
      }
      appendSessionErrorTurn(part.sessionID, addOpencodeCacheHint(detected), { workspaceId });
    }
    options.setError(addOpencodeCacheHint(detected));
  };

  const isSyntheticContinueControlPart = (part: Part) => {
    if (part.type !== "text") return false;
    const record = part as Part & { text?: unknown; synthetic?: unknown; ignored?: unknown };
    if (record.synthetic !== true) return false;
    if (record.ignored === true) return false;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return false;
    return SYNTHETIC_CONTINUE_CONTROL_PATTERN.test(text);
  };

  const recordSyntheticContinueDiagnostic = (part: Part) => {
    if (!isSyntheticContinueControlPart(part)) return;
    const sessionID = part.sessionID;
    const now = Date.now();
    const windowStart = now - COMPACTION_DIAGNOSTIC_WINDOW_MS;
    const previous = syntheticContinueEventTimesBySession.get(sessionID) ?? [];
    const next = previous.filter((timestamp) => timestamp >= windowStart);
    next.push(now);
    syntheticContinueEventTimesBySession.set(sessionID, next);

    const countInWindow = next.length;
    recordPerfLog(sessionDebugEnabled(), "session.compaction", "synthetic-continue", {
      sessionID,
      messageID: part.messageID,
      partID: part.id,
      countPerMinute: countInWindow,
      windowMs: COMPACTION_DIAGNOSTIC_WINDOW_MS,
    });

    if (countInWindow < COMPACTION_LOOP_WARN_THRESHOLD) return;

    const lastWarnAt = syntheticContinueLoopLastWarnAtBySession.get(sessionID) ?? 0;
    if (now - lastWarnAt < COMPACTION_LOOP_WARN_MIN_INTERVAL_MS) return;
    syntheticContinueLoopLastWarnAtBySession.set(sessionID, now);
    sessionWarn("compaction:synthetic-continue-loop", {
      sessionID,
      countPerMinute: countInWindow,
    });
    recordPerfLog(sessionDebugEnabled(), "session.compaction", "synthetic-continue-loop-suspected", {
      sessionID,
      countPerMinute: countInWindow,
      threshold: COMPACTION_LOOP_WARN_THRESHOLD,
      windowMs: COMPACTION_DIAGNOSTIC_WINDOW_MS,
    });
  };

  const addError = (error: unknown, fallback = "Unknown error") => {
    const message = error instanceof Error ? error.message : fallback;
    if (!message) return;
    options.setError(addOpencodeCacheHint(message));
  };

  const appendSessionErrorTurn = (
    sessionID: string,
    message: string | null,
    appendOptions?: { durableRunId?: string | null; workspaceId?: string | null },
  ) => {
    const text = message?.trim() ?? "";
    if (!sessionID || !text) return;

    const workspaceId = appendOptions?.workspaceId?.trim() ||
      options.resolveSessionWorkspaceId?.(sessionID)?.trim() ||
      statusWorkspaceId();
    const errorTurnKey = sessionErrorTurnScopeKey(workspaceId, sessionID);
    const list = store.messages[sessionID] ?? [];
    setStore("sessionErrorTurns", errorTurnKey, (current) =>
      appendSessionErrorTurnModel({
        current,
        sessionID,
        message: text,
        messages: list,
        runId: appendOptions?.durableRunId,
      }),
    );
  };

  const sessionErrorTurnsForScope = (sessionID: string | null, workspaceId?: string | null) => {
    const id = sessionID?.trim() ?? "";
    if (!id) return [];
    const resolvedWorkspaceId = workspaceId?.trim() || options.resolveSessionWorkspaceId?.(id)?.trim() || statusWorkspaceId();
    return readSessionErrorTurnsForScope(store.sessionErrorTurns, resolvedWorkspaceId, id);
  };

  const setCommandDisplay = (messageID: string, name: string, args: string) => {
    const trimmedMessageID = messageID.trim();
    const display = formatSlashCommandDisplay(name, args);
    if (!trimmedMessageID || !display) return;
    setStore("commandDisplayByMessageID", trimmedMessageID, display);
  };

  const clearCommandDisplay = (messageID: string) => {
    const trimmedMessageID = messageID.trim();
    if (!trimmedMessageID) return;
    setStore(
      "commandDisplayByMessageID",
      produce((draft: Record<string, string>) => {
        delete draft[trimmedMessageID];
      }),
    );
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number, label: string) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const transcriptController = createSessionTranscriptController({
    store,
    setStore,
    routing: options.routing,
    activeWorkspaceRoot: options.activeWorkspaceRoot,
    applySessionDirectoryOverride,
    resolveSessionDirectory,
    sessionWarn,
    withTimeout,
  });
  const {
    messageLimitBySession,
    setMessageLimitBySession,
    messageCompleteBySession,
    setMessageCompleteBySession,
    messageLoadBusyBySession,
    setMessageLoadBusyBySession,
    transcriptFreshnessBySession,
    setTranscriptFreshnessBySession,
    setMessagesForSession,
    hydrateTranscriptSnapshot,
    hasWarmTranscript,
    getCachedTranscriptMessageCount,
    getCachedTranscriptMessages,
    getTranscriptFreshness,
    resolveTranscriptIngestWorkspaceId,
    resolveSessionIdForMessage,
    recordPendingTranscriptMessageDeletion,
    recordPendingTranscriptPartDeletion,
  } = transcriptController;

  const lifecycleRecoveryController =
    options.resolveConversationRunForSession && options.readConversationRunStatus
      ? createSessionLifecycleRecoveryController({
          sessionStatusById: () => store.sessionStatus,
          selectedSessionId: options.selectedSessionId,
          resolveConversationRunForSession: options.resolveConversationRunForSession,
          readConversationRunStatus: options.readConversationRunStatus,
          recoverAcceptedConversationRunStatus: options.recoverAcceptedConversationRunStatus,
          recoverAcceptedConversationTranscript: options.recoverAcceptedConversationTranscript,
          recoverConversationTranscript: options.recoverConversationTranscript,
          // Terminal recovery has already passed its exact durable run fence;
          // unlike a passive browse snapshot, it is allowed to replace stale
          // live parts with the canonical terminal snapshot.
          hydrateConversationTranscript: (snapshot) =>
            hydrateTranscriptSnapshot(snapshot, { preserveLiveParts: false }),
          diagnosticContext: options.lifecycleRecoveryDiagnosticContext,
          onConversationRunStatus: updateConversationRunDiagnosticsForScope,
          onConversationRunTerminal: (scope, status) => {
            if (status.status !== "failed" || status.stale) return;
            appendSessionErrorTurn(scope.sessionId, status.error?.trim() || "Run failed", {
              durableRunId: scope.runId,
              workspaceId: scope.workspaceId,
            });
          },
          setSessionStatusForWorkspace,
          notifySessionBusy,
          trace: recordSessionLifecycleRecoveryTrace,
        })
      : null;
  observeToolErrorLifecycle = (sessionId, workspaceId) =>
    lifecycleRecoveryController?.observeSessionLifecycleEvent(
      sessionId,
      workspaceId,
      "session.error",
    ) === true;
  if (lifecycleRecoveryController) {
    createEffect(() => {
      lifecycleRecoveryController.reconcile();
    });
    createEffect(() => {
      if (!options.selectedSessionId()) return;
      void lifecycleRecoveryController.probeSelectedConversationLatestRun();
    });
    onCleanup(() => lifecycleRecoveryController.dispose());
  }

  const runtimePrompts = createSessionRuntimePrompts({
    store,
    setStore,
    routing: options.routing,
    selectedSessionId: options.selectedSessionId,
    isWorkspaceRuntimeReady,
    hasAnyRefreshableRuntime,
    activeSendTraceId,
    sessionDebug,
    sessionWarn,
    setError: options.setError,
    addError,
  });
  const {
    pendingPermissions,
    pendingQuestions,
    pendingPermissionsByWs,
    pendingQuestionsByWs,
    allPendingPermissions,
    allPendingQuestions,
    pendingPermissionCountByWs,
    permissionReplyBusy,
    questionReplyBusy,
    activePermission,
    activeQuestion,
    refreshPendingPermissions,
    refreshPendingQuestions,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    setPendingPermissions,
    setPendingQuestions,
  } = runtimePrompts;

  const transcriptObservationVersionBySession = new Map<string, number>();
  const noteTranscriptObserved = (sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    transcriptObservationVersionBySession.set(id, (transcriptObservationVersionBySession.get(id) ?? 0) + 1);
  };

  const selectionController = createSessionSelectionController({
    store,
    setStore,
    routing: options.routing,
    selectedSessionId: options.selectedSessionId,
    setSelectedSessionId: options.setSelectedSessionId,
    selectSessionScopeKey: options.selectSessionScopeKey,
    directoryQueryPathMode: options.directoryQueryPathMode,
    conversationReader: options.conversationReader,
    loadOfflineTranscript: options.loadOfflineTranscript,
    shouldBrowseSessionFromDb: options.shouldBrowseSessionFromDb,
    developerMode: options.developerMode,
    setError: options.setError,
    onSessionLoadComplete: options.onSessionLoadComplete,
    sessionDebug,
    sessionWarn,
    addError,
    withTimeout,
    isWorkspaceRuntimeReady,
    clientForSession,
    sessionReadPolicy,
    isSessionNotFoundError,
    sessionDirectoryOverrides,
    applySessionDirectoryOverride,
    resolveSessionDirectory,
    readStatusForSession,
    workspaceSessionIds,
    setMessagesForSession,
    hydrateTranscriptSnapshot,
    transcriptObservationVersion: (sessionId) => transcriptObservationVersionBySession.get(sessionId.trim()) ?? 0,
    messageLimitBySession,
    setMessageLimitBySession,
    messageCompleteBySession,
    setMessageCompleteBySession,
    messageLoadBusyBySession,
    setMessageLoadBusyBySession,
    refreshPendingPermissions,
  });
  const {
    sessions,
    selectedSession,
    selectedSessionStatus,
    todos,
    selectedSessionHistoryUnavailable,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    loadSessions,
    renameSession,
    selectSession: selectSessionFromController,
    loadEarlierMessages,
  } = selectionController;
  const selectSession = async (sessionId: string) => {
    lifecycleRecoveryController?.resumeExhaustedWatchForSession(sessionId, resolveSessionWorkspaceId(sessionId));
    const result = await selectSessionFromController(sessionId);
    lifecycleRecoveryController?.retryAcceptedRunForSession(sessionId, resolveSessionWorkspaceId(sessionId));
    lifecycleRecoveryController?.retryTerminalTranscriptRecoveryForSession(
      sessionId,
      resolveSessionWorkspaceId(sessionId),
    );
    void lifecycleRecoveryController?.probeSelectedConversationLatestRun();
    return result;
  };
  const sessionStatusById = () => store.sessionStatus;
  const conversationRunDiagnosticsBySessionKey = () => store.conversationRunDiagnosticsBySessionKey;
  const events = () => store.events;

  const messages = createMemo<MessageWithParts[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    const list = store.messages[id] ?? [];
    return list.map((info) => {
      const parts = store.parts[info.id] ?? [];
      const alias = store.commandDisplayByMessageID[info.id];
      return applyCommandDisplayAlias(info, parts, alias);
    });
  });

  const setSessions = (next: Session[]) => {
    setStore("sessions", reconcile(sortSessionsByActivity(next), { key: "id" }));
  };

  const setSessionStatusById = (next: Record<string, string>) => {
    recordSessionStatusTrace("replace-map", {
      previous: store.sessionStatus,
      next,
      previousKeys: Object.keys(store.sessionStatus),
      nextKeys: Object.keys(next),
    });
    setStore("sessionStatus", next);
  };

  const setMessages = (next: MessageWithParts[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setMessagesForSession(id, next);
  };

  const setTodos = (next: TodoItem[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setStore("todos", id, next);
  };

  const eventStreamController = createSessionEventStreamController({
    store,
    setStore,
    routing: options.routing,
    client: options.client,
    activeWorkspaceRoot: options.activeWorkspaceRoot,
    selectedSessionId: options.selectedSessionId,
    developerMode: options.developerMode,
    setError: options.setError,
    setSseConnected: options.setSseConnected,
    onHotReloadApplied: options.onHotReloadApplied,
    onReconnectNotice: options.onReconnectNotice,
    onReconnectState: (state) => {
      options.onReconnectState?.(state);
      if (state.status === "live") {
        lifecycleRecoveryController?.resumeExhaustedWatches(state.workspaceId);
        lifecycleRecoveryController?.resumeAcceptedRunsForWorkspace(state.workspaceId);
        void lifecycleRecoveryController?.probeSelectedConversationLatestRun();
      }
    },
    onAssistantResponseObserved: options.onAssistantResponseObserved,
    onTranscriptObserved: noteTranscriptObserved,
    sessionDebugEnabled,
    sessionWarn,
    recordSessionStatusTrace,
    readStatusForSession,
    setSessionStatusForWorkspace,
    notifySessionBusy,
    workspaceSessionIds,
    applySessionDirectoryOverride,
    resolveSessionDirectory,
    appendSessionErrorTurn,
    onSessionLifecycleObservation: (sessionId, workspaceId, type) =>
      lifecycleRecoveryController?.observeSessionLifecycleEvent(sessionId, workspaceId, type) === true,
    setCommandDisplay,
    recordSyntheticContinueDiagnostic,
    maybeMarkReloadRequired,
    maybeHandleInvalidToolError,
    maybeHandleChromeMcpCompletedError,
    resolveTranscriptIngestWorkspaceId,
    resolveSessionIdForMessage,
    recordPendingTranscriptMessageDeletion,
    recordPendingTranscriptPartDeletion,
    messageLimitBySession,
    setMessagesForSession,
    setMessageLimitBySession,
    setMessageCompleteBySession,
    refreshPendingPermissions,
    refreshPendingQuestions,
    withTimeout,
    isWorkspaceRuntimeReady,
    isActiveWorkspaceRuntimeReady,
    recoverWorkspaceRuntimeForEventStream: options.recoverWorkspaceRuntimeForEventStream,
  });
  eventStreamController.startEventStreams();

  const workspaceCacheController = createSessionWorkspaceCacheController({
    store,
    setStore,
    routing: options.routing,
    selectedSessionId: options.selectedSessionId,
    setSelectedSessionId: options.setSelectedSessionId,
    workspaceSessionIds,
    messageLimitBySession,
    setMessageLimitBySession,
    messageCompleteBySession,
    setMessageCompleteBySession,
    setMessageLoadBusyBySession,
    transcriptFreshnessBySession,
    setTranscriptFreshnessBySession,
  });
  const {
    saveWorkspaceSnapshot,
    loadWorkspaceSnapshot,
    clearWorkspaceSnapshot,
  } = workspaceCacheController;

  const selectedSessionErrorTurns = createMemo(() => {
    const sessionID = options.selectedSessionId();
    return sessionErrorTurnsForScope(sessionID);
  });

  return {
    sessions,
    sessionErrorTurnsById: (sessionID: string | null) => sessionErrorTurnsForScope(sessionID),
    selectedSessionErrorTurns,
    sessionStatusById,
    conversationRunDiagnosticsBySessionKey,
    selectedSession,
    selectedSessionStatus,
    messages,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    appendSessionErrorTurn,
    setCommandDisplay,
    clearCommandDisplay,
    setSessions,
    setSessionStatusById,
    admitAcceptedConversationRun: lifecycleRecoveryController?.admitAcceptedConversationRun ?? (() => false),
    retryAcceptedRunForSession: lifecycleRecoveryController?.retryAcceptedRunForSession ?? (() => 0),
    retryTerminalTranscriptRecoveryForSession:
      lifecycleRecoveryController?.retryTerminalTranscriptRecoveryForSession ?? (() => 0),
    setMessages,
    setTodos,
    setPendingPermissions,
    setPendingQuestions,
    selectedSessionHistoryUnavailable,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    hydrateTranscriptSnapshot,
    hasWarmTranscript,
    getCachedTranscriptMessageCount,
    getCachedTranscriptMessages,
    getTranscriptFreshness,
    saveWorkspaceSnapshot,
    loadWorkspaceSnapshot,
    clearWorkspaceSnapshot,
    allPendingPermissions,
    allPendingQuestions,
    pendingPermissionCountByWs,
    pendingPermissionsByWs,
    pendingQuestionsByWs,
  };
}
