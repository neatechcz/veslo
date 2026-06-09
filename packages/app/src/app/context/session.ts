import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
  PlaceholderAssistantMessage,
  ReloadReason,
  ReloadTrigger,
  SessionErrorTurn,
  TodoItem,
} from "../types";
import {
  addOpencodeCacheHint,
  extractSessionId,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
  normalizeEvent,
  normalizeSessionStatus,
  sessionDirectoryMatchesRoot,
  safeStringify,
} from "../utils";
import { unwrap } from "../lib/opencode";
import { engineSseSubscribe, isEngineSseAvailable } from "../lib/engine-sse";
import type { WorkspaceRouting, RoutingClient } from "./workspace-routing";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { formatSessionError, truncateErrorField } from "../lib/session-error";
import { detectChromeMcpCompletedError } from "../lib/chrome-mcp-error";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../types";
import { createSelectSessionGuard } from "./select-session-guard";
import {
  beginOutageEpisode,
  clearOutageEpisode,
  type ReconnectNotice,
  shouldShowReconnected,
  shouldShowReconnecting,
} from "./session-reconnect";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";

export type SessionStore = ReturnType<typeof createSessionStore>;

type SessionStatusTraceRoot = typeof window & {
  __vesloSessionStatusTrace?: Array<Record<string, unknown>>;
  __vesloSessionStatusSnapshot?: Record<string, string>;
};

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

type TranscriptFreshness = {
  fetchedAt: number | null;
  staleAt: number | null;
};

type StoreState = {
  sessions: Session[];
  sessionStatus: Record<string, string>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  commandDisplayByMessageID: Record<string, string>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  events: OpencodeEvent[];
};

/**
 * VSLO-171 F3Ú6a — per-workspace snapshot of session state cached when the
 * user switches away from a workspace, restored when they come back.
 * Only multi-routing mode populates this; single-active keeps the global
 * store as the single source of truth.
 */
export type WorkspaceSessionCache = {
  workspaceId: string;
  sessions: Session[];
  sessionStatus: Record<string, string>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  selectedSessionId: string | null;
  lastUsed: number;
};

const sortById = <T extends { id: string }>(list: T[]) =>
  list.slice().sort((a, b) => a.id.localeCompare(b.id));

const sessionActivity = (session: Session) =>
  session.time?.updated ?? session.time?.created ?? 0;

const sortSessionsByActivity = (list: Session[]) =>
  list
    .slice()
    .sort((a, b) => {
      const delta = sessionActivity(b) - sessionActivity(a);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

const SYNTHETIC_CONTINUE_CONTROL_PATTERN =
  /^\s*continue if you have next steps,\s*or stop and ask for clarification if you are unsure how to proceed\.?\s*$/i;
const COMPACTION_DIAGNOSTIC_WINDOW_MS = 60_000;
const COMPACTION_LOOP_WARN_THRESHOLD = 3;
const COMPACTION_LOOP_WARN_MIN_INTERVAL_MS = 10_000;
const INITIAL_SESSION_MESSAGE_LIMIT = 140;
const SESSION_MESSAGE_LOAD_CHUNK = 120;

const formatSlashCommandDisplay = (name: string, args: string) => {
  const cleanName = name.trim().replace(/^\/+/, "");
  if (!cleanName) return "";
  const cleanArgs = args.trim();
  return cleanArgs ? `/${cleanName} ${cleanArgs}` : `/${cleanName}`;
};

const createPlaceholderMessage = (part: Part): PlaceholderAssistantMessage => ({
  id: part.messageID,
  sessionID: part.sessionID,
  role: "assistant",
  time: { created: Date.now() },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const upsertSession = (list: Session[], next: Session) => {
  const index = list.findIndex((session) => session.id === next.id);
  if (index === -1) return sortSessionsByActivity([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return sortSessionsByActivity(copy);
};

const removeSession = (list: Session[], sessionID: string) => list.filter((session) => session.id !== sessionID);

const upsertMessageInfo = (list: MessageInfo[], next: MessageInfo) => {
  const index = list.findIndex((message) => message.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

const removeMessageInfo = (list: MessageInfo[], messageID: string) =>
  list.filter((message) => message.id !== messageID);

const upsertPartInfo = (list: Part[], next: Part) => {
  const index = list.findIndex((part) => part.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

const removePartInfo = (list: Part[], partID: string) => list.filter((part) => part.id !== partID);

export function createSessionStore(options: {
  client: () => Client | null;
  // VSLO-171 F3Ú4 — workspace routing service. Prefer
  // `options.routing.active()` over `options.client()` for new code.
  routing: WorkspaceRouting;
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionDirectoryOverrideById?: () => Record<string, string>;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  onReconnectNotice?: (notice: ReconnectNotice) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onHotReloadApplied?: () => void;
  onSessionLoadComplete?: () => void;
  loadOfflineTranscript?: (sessionID: string, limit: number) => Promise<VesloSessionTranscriptSnapshot | null>;
  conversationReader?: () => {
    listConversations: (
      workspaceId: string,
      directory?: string,
    ) => Promise<{ items: Session[]; source?: "sqlite" | "unavailable" }>;
  } | null;
  /**
   * VSLO-86 — `engineReady()` reports whether the user has explicitly brought
   * up the engine for the active workspace (sendPrompt has succeeded at least
   * once). When false, selectSession prefers the offline transcript over an
   * SDK `session.messages` call so that just clicking through session history
   * never accidentally cold-spawns sandbox-exec + opencode serve.
   */
  engineReady?: () => boolean;
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
    sessionErrorTurns: {},
    messages: {},
    parts: {},
    commandDisplayByMessageID: {},
    todos: {},
    pendingPermissions: [],
    pendingQuestions: [],
    events: [],
  });
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);
  const [messageLimitBySession, setMessageLimitBySession] = createSignal<Record<string, number>>({});
  const [messageCompleteBySession, setMessageCompleteBySession] = createSignal<Record<string, boolean>>({});
  const [messageLoadBusyBySession, setMessageLoadBusyBySession] = createSignal<Record<string, boolean>>({});
  const [transcriptFreshnessBySession, setTranscriptFreshnessBySession] = createSignal<
    Record<string, TranscriptFreshness>
  >({});
  const reloadDetectionSet = new Set<string>();
  const invalidToolDetectionSet = new Set<string>();
  const chromeMcpFailureDetectionSet = new Set<string>();
  const syntheticContinueEventTimesBySession = new Map<string, number[]>();
  const syntheticContinueLoopLastWarnAtBySession = new Map<string, number>();
  const workspaceSessionIds = new Set<string>();
  // VSLO-171 F3Ú6a — per-workspace cache for save/load on workspace switch.
  // Only populated in multi-routing mode (caller decides via options.routing.mode()).
  const perWorkspaceCache = new Map<string, WorkspaceSessionCache>();
  // VSLO-171 F3Ú7a — per-workspace pending permissions. In multi mode the
  // polling effect (in app.tsx) iterates routing.forEach() and refreshes each
  // workspace's permissions independently. Sidebar badge reads aggregate
  // counts via pendingPermissionCountByWs memo.
  const [pendingPermissionsByWs, setPendingPermissionsByWs] = createSignal<
    Record<string, PendingPermission[]>
  >({});
  let pendingPermissionsRefreshInFlight: Promise<void> | null = null;

  // VSLO-171 — flattened view of all per-workspace permissions for the
  // cross-workspace UI (sidebar badges, activePermission fallback).
  // Declared near the signal so callers (activePermission memo, respondPermission)
  // can reference it without TDZ at createSessionStore init.
  const allPendingPermissions = createMemo(() => {
    const byWs = pendingPermissionsByWs();
    const result: PendingPermission[] = [];
    for (const list of Object.values(byWs)) result.push(...list);
    return result;
  });
  const pendingPermissionCountByWs = createMemo(() => {
    const byWs = pendingPermissionsByWs();
    const counts: Record<string, number> = {};
    for (const [wsId, list] of Object.entries(byWs)) counts[wsId] = list.length;
    return counts;
  });

  const skillPathPattern = /[\\/]\.opencode[\\/](skill|skills)[\\/]/i;
  const skillNamePattern = /[\\/]\.opencode[\\/](?:skill|skills)[\\/]+([^\\/]+)/i;
  const commandPathPattern = /[\\/]\.opencode[\\/](command|commands)[\\/]/i;
  const commandNamePattern = /[\\/]\.opencode[\\/](?:command|commands)[\\/]+([^\\/]+)/i;
  const agentPathPattern = /[\\/]\.opencode[\\/](agent|agents)[\\/]/i;
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
    const record = part as any;
    const state = (record.state ?? {}) as Record<string, unknown>;
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
    const record = part as any;
    const name = typeof record.tool === "string" ? record.tool : "";
    const lower = name.toLowerCase();
    if (lower.includes("browser") || lower.includes("chrome") || lower.includes("devtools")) {
      return __vesloIndirectT("ui.indirect.chrome_mcp_is_not_ready_yet_open_the_mcp_tab_c_r0vewj", __vesloIndirectLocale());
    }
    return __vesloIndirectT("ui.indirect.try_again_or_switch_to_an_agent_prompt_that_on_1x3e0z", __vesloIndirectLocale());
  };

  const maybeHandleInvalidToolError = (part: Part) => {
    if (!options.setError) return;
    if (!isInvalidToolError(part)) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (invalidToolDetectionSet.has(key)) return;
    invalidToolDetectionSet.add(key);

    // Ensure the UI doesn't get stuck in a "Responding" state when the model
    // tries to call a tool that isn't available.
    if (part.sessionID) {
      setStore("sessionStatus", part.sessionID, "idle");
      notifySessionBusy(part.sessionID, "idle");
    }

    const record = part as any;
    const tool = typeof record.tool === "string" && record.tool.trim() ? record.tool.trim() : __vesloIndirectT("ui.indirect.unknown_tool_8c32ki", __vesloIndirectLocale());
    const hint = invalidToolNextStepHint(part);
    options.setError(`Invalid tool call: ${tool}.\n\n${hint}`);
  };

  const maybeHandleChromeMcpCompletedError = (part: Part) => {
    if (!options.setError) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (chromeMcpFailureDetectionSet.has(key)) return;

    const detected = detectChromeMcpCompletedError(part);
    if (!detected) return;

    chromeMcpFailureDetectionSet.add(key);

    // Keep run state consistent with a surfaced execution failure.
    if (part.sessionID) {
      setStore("sessionStatus", part.sessionID, "idle");
      notifySessionBusy(part.sessionID, "idle");
      appendSessionErrorTurn(part.sessionID, addOpencodeCacheHint(detected));
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

  const appendSessionErrorTurn = (sessionID: string, message: string | null) => {
    const text = message?.trim() ?? "";
    if (!sessionID || !text) return;

    const list = store.messages[sessionID] ?? [];
    const lastMessage = list.length > 0 ? list[list.length - 1] : null;
    const afterMessageID = lastMessage?.id ?? null;

    setStore("sessionErrorTurns", sessionID, (current) => {
      const existing = current ?? [];
      const previous = existing[existing.length - 1];
      if (previous && previous.text === text && previous.afterMessageID === afterMessageID) {
        return existing;
      }

      return existing.concat({
        id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${sessionID}:${Date.now()}:${existing.length}`,
        text,
        afterMessageID,
        time: Date.now(),
      });
    });
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

  let selectRunCounter = 0;
  const selectGuard = createSelectSessionGuard();

  const sessions = () => store.sessions;
  const sessionStatusById = () => store.sessionStatus;
  const pendingPermissions = () => store.pendingPermissions;
  const pendingQuestions = () => store.pendingQuestions;
  const events = () => store.events;

  const selectedSession = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    return store.sessions.find((session) => session.id === id) ?? null;
  });

  const selectedSessionStatus = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return "idle";
    return store.sessionStatus[id] ?? "idle";
  });

  const messages = createMemo<MessageWithParts[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    const list = store.messages[id] ?? [];
    return list.map((info) => {
      const parts = store.parts[info.id] ?? [];
      const alias = store.commandDisplayByMessageID[info.id];
      if (!alias || (info as { role?: string }).role !== "user") {
        return { info, parts };
      }

      const firstText = parts.find((part) => part.type === "text");
      const aliasPart = firstText
        ? ({ ...firstText, text: alias, synthetic: false, ignored: false } as Part)
        : ({
            id: `command-display:${info.id}`,
            sessionID: info.sessionID,
            messageID: info.id,
            type: "text",
            text: alias,
            synthetic: false,
            ignored: false,
          } as Part);
      const nonTextParts = parts.filter((part) => part.type !== "text");
      return { info, parts: [aliasPart, ...nonTextParts] };
    });
  });

  const todos = createMemo<TodoItem[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    return store.todos[id] ?? [];
  });

  const selectedSessionHasEarlierMessages = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return false;
    return !messageCompleteBySession()[id];
  });

  const selectedSessionLoadingEarlierMessages = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return false;
    return Boolean(messageLoadBusyBySession()[id]);
  });

  async function loadSessions(scopeRoot?: string) {
    // IMPORTANT: OpenCode's session.list() supports server-side filtering by directory.
    // Use it to avoid fetching every session across every workspace root.
    //
    // Note: We intentionally normalize slashes + trailing separators but do NOT
    // lowercase on Windows for the query value because the server does strict
    // string equality against the stored session.directory.
    const queryDirectory = normalizeDirectoryQueryPath(scopeRoot) || undefined;

    const start = Date.now();
    sessionDebug("sessions:load:start", { scopeRoot: scopeRoot ?? null, queryDirectory: queryDirectory ?? null });
    let list: Session[] | null = null;
    let usedConversationRead = false;
    const workspaceId = options.routing.activeWorkspaceId().trim();
    const c = options.routing.active();
    const reader = options.conversationReader?.() ?? null;
    if (workspaceId && reader) {
      try {
        const result = await reader.listConversations(workspaceId, queryDirectory);
        if (result.source !== "unavailable" || options.engineReady?.() === false || !c) {
          list = result.items;
          usedConversationRead = true;
          sessionDebug("sessions:load:conversation-read", {
            workspaceId,
            source: result.source ?? "unknown",
            count: list.length,
            ms: Date.now() - start,
          });
        } else {
          sessionDebug("sessions:load:conversation-read-unavailable-fallback", {
            workspaceId,
            ms: Date.now() - start,
          });
        }
      } catch (error) {
        sessionDebug("sessions:load:conversation-read-failed", {
          workspaceId,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (options.engineReady?.() === false || !c) {
          list = [];
          usedConversationRead = true;
        }
      }
    }

    if (!list) {
      if (!c) return;
      // Keep `roots` unset so the backend returns both root sessions and child/subagent sessions.
      list = unwrap(await c.session.list({ directory: queryDirectory }));
      sessionDebug("sessions:load:raw", { count: list.length, ms: Date.now() - start });
    }

    // Defensive client-side filter in case the server returns sessions spanning
    // multiple roots (e.g. older servers or proxies).
    const root = normalizeDirectoryPath(scopeRoot);
    const filtered = root
      ? list
        .map((session) => applySessionDirectoryOverride(session))
        .filter((session) => sessionDirectoryMatchesRoot(resolveSessionDirectory(session), root))
      : list.map((session) => applySessionDirectoryOverride(session));

    const overrideIds = root
      ? Object.entries(sessionDirectoryOverrides())
        .filter(([, directory]) => normalizeDirectoryPath(directory) === root)
        .map(([sessionID]) => sessionID)
      : [];

    const merged = new Map(filtered.map((session) => [session.id, session] as const));
    for (const sessionID of overrideIds) {
      if (merged.has(sessionID)) continue;
      if (usedConversationRead || !c) continue;
      try {
        // Fetch by ID without directory filter — the session may still be
        // registered under the old directory in the engine while the local
        // override already points to the new workspace root.
        const fetched = unwrap(await c.session.get({ sessionID }));
        merged.set(sessionID, applySessionDirectoryOverride(fetched));
      } catch {
        // ignore stale local overrides; delete path is handled by app state
      }
    }

    const nextSessions = sortSessionsByActivity(Array.from(merged.values()));
    sessionDebug("sessions:load:filtered", { root: root || null, count: nextSessions.length });

    // Rebuild the workspace session ID set so SSE event filtering stays in sync.
    workspaceSessionIds.clear();
    for (const session of nextSessions) {
      workspaceSessionIds.add(session.id);
    }

    setStore("sessions", reconcile(nextSessions, { key: "id" }));
  }

  async function renameSession(sessionID: string, title: string) {
    const c = options.routing.active();
    if (!c) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    const next = applySessionDirectoryOverride(unwrap(await c.session.update({ sessionID, title: trimmed })));
    setStore("sessions", (current) => upsertSession(current, next));
  }

  async function refreshPendingPermissions() {
    if (options.engineReady && !options.engineReady()) {
      sessionDebug("permissions:skip-engine-not-ready", {
        activeWorkspaceId: options.routing.activeWorkspaceId() || null,
      });
      return;
    }
    if (pendingPermissionsRefreshInFlight) {
      sessionDebug("permissions:skip-in-flight", {
        activeWorkspaceId: options.routing.activeWorkspaceId() || null,
      });
      return;
    }

    const run = (async () => {
      // VSLO-171 — iterate every per-workspace client and refresh each
      // workspace's permissions independently. The active workspace's list is
      // also mirrored into the global store so callers that read
      // store.pendingPermissions directly (Dialog, activePermission memo) keep
      // working.
      const activeWs = options.routing.activeWorkspaceId();
      const nextByWs: Record<string, PendingPermission[]> = {};
      const now = Date.now();
      const prevByWs = pendingPermissionsByWs();
      const clientsToProbe: Array<{ wsId: string; client: RoutingClient }> = [];
      options.routing.forEach((wsId, client) => {
        clientsToProbe.push({ wsId, client });
      });
      // If no per-WS clients have been ensured yet, fall back to the global
      // active client so the very first prompt still surfaces permissions.
      if (clientsToProbe.length === 0) {
        const c = options.routing.active();
        if (!c) return;
        const list = unwrap(await c.permission.list()) as Array<PendingPermission>;
        const byId = new Map(store.pendingPermissions.map((p) => [p.id, p] as const));
        const next = list.map((perm) => ({
          ...perm,
          workspaceId: activeWs || undefined,
          receivedAt: byId.get(perm.id)?.receivedAt ?? now,
        }));
        setStore("pendingPermissions", next);
        if (activeWs) setPendingPermissionsByWs({ [activeWs]: next });
        return;
      }
      await Promise.all(
        clientsToProbe.map(async ({ wsId, client }) => {
          try {
            const list = unwrap(await client.permission.list()) as Array<PendingPermission>;
            const prev = prevByWs[wsId] ?? [];
            const byId = new Map(prev.map((p) => [p.id, p] as const));
            nextByWs[wsId] = list.map((perm) => ({
              ...perm,
              workspaceId: wsId,
              receivedAt: byId.get(perm.id)?.receivedAt ?? now,
            }));
          } catch {
            nextByWs[wsId] = prevByWs[wsId] ?? [];
          }
        }),
      );
      setPendingPermissionsByWs(nextByWs);
      const activeList = activeWs ? nextByWs[activeWs] ?? [] : [];
      setStore("pendingPermissions", activeList);
    })();

    pendingPermissionsRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (pendingPermissionsRefreshInFlight === run) {
        pendingPermissionsRefreshInFlight = null;
      }
    }
  }

  async function refreshPendingQuestions() {
    const c = options.routing.active();
    if (!c) return;
    const list = unwrap(await c.question.list());
    const now = Date.now();
    const byId = new Map(store.pendingQuestions.map((q) => [q.id, q] as const));
    const next = list.map((q) => ({ ...q, receivedAt: byId.get(q.id)?.receivedAt ?? now }));
    setStore("pendingQuestions", next);
  }

  function setMessagesForSession(sessionID: string, list: MessageWithParts[]) {
    const infos = list
      .map((msg) => msg.info)
      .filter((info) => !!info?.id)
      .map((info) => info as MessageInfo);

    batch(() => {
      setStore("messages", sessionID, reconcile(sortById(infos), { key: "id" }));
      for (const message of list) {
        const parts = message.parts.filter((part) => !!part?.id);
        setStore("parts", message.info.id, reconcile(sortById(parts), { key: "id" }));
      }
    });
  }

  function hydrateTranscriptSnapshot(snapshot: VesloSessionTranscriptSnapshot) {
    if (snapshot.source === "unavailable") return;

    const sessionID = snapshot.sessionId.trim();
    if (!sessionID) return;

    const nextFetchedAt = typeof snapshot.fetchedAt === "number" ? snapshot.fetchedAt : null;
    const currentFreshness = transcriptFreshnessBySession()[sessionID];
    if (
      currentFreshness?.fetchedAt != null &&
      nextFetchedAt != null &&
      nextFetchedAt < currentFreshness.fetchedAt
    ) {
      return;
    }

    const nextMessages: MessageWithParts[] = snapshot.messages
      .filter((info): info is MessageInfo => Boolean(info?.id))
      .map((info) => ({
        info,
        parts: sortById((snapshot.partsByMessageId[info.id] ?? []).filter((part): part is Part => Boolean(part?.id))),
      }));
    const existingMessageCount = getCachedTranscriptMessageCount(sessionID);

    batch(() => {
      setTranscriptFreshnessBySession((current) => ({
        ...current,
        [sessionID]: {
          fetchedAt: nextFetchedAt,
          staleAt: typeof snapshot.staleAt === "number" ? snapshot.staleAt : null,
        },
      }));

      if (existingMessageCount > nextMessages.length) return;

      setMessagesForSession(sessionID, nextMessages);

      const requestedLimit = Math.max(snapshot.limit || 0, nextMessages.length);
      const currentLimit = messageLimitBySession()[sessionID] ?? 0;
      const effectiveLimit = Math.max(requestedLimit, currentLimit);
      setMessageLimitBySession((current) => ({
        ...current,
        [sessionID]: effectiveLimit,
      }));
      setMessageCompleteBySession((current) => ({
        ...current,
        [sessionID]: nextMessages.length < effectiveLimit,
      }));
    });
  }

  function hasWarmTranscript(sessionID: string) {
    return (store.messages[sessionID] ?? []).length > 0;
  }

  function getCachedTranscriptMessageCount(sessionID: string) {
    return (store.messages[sessionID] ?? []).length;
  }

  function getTranscriptFreshness(sessionID: string) {
    return transcriptFreshnessBySession()[sessionID] ?? null;
  }

  async function selectSession(sessionID: string) {
    const c = options.routing.active();

    const perfEnabled = options.developerMode();
    options.setSelectedSessionId(sessionID);
    options.setError(null);

    const existing = selectGuard.tryDedup(sessionID);
    if (existing) {
      recordPerfLog(perfEnabled, "session.select", "dedupe join", {
        sessionID,
      });
      return existing;
    }

    const runId = ++selectRunCounter;
    const version = selectGuard.nextVersion();
    const startedAt = perfNow();
    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.select", event, {
        runId,
        sessionID,
        elapsedMs,
        ...(payload ?? {}),
      });
    };
    const isStale = () => version !== selectGuard.currentVersion() || options.selectedSessionId() !== sessionID;
    const abortIfStale = (reason: string) => {
      if (!isStale()) return false;
      mark(`aborting: ${reason}`);
      return true;
    };

    const run = (async () => {
      mark("start");

      const existingLimit = messageLimitBySession()[sessionID] ?? 0;
      const requestLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, existingLimit);
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: true }));
      const browseModeOnly = options.engineReady ? !options.engineReady() : false;
      const browseFromDb = options.shouldBrowseSessionFromDb?.(sessionID) ?? browseModeOnly;
      mark("client check", { hasClient: Boolean(c), browseModeOnly, browseFromDb, sessionID });
      // VSLO-86 — in browse mode (engineReady=false), the user hasn't asked
      // for the engine yet. Hitting `c.session.messages` here would force a
      // 30-60s sandbox-exec cold spawn just so we could pull the same
      // messages already cached locally. Fall through to the offline
      // transcript instead so passive sidebar clicking stays free.
      if (!c || browseFromDb) {
        try {
          mark("calling offline transcript fallback", { limit: requestLimit });
          let snapshot: VesloSessionTranscriptSnapshot | null = null;
          try {
            snapshot = (await options.loadOfflineTranscript?.(sessionID, requestLimit)) ?? null;
          } catch (error) {
            addError(error);
            mark("offline transcript fallback failed", {
              error: error instanceof Error ? error.message : safeStringify(error),
            });
            return;
          }
          if (abortIfStale("selection changed before offline transcript applied")) return;
          if (snapshot) {
            hydrateTranscriptSnapshot(snapshot);
            setStore("todos", sessionID, []);
            mark("offline transcript fallback done", {
              count: snapshot.messages.length,
              limit: requestLimit,
            });
          } else {
            mark("offline transcript fallback unavailable");
          }
        } finally {
          setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
        }
        return;
      }
      mark("calling session.messages", { limit: requestLimit });
      const msgs = unwrap(
        await withTimeout(c.session.messages({ sessionID, limit: requestLimit }), 12000, "session.messages"),
      );
      mark("session.messages done", { limit: requestLimit, count: msgs.length });
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
      if (abortIfStale("selection changed before messages applied")) return;
      setMessagesForSession(sessionID, msgs);
      setMessageLimitBySession((prev) => ({ ...prev, [sessionID]: requestLimit }));
      setMessageCompleteBySession((prev) => ({ ...prev, [sessionID]: msgs.length < requestLimit }));

      finishPerf(perfEnabled, "session.select", "complete", startedAt, {
        runId,
        sessionID,
        messageCount: msgs.length,
        todoCount: (store.todos[sessionID] ?? []).length,
      });
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));

      void (async () => {
        try {
          mark("calling session.todo");
          const list = unwrap(await withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
          mark("session.todo done");
          if (abortIfStale("selection changed before todos applied")) return;
          setStore("todos", sessionID, list);
        } catch (error) {
          mark("session.todo failed/timeout", {
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          if (abortIfStale("selection changed before todo fallback")) return;
          setStore("todos", sessionID, []);
        }

        try {
          mark("calling permission.list");
          await withTimeout(refreshPendingPermissions(), 6000, "permission.list");
          mark("permission.list done");
          if (abortIfStale("selection changed before permissions applied")) return;
        } catch (error) {
          mark("permission.list failed/timeout", {
            error: error instanceof Error ? error.message : safeStringify(error),
          });
        }
      })();
    })();

    selectGuard.register(sessionID, version, run);
    try {
      await run;
    } finally {
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
      selectGuard.cleanup(sessionID, run);
      options.onSessionLoadComplete?.();
    }
  }

  async function loadEarlierMessages(sessionID: string, chunk = SESSION_MESSAGE_LOAD_CHUNK) {
    const c = options.routing.active();
    if (!sessionID) return;
    if (messageLoadBusyBySession()[sessionID]) return;
    if (messageCompleteBySession()[sessionID]) return;

    const currentLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
    const nextLimit = currentLimit + Math.max(1, chunk);

    setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: true }));
    try {
      const browseFromDb = options.shouldBrowseSessionFromDb?.(sessionID) ?? false;
      if (!c || browseFromDb) {
        const snapshot = (await options.loadOfflineTranscript?.(sessionID, nextLimit)) ?? null;
        if (snapshot) hydrateTranscriptSnapshot(snapshot);
        return;
      }
      const msgs = unwrap(await withTimeout(c.session.messages({ sessionID, limit: nextLimit }), 12000, "session.messages"));
      setMessagesForSession(sessionID, msgs);
      setMessageLimitBySession((prev) => ({ ...prev, [sessionID]: nextLimit }));
      setMessageCompleteBySession((prev) => ({ ...prev, [sessionID]: msgs.length < nextLimit }));
    } catch (error) {
      addError(error);
    } finally {
      setMessageLoadBusyBySession((prev) => ({ ...prev, [sessionID]: false }));
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    // VSLO-171 F3Ú7b — route the reply to the per-workspace client that owns
    // this permission. Falls back to active() if the permission has no
    // workspaceId (single-active mode or pre-F3Ú7a state).
    const perm = allPendingPermissions().find((p) => p.id === requestID)
      ?? store.pendingPermissions.find((p) => p.id === requestID);
    const c = perm?.workspaceId
      ? options.routing.client(perm.workspaceId) ?? options.routing.active()
      : options.routing.active();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions();
    } catch (e) {
      addError(e);
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  async function respondQuestion(requestID: string, answers: string[][]) {
    const c = options.routing.active();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reply({ requestID, answers }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  async function rejectQuestion(requestID: string) {
    const c = options.routing.active();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reject({ requestID }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

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

  const setPendingPermissions = (next: PendingPermission[]) => {
    setStore("pendingPermissions", next);
  };

  const setPendingQuestions = (next: PendingQuestion[]) => {
    setStore("pendingQuestions", next);
  };

  const activePermission = createMemo(() => {
    const id = options.selectedSessionId();
    if (id) {
      const scoped = store.pendingPermissions.find((perm) => perm.sessionID === id) ?? null;
      if (scoped) return scoped;
    }
    // VSLO-171 — surface permissions from any workspace, preferring the
    // active one so the dialog isn't surprising. Falls back to global store
    // when no per-WS entries exist yet (first prompt).
    const all = allPendingPermissions();
    if (all.length > 0) {
      const activeWsId = options.routing.activeWorkspaceId();
      const fromActive = all.find((p) => p.workspaceId === activeWsId);
      return fromActive ?? all[0];
    }
    return store.pendingPermissions[0] ?? null;
  });

  const activeQuestion = createMemo(() => {
    const id = options.selectedSessionId();
    if (id) {
      const scoped = store.pendingQuestions.find((q) => q.sessionID === id) ?? null;
      if (scoped) return scoped;
    }
    return store.pendingQuestions[0] ?? null;
  });

  const [questionReplyBusy, setQuestionReplyBusy] = createSignal(false);
  let lastPartDebugEventAt = 0;
  let suppressedPartDebugEvents = 0;

  const appendDebugEvent = (event: { type: string; properties?: unknown }) => {
    setStore("events", (current) => {
      const next = [event, ...current];
      return next.slice(0, 150);
    });
  };

  const compactDebugEvent = (event: OpencodeEvent) => {
    if (event.type === "message.part.updated") {
      const record = event.properties as Record<string, unknown> | undefined;
      const part = record?.part as Part | undefined;
      const delta = typeof record?.delta === "string" ? record.delta : "";
      const textLength =
        part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
          ? String((part as { text?: string }).text).length
          : null;
      return {
        type: event.type,
        properties: {
          sessionID: part?.sessionID ?? null,
          messageID: part?.messageID ?? null,
          partID: part?.id ?? null,
          partType: part?.type ?? null,
          deltaLength: delta.length,
          textLength,
        },
      };
    }

    return {
      type: event.type,
      properties: event.properties,
    };
  };

  // Track session IDs that belong to the current workspace so we can
  // reject SSE events for sessions from other workspaces. Populated by
  // loadSessions() and session creation; cleared on workspace switch
  // (when the client changes and the SSE subscription reconnects).
  const isKnownSessionId = (sessionID: string): boolean => {
    if (workspaceSessionIds.has(sessionID)) return true;
    // Also accept if the session is already in the store (e.g. just created)
    if (store.sessions.some((s) => s.id === sessionID)) {
      workspaceSessionIds.add(sessionID);
      return true;
    }
    // The currently-selected session is the user's active context. Accept
    // its events even if workspaceSessionIds is briefly out of sync — for
    // example right after an engine reload, when the SSE reconnect clears
    // workspaceSessionIds before loadSessions() repopulates it. Without
    // this, session.status / session.idle events get dropped and the run
    // indicator hangs at "thinking" forever.
    if (sessionID === options.selectedSessionId()) {
      workspaceSessionIds.add(sessionID);
      return true;
    }
    return false;
  };

  const notifyBackgroundSessionBusy = (event: OpencodeEvent, workspaceId: string) => {
    if (!workspaceId || !event.properties || typeof event.properties !== "object") return;
    const record = event.properties as Record<string, unknown>;
    const sessionID = extractSessionId(record);
    if (!sessionID) return;
    if (event.type === "session.status") {
      notifySessionBusy(sessionID, normalizeSessionStatus(record.status), workspaceId);
      return;
    }
    if (event.type === "session.idle" || event.type === "session.error") {
      notifySessionBusy(sessionID, "idle", workspaceId);
    }
  };

  const applyEvent = async (event: OpencodeEvent, sourceWsId: string = "") => {
    // VSLO-86 F4Ú12 — SSE multiplex: each per-workspace stream tags events
    // with its source workspace id. Background workspaces (source !== active)
    // skip mutation of the single active-workspace store. The "" source is
    // the legacy fallback stream (no per-WS routing entries yet) and behaves
    // like the global stream did before multiplex.
    if (sourceWsId) {
      const activeWsId = options.routing.activeWorkspaceId();
      if (activeWsId && sourceWsId !== activeWsId) {
        // Background event for a non-active workspace. Keep the workspace-level
        // run indicator current, but skip the single active-session store. When
        // the user switches back, loadSessions() re-fetches the full state.
        notifyBackgroundSessionBusy(event, sourceWsId);
        return;
      }
    }

    if (event.type === "server.connected") {
      options.setSseConnected(true);
    }

    if (options.developerMode()) {
      const compact = compactDebugEvent(event);
      if (event.type === "message.part.updated") {
        const now = Date.now();
        if (now - lastPartDebugEventAt < 250) {
          suppressedPartDebugEvents += 1;
        } else {
          lastPartDebugEventAt = now;
          if (suppressedPartDebugEvents > 0) {
            compact.properties = {
              ...(compact.properties ?? {}),
              suppressed: suppressedPartDebugEvents,
            };
            suppressedPartDebugEvents = 0;
          }
          appendDebugEvent(compact);
        }
      } else {
        if (suppressedPartDebugEvents > 0) {
          appendDebugEvent({
            type: "message.part.updated.sample",
            properties: { suppressed: suppressedPartDebugEvents },
          });
          suppressedPartDebugEvents = 0;
        }
        appendDebugEvent(compact);
      }
    }

    if (event.type === "session.updated" || event.type === "session.created") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = applySessionDirectoryOverride(record.info as Session);
          // Validate that the session's directory belongs to the active workspace
          // before accepting it into the store.
          const root = normalizeDirectoryPath(options.activeWorkspaceRoot());
          const sessionDir = resolveSessionDirectory(info);
          if (root && sessionDir && !sessionDirectoryMatchesRoot(sessionDir, root)) {
            sessionWarn("session.updated:ignored:wrong-workspace", {
              sessionID: info.id,
              sessionDir,
              activeRoot: root,
            });
            return;
          }
          workspaceSessionIds.add(info.id);
          setStore("sessions", (current) => upsertSession(current, info));
        }
      }
    }

    if (event.type === "session.deleted") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const info = record.info as Session | undefined;
        if (info?.id) {
          const removedMessageIDs = (store.messages[info.id] ?? []).map((message) => message.id);
          syntheticContinueEventTimesBySession.delete(info.id);
          syntheticContinueLoopLastWarnAtBySession.delete(info.id);
          setStore("sessions", (current) => removeSession(current, info.id));
          if (removedMessageIDs.length > 0) {
            setStore(
              "commandDisplayByMessageID",
              produce((draft: Record<string, string>) => {
                removedMessageIDs.forEach((messageID) => {
                  delete draft[messageID];
                });
              }),
            );
          }
          setStore(
            produce((draft: StoreState) => {
              delete draft.sessionErrorTurns[info.id];
            }),
          );
        }
      }
    }

    if (event.type === "session.status") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && isKnownSessionId(sessionID)) {
          const normalized = normalizeSessionStatus(record.status);
          recordSessionStatusTrace("sse-session-status", {
            sessionId: sessionID,
            status: normalized,
            sourceWorkspaceId: sourceWsId ?? null,
            previous: store.sessionStatus[sessionID] ?? "idle",
          });
          setStore("sessionStatus", sessionID, normalized);
          notifySessionBusy(sessionID, normalized, sourceWsId);
          if (sessionID === options.selectedSessionId() && normalized !== "idle") {
            options.setError(null);
          }
        }
      }
    }

    if (event.type === "session.idle") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && isKnownSessionId(sessionID)) {
          recordSessionStatusTrace("sse-session-idle", {
            sessionId: sessionID,
            status: "idle",
            sourceWorkspaceId: sourceWsId ?? null,
            previous: store.sessionStatus[sessionID] ?? "idle",
          });
          setStore("sessionStatus", sessionID, "idle");
          notifySessionBusy(sessionID, "idle", sourceWsId);
          // VSLO-171.F3Ú6: SSE event handler will dispatch on per-workspace
          // client (from event payload workspaceId) once SSE multiplex lands.
          const c = options.client();
          if (c) {
            try {
              const latest = applySessionDirectoryOverride(unwrap(await c.session.get({ sessionID })));
              setStore("sessions", (current) => upsertSession(current, latest));
            } catch {
              // ignore
            }
          }
        }
      }
    }

    if (event.type === "opencode.hotreload.applied") {
      options.onHotReloadApplied?.();
    }

    if (event.type === "session.error") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID) {
          setStore("sessionStatus", sessionID, "idle");
          notifySessionBusy(sessionID, "idle", sourceWsId);
        }
        const errorObj = record.error as Record<string, unknown> | undefined;
        if (errorObj) {
          const errorName = typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
          if (errorName === "MessageAbortedError") {
            // Cancellation is a user-driven control flow. Don't treat it as a
            // fatal error banner; the session UI already provides local UX.
            if (!sessionID) {
              options.setError(null);
            }
            return;
          }
          if (sessionID) {
            appendSessionErrorTurn(sessionID, addOpencodeCacheHint(formatSessionError(errorObj)));
          } else {
            options.setError(addOpencodeCacheHint(formatSessionError(errorObj)));
          }
          return;
        }

        const fallback = truncateErrorField(record.error, 700) ?? "An unexpected error occurred";
        if (sessionID) {
          appendSessionErrorTurn(sessionID, addOpencodeCacheHint(fallback));
        } else {
          options.setError(addOpencodeCacheHint(fallback));
        }
      }
    }

    if (event.type === "message.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Message;
          if (!isKnownSessionId(info.sessionID)) return;
          setStore("messages", info.sessionID, (current = []) => upsertMessageInfo(current, info));
          if ((info as { role?: string }).role === "assistant") {
            options.onAssistantResponseObserved?.(info.sessionID);
          }
        }
      }
    }

    if (event.type === "message.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        if (sessionID && messageID) {
          setStore("messages", sessionID, (current = []) => removeMessageInfo(current, messageID));
          setStore("parts", messageID, []);
          setStore(
            "commandDisplayByMessageID",
            produce((draft: Record<string, string>) => {
              delete draft[messageID];
            }),
          );
        }
      }
    }

    if (event.type === "command.executed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID.trim() : "";
        const name = typeof record.name === "string" ? record.name : "";
        const args = typeof record.arguments === "string" ? record.arguments : "";
        setCommandDisplay(messageID, name, args);
      }
    }

    if (event.type === "message.part.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.part && typeof record.part === "object") {
          const part = record.part as Part;

          // Drop events for sessions that don't belong to the active workspace.
          // This prevents cross-workspace message leakage through the shared SSE stream.
          if (!isKnownSessionId(part.sessionID)) {
            sessionWarn("message.part.updated:ignored:unknown-session", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
            });
            return;
          }

          const delta = typeof record.delta === "string" ? record.delta : null;
          const partUpdatedStartedAt = perfNow();

          setStore(
            produce((draft: StoreState) => {
              const list = draft.messages[part.sessionID] ?? [];
              if (!list.find((message) => message.id === part.messageID)) {
                draft.messages[part.sessionID] = upsertMessageInfo(list, createPlaceholderMessage(part));
              }

              const parts = draft.parts[part.messageID] ?? [];
              const existingIndex = parts.findIndex((item) => item.id === part.id);

              if (delta && part.type === "text" && existingIndex !== -1) {
                const existing = parts[existingIndex] as Part & { text?: string };
                if (typeof existing.text === "string" && !existing.text.endsWith(delta)) {
                  const next = { ...existing, text: `${existing.text}${delta}` } as Part;
                  parts[existingIndex] = next;
                  draft.parts[part.messageID] = parts;
                  return;
                }
              }

              draft.parts[part.messageID] = upsertPartInfo(parts, part);
            }),
          );
          const resolvedPart =
            store.parts[part.messageID]?.find((item) => item.id === part.id) ??
            part;
          recordSyntheticContinueDiagnostic(resolvedPart);
          const partUpdatedMs = Math.round((perfNow() - partUpdatedStartedAt) * 100) / 100;
          if (sessionDebugEnabled() && (partUpdatedMs >= 8 || (delta?.length ?? 0) >= 120)) {
            const textLength =
              part.type === "text" && typeof (part as { text?: unknown }).text === "string"
                ? String((part as { text?: string }).text).length
                : null;
            recordPerfLog(true, "session.event", "message.part.updated", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              partType: part.type,
              deltaLength: delta?.length ?? 0,
              textLength,
              ms: partUpdatedMs,
            });
          }
          maybeMarkReloadRequired(part);
          maybeHandleInvalidToolError(part);
          maybeHandleChromeMcpCompletedError(resolvedPart);
        }
      }
    }

    if (event.type === "message.part.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        const partID = typeof record.partID === "string" ? record.partID : null;
        if (messageID && partID) {
          setStore("parts", messageID, (current = []) => removePartInfo(current, partID));
        }
      }
    }

    if (event.type === "todo.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && isKnownSessionId(sessionID) && Array.isArray(record.todos)) {
          setStore("todos", sessionID, record.todos as TodoItem[]);
        }
      }
    }

    if (event.type === "permission.asked" || event.type === "permission.replied") {
      try {
        await refreshPendingPermissions();
      } catch {
        // ignore
      }
    }

    if (
      event.type === "question.asked" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      try {
        await refreshPendingQuestions();
      } catch {
        // ignore
      }
    }
  };

  // VSLO-86 F4Ú12 — SSE multiplex. Each ensured per-workspace client gets its
  // own SSE stream tagged with `sourceWsId`. The active workspace's stream
  // mutates the single store as before; background streams' events early-exit
  // in `applyEvent`. Falls back to a single stream on the legacy global client
  // signal when no per-WS entries exist yet (boot, single-active path).
  const setupSseStream = (sourceWsId: string, c: RoutingClient): (() => void) => {
    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let wasConnected = false;
    let outageEpisode = clearOutageEpisode();

    let queue: Array<OpencodeEvent | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let queueStartedAt = 0;
    let peakQueueDepth = 0;
    let queueHasPartUpdates = false;
    let coalescedReplaced = 0;

    const keyForEvent = (event: OpencodeEvent) => {
      if (event.type === "session.status" || event.type === "session.idle") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = record ? (extractSessionId(record) ?? "") : "";
        return sessionID ? `${event.type}:${sessionID}` : undefined;
      }
      if (event.type === "message.part.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const part = record?.part as Part | undefined;
        if (part?.messageID && part.id) {
          return `message.part.updated:${part.messageID}:${part.id}`;
        }
      }
      if (event.type === "todo.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = record ? (extractSessionId(record) ?? "") : "";
        return sessionID ? `todo.updated:${sessionID}` : undefined;
      }
      return undefined;
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const eventsToApply = queue;
      queue = [];
      coalesced.clear();
      if (eventsToApply.length === 0) return;

      const queueWaitMs = queueStartedAt > 0 ? Date.now() - queueStartedAt : 0;
      queueStartedAt = 0;
      const peakDepth = peakQueueDepth;
      peakQueueDepth = 0;
      queueHasPartUpdates = false;
      const replaced = coalescedReplaced;
      coalescedReplaced = 0;

      last = Date.now();
      const startedAt = perfNow();
      let applied = 0;
      let partUpdates = 0;
      let messageUpdates = 0;
      batch(() => {
        for (const event of eventsToApply) {
          if (!event) continue;
          if (event.type === "message.part.updated") partUpdates += 1;
          if (event.type === "message.updated") messageUpdates += 1;
          applied += 1;
          void applyEvent(event, sourceWsId);
        }
      });

      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      const dropped = eventsToApply.length - applied;
      if (
        sessionDebugEnabled() &&
        (elapsedMs >= 10 || queueWaitMs >= 40 || peakDepth >= 25 || applied >= 30 || dropped >= 12)
      ) {
        recordPerfLog(true, "session.sse", "flush", {
          queued: eventsToApply.length,
          applied,
          dropped,
          queueWaitMs,
          peakQueueDepth: peakDepth,
          coalescedReplaced: replaced,
          messageUpdates,
          partUpdates,
          ms: elapsedMs,
        });
      }
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      const interval = queueHasPartUpdates ? 48 : 16;
      timer = setTimeout(flush, Math.max(0, interval - elapsed));
    };

    const markOutageAndMaybeNotify = () => {
      if (!outageEpisode.active) {
        outageEpisode = beginOutageEpisode(store.sessionStatus);
        recordPerfLog(sessionDebugEnabled(), "session.sse", "outage-started", {
          runningSessions: outageEpisode.runningSessionIds.length,
        });
      }

      if (shouldShowReconnecting(outageEpisode)) {
        options.onReconnectNotice?.("reconnecting");
        outageEpisode = { ...outageEpisode, shownReconnecting: true };
      }
    };

    const runReconnectCatchup = async () => {
      if (!outageEpisode.active) return;
      if (!outageEpisode.hadRunningSessions) {
        outageEpisode = clearOutageEpisode();
        return;
      }

      const sessionIds = outageEpisode.runningSessionIds.slice();
      recordPerfLog(sessionDebugEnabled(), "session.sse", "catchup-start", {
        sessions: sessionIds.length,
      });

      for (const sessionID of sessionIds) {
        if (!sessionID) continue;

        try {
          const fetched = unwrap(await c.session.get({ sessionID })) as Record<string, unknown>;
          const normalized = normalizeSessionStatus(fetched?.status);
          setStore("sessionStatus", sessionID, normalized);
          notifySessionBusy(sessionID, normalized, sourceWsId);
        } catch {
          setStore("sessionStatus", sessionID, "idle");
          notifySessionBusy(sessionID, "idle", sourceWsId);
          continue;
        }

        try {
          const limit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
          const msgs = unwrap(
            await withTimeout(c.session.messages({ sessionID, limit }), 12000, "session.messages"),
          );
          setMessagesForSession(sessionID, msgs);
          setMessageLimitBySession((prev) => ({ ...prev, [sessionID]: limit }));
          setMessageCompleteBySession((prev) => ({ ...prev, [sessionID]: msgs.length < limit }));
        } catch {
          // fail soft per session
        }

        try {
          const list = unwrap(await withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
          setStore("todos", sessionID, list);
        } catch {
          // fail soft per session
        }
      }

      try {
        await withTimeout(refreshPendingPermissions(), 6000, "permission.list");
      } catch {
        // ignore
      }

      try {
        await withTimeout(refreshPendingQuestions(), 6000, "question.list");
      } catch {
        // ignore
      }

      if (shouldShowReconnected(outageEpisode)) {
        options.onReconnectNotice?.("reconnected");
        outageEpisode = { ...outageEpisode, shownReconnected: true };
      }

      recordPerfLog(sessionDebugEnabled(), "session.sse", "catchup-complete", {
        sessions: sessionIds.length,
      });
      outageEpisode = clearOutageEpisode();
    };

    const connectSse = async (controller: AbortController) => {
      try {
        // VSLO-86 — when running under Tauri, route SSE through the Rust-side
        // proxy (engineSseSubscribe) so the stream doesn't hold an
        // `fetch_read_body` invoke on the Tauri http plugin's IPC channel.
        // That pending invoke was starving paralel short requests (sidebar
        // session listing across workspaces), surfacing as 60s timeouts. The
        // SDK path is kept as a fallback for non-Tauri runtimes.
        const entry = sourceWsId ? options.routing.entry(sourceWsId) : null;
        const sub = await (isEngineSseAvailable() && entry?.baseUrl
          ? engineSseSubscribe({
              workspaceId: sourceWsId,
              baseUrl: entry.baseUrl,
              directory: entry.directory ?? null,
              signal: controller.signal,
            })
          : c.event.subscribe(undefined, { signal: controller.signal }));
        let yielded = Date.now();
        let lastArrivalAt = Date.now();

        // Reset reconnect counter on successful connection
        const isReconnection = wasConnected;
        wasConnected = true;
        reconnectAttempt = 0;
        recordPerfLog(sessionDebugEnabled(), "session.sse", "connected");

        // After SSE reconnection, resync running-at-outage sessions so missed
        // updates while disconnected are reflected in the local store.
        if (isReconnection) {
          await runReconnectCatchup();
        }

        for await (const raw of sub.stream) {
          if (cancelled) break;

          const event = normalizeEvent(raw);
          if (!event) continue;

          const arrivedAt = Date.now();
          const arrivalGapMs = arrivedAt - lastArrivalAt;
          lastArrivalAt = arrivedAt;
          if (sessionDebugEnabled() && arrivalGapMs >= 220) {
            recordPerfLog(true, "session.sse", "arrival-gap", {
              ms: arrivalGapMs,
              type: event.type,
            });
          }

          const key = keyForEvent(event);
          if (key) {
            const existing = coalesced.get(key);
            if (existing !== undefined) {
              if (queue[existing] !== undefined) {
                coalescedReplaced += 1;
              }
              queue[existing] = undefined;
            }
            coalesced.set(key, queue.length);
          }

          if (queue.length === 0) {
            queueStartedAt = Date.now();
          }
          if (event.type === "message.part.updated") {
            queueHasPartUpdates = true;
          }
          queue.push(event);
          if (queue.length > peakQueueDepth) {
            peakQueueDepth = queue.length;
          }
          schedule();

          if (Date.now() - yielded < 8) continue;
          yielded = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // Stream ended normally - attempt reconnect unless cancelled
        if (!cancelled) {
          options.setSseConnected(false);
          recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-ended");
          scheduleReconnect(controller);
        }
      } catch (e) {
        if (cancelled) return;
        if (controller.signal.aborted) return;

        const message = e instanceof Error ? e.message : String(e);

        // Mark SSE as disconnected and schedule reconnect
        options.setSseConnected(false);
        recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-error", {
          error: message,
        });
        scheduleReconnect(controller);
      }
    };

    const scheduleReconnect = (oldController: AbortController) => {
      if (cancelled) return;
      if (reconnectTimer) return;
      markOutageAndMaybeNotify();
      oldController.abort();

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
      recordPerfLog(sessionDebugEnabled(), "session.sse", "reconnect-scheduled", {
        attempt: reconnectAttempt,
        delayMs: delay,
      });

      reconnectTimer = setTimeout(() => {
        if (cancelled) return;
        reconnectTimer = undefined;
        const newController = new AbortController();
        void connectSse(newController);
      }, delay);
    };

    const controller = new AbortController();
    void connectSse(controller);

    return () => {
      cancelled = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      flush();
    };
  };

  createEffect(() => {
    // VSLO-86 F4Ú12 — outer effect tracks routing.entryIds() so streams
    // re-fan-out when workspaces are ensured/released. Falls back to the
    // global client signal so the legacy single-active boot path keeps
    // working before any workspace has been routing.ensure()'d.
    const entryIds = options.routing.entryIds();
    const fallback = options.client();

    const targets: Array<{ wsId: string; client: RoutingClient }> = [];
    if (entryIds.length > 0) {
      for (const wsId of entryIds) {
        const c = options.routing.client(wsId);
        if (c) targets.push({ wsId, client: c });
      }
    } else if (fallback) {
      targets.push({ wsId: "", client: fallback });
    }

    // Targets changed → workspace registry shifted (switch, ensure, release).
    // Clear the active-workspace session ID set so stale events from the
    // previous active workspace are rejected until loadSessions() repopulates.
    workspaceSessionIds.clear();

    if (targets.length === 0) return;

    const cleanups: Array<() => void> = [];
    for (const target of targets) {
      cleanups.push(setupSseStream(target.wsId, target.client));
    }

    onCleanup(() => {
      for (const cleanup of cleanups) cleanup();
    });
  });

  // VSLO-171 F3Ú6a — per-workspace cache snapshot/restore helpers. In single-
  // active routing mode these are no-ops; in multi mode app.tsx wires them to
  // a createEffect on activeWorkspaceId so each switch saves the outgoing
  // workspace state and loads the incoming one.
  const saveWorkspaceSnapshot = (workspaceId: string) => {
    if (!workspaceId) return;
    perWorkspaceCache.set(workspaceId, {
      workspaceId,
      sessions: store.sessions.slice(),
      sessionStatus: { ...store.sessionStatus },
      sessionErrorTurns: { ...store.sessionErrorTurns },
      messages: { ...store.messages },
      parts: { ...store.parts },
      todos: { ...store.todos },
      pendingPermissions: store.pendingPermissions.slice(),
      pendingQuestions: store.pendingQuestions.slice(),
      selectedSessionId: options.selectedSessionId(),
      lastUsed: Date.now(),
    });
  };

  const loadWorkspaceSnapshot = (workspaceId: string): boolean => {
    if (!workspaceId) return false;
    const snapshot = perWorkspaceCache.get(workspaceId);
    if (!snapshot) return false;
    setStore(
      reconcile(
        {
          sessions: snapshot.sessions,
          sessionStatus: snapshot.sessionStatus,
          sessionErrorTurns: snapshot.sessionErrorTurns,
          messages: snapshot.messages,
          parts: snapshot.parts,
          // commandDisplay + events are session-debug surfaces, not cached.
          commandDisplayByMessageID: {},
          todos: snapshot.todos,
          pendingPermissions: snapshot.pendingPermissions,
          pendingQuestions: snapshot.pendingQuestions,
          events: [],
        },
        { merge: false }
      )
    );
    workspaceSessionIds.clear();
    for (const s of snapshot.sessions) workspaceSessionIds.add(s.id);
    if (snapshot.selectedSessionId) {
      options.setSelectedSessionId(snapshot.selectedSessionId);
    }
    snapshot.lastUsed = Date.now();
    return true;
  };

  const clearWorkspaceSnapshot = (workspaceId: string) => {
    perWorkspaceCache.delete(workspaceId);
  };

  return {
    sessions,
    sessionErrorTurnsById: (sessionID: string | null) => (sessionID ? store.sessionErrorTurns[sessionID] ?? [] : []),
    selectedSessionErrorTurns: createMemo(() => {
      const sessionID = options.selectedSessionId();
      return sessionID ? store.sessionErrorTurns[sessionID] ?? [] : [];
    }),
    sessionStatusById,
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
    setMessages,
    setTodos,
    setPendingPermissions,
    setPendingQuestions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    hydrateTranscriptSnapshot,
    hasWarmTranscript,
    getCachedTranscriptMessageCount,
    getTranscriptFreshness,
    saveWorkspaceSnapshot,
    loadWorkspaceSnapshot,
    clearWorkspaceSnapshot,
    allPendingPermissions,
    pendingPermissionCountByWs,
    pendingPermissionsByWs,
  };
}
