import { createSignal, type Setter } from "solid-js";
import { reconcile, type SetStoreFunction } from "solid-js/store";

import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import type { VesloSessionTranscriptSnapshot } from "../lib/veslo-server";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { unwrap } from "../lib/opencode";
import type {
  DirectoryQueryPathMode,
} from "../utils";
import {
  directoryQueryPathVariants,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
  normalizeTodoItems,
  safeStringify,
  sessionDirectoryMatchesRoot,
} from "../utils";
import type { MessageInfo, MessageWithParts, TodoItem } from "../types";
import {
  sortById,
  sortMessagesByActivity,
  sortSessionsByActivity,
  upsertSession,
} from "./session-store-model";
import type { WorkspaceRouting } from "./workspace-routing";
import {
  INITIAL_SESSION_MESSAGE_LIMIT,
  SESSION_MESSAGE_LOAD_CHUNK,
} from "./session-transcript-controller";
import { createSelectSessionGuard } from "./select-session-guard";
import type { TranscriptProjectionScope } from "./transcript-projection-store";

type SelectionStoreState = {
  sessions: Session[];
  sessionStatus: Record<string, string>;
  messages: Record<string, MessageInfo[]>;
  todos: Record<string, TodoItem[]>;
};

type SessionReadPolicy = {
  activeWorkspaceId: string;
  browseFromDb: boolean;
  browseModeOnly: boolean;
  configuredBrowseFromDb: boolean;
  foreignWorkspace: boolean;
  liveRecoveryFromUnavailable: boolean;
  sessionWorkspaceId: string;
};

type ConversationReader = {
  listConversations: (
    workspaceId: string,
    directory?: string,
    options?: { sync?: boolean },
  ) => Promise<{ items: Session[]; source?: "sqlite" | "unavailable" }>;
};

export type SessionHistoryLoadScope = {
  sessionId: string;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

type SessionHistoryLoadedResult =
  | {
      status: "loaded";
      snapshot: VesloSessionTranscriptSnapshot;
      projectionScope?: TranscriptProjectionScope;
    }
  | {
      status: "empty";
      snapshot: VesloSessionTranscriptSnapshot;
      projectionScope?: TranscriptProjectionScope;
    };

export type SessionHistoryLoadResult =
  | SessionHistoryLoadedResult
  | { status: "unavailable"; scope: SessionHistoryLoadScope; reason?: string | null };

export type SelectedSessionHistoryUnavailable = SessionHistoryLoadScope & {
  reason?: string | null;
};

export type SessionOfflineTranscriptLoadResult =
  | SessionHistoryLoadResult
  | VesloSessionTranscriptSnapshot
  | null
  | undefined;

export type SessionOfflineTranscriptLoadContext = {
  purpose: "selection" | "load-earlier";
  selectionVersion?: number;
};

export type OfflineTranscriptFallbackKind =
  | "client-unavailable"
  | "read-policy"
  | "session-not-found"
  | "other";

export type OfflineTranscriptUnavailableKind =
  | "missing-workspace-root"
  | "veslo-read-api-unavailable"
  | "source-unavailable"
  | "offline-transcript-unavailable"
  | "other"
  | null;

export type SessionSelectionControllerDeps = {
  store: SelectionStoreState;
  setStore: SetStoreFunction<SelectionStoreState>;
  routing: WorkspaceRouting;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  selectSessionScopeKey?: (sessionID: string) => string;
  directoryQueryPathMode?: () => DirectoryQueryPathMode;
  conversationReader?: () => ConversationReader | null;
  onSelectionStart?: (sessionID: string, selectionVersion: number) => void;
  loadOfflineTranscript?: (
    sessionID: string,
    limit: number,
    context: SessionOfflineTranscriptLoadContext,
  ) => Promise<SessionOfflineTranscriptLoadResult>;
  publishTranscriptProjection?: (
    scope: TranscriptProjectionScope,
    snapshot: VesloSessionTranscriptSnapshot,
  ) => void;
  shouldBrowseSessionFromDb?: (sessionID: string) => boolean;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  onSessionLoadComplete?: () => void;
  sessionDebug: (label: string, payload?: unknown) => void;
  sessionWarn: (label: string, payload?: unknown) => void;
  addError: (error: unknown, fallback?: string) => void;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  clientForSession: (sessionID: string) => { workspaceId: string; client: ReturnType<WorkspaceRouting["active"]> };
  sessionReadPolicy: (sessionID: string, workspaceId: string) => SessionReadPolicy;
  isSessionNotFoundError: (error: unknown) => boolean;
  sessionDirectoryOverrides: () => Record<string, string>;
  applySessionDirectoryOverride: <T extends Session>(session: T) => T;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  readStatusForSession: (sessionID: string | null | undefined, workspaceId?: string | null) => string;
  workspaceSessionIds: Set<string>;
  setMessagesForSession: (sessionID: string, list: MessageWithParts[]) => void;
  hydrateTranscriptSnapshot: (snapshot: VesloSessionTranscriptSnapshot) => void;
  /** Monotonic revision of live SSE changes for a session. */
  transcriptObservationVersion?: (sessionID: string) => number;
  messageLimitBySession: () => Record<string, number>;
  setMessageLimitBySession: Setter<Record<string, number>>;
  messageCompleteBySession: () => Record<string, boolean>;
  setMessageCompleteBySession: Setter<Record<string, boolean>>;
  messageLoadBusyBySession: () => Record<string, boolean>;
  setMessageLoadBusyBySession: Setter<Record<string, boolean>>;
  refreshPendingPermissions: () => Promise<void>;
};

export function isSessionNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : safeStringify(error);
  return /Session not found|NotFoundError|status\W*404|\b404\b/i.test(message);
}

export function classifyOfflineTranscriptFallbackReason(reason: string): OfflineTranscriptFallbackKind {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "client unavailable") return "client-unavailable";
  if (normalized === "read policy") return "read-policy";
  if (normalized === "session not found") return "session-not-found";
  return "other";
}

export function classifyOfflineTranscriptUnavailableReason(
  reason: string | null | undefined,
): OfflineTranscriptUnavailableKind {
  const normalized = reason?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized === "missing-workspace-root") return "missing-workspace-root";
  if (normalized === "veslo-read-api-unavailable") return "veslo-read-api-unavailable";
  if (normalized === "source-unavailable") return "source-unavailable";
  if (normalized === "offline-transcript-unavailable") return "offline-transcript-unavailable";
  return "other";
}

function isHistoryLoadResult(input: SessionOfflineTranscriptLoadResult): input is SessionHistoryLoadResult {
  return Boolean(input && typeof input === "object" && "status" in input);
}

function normalizeHistoryLoadScope(
  fallback: SessionHistoryLoadScope,
  snapshot?: VesloSessionTranscriptSnapshot | null,
  scope?: Partial<SessionHistoryLoadScope> | null,
): SessionHistoryLoadScope {
  return {
    sessionId: scope?.sessionId?.trim() || snapshot?.sessionId?.trim() || fallback.sessionId,
    workspaceId: scope?.workspaceId ?? snapshot?.workspaceId ?? fallback.workspaceId,
    workspaceRoot: scope?.workspaceRoot ?? fallback.workspaceRoot,
    directory: scope?.directory ?? snapshot?.directory ?? fallback.directory,
    conversationId: scope?.conversationId ?? snapshot?.conversationId ?? fallback.conversationId,
    opencodeSessionId: scope?.opencodeSessionId ?? snapshot?.opencodeSessionId ?? fallback.opencodeSessionId,
  };
}

function normalizeHistoryLoadResult(
  input: SessionOfflineTranscriptLoadResult,
  fallbackScope: SessionHistoryLoadScope,
  unavailableReason: string,
): SessionHistoryLoadResult {
  if (!input) {
    return {
      status: "unavailable",
      scope: fallbackScope,
      reason: unavailableReason,
    };
  }
  if (isHistoryLoadResult(input)) {
    if (input.status === "unavailable") {
      return {
        ...input,
        scope: normalizeHistoryLoadScope(fallbackScope, null, input.scope),
        reason: input.reason ?? unavailableReason,
      };
    }
    const status = input.snapshot.messages.length === 0 ? "empty" : input.status;
    return { ...input, status, snapshot: input.snapshot };
  }
  if (input.source === "unavailable") {
    return {
      status: "unavailable",
      scope: normalizeHistoryLoadScope(fallbackScope, input),
      reason: "source-unavailable",
    };
  }
  return {
    status: input.messages.length === 0 ? "empty" : "loaded",
    snapshot: input,
  };
}

function retargetSnapshotForUiSession(
  snapshot: VesloSessionTranscriptSnapshot,
  uiSessionID: string,
): VesloSessionTranscriptSnapshot {
  const id = uiSessionID.trim();
  if (!id || snapshot.sessionId === id) return snapshot;
  return {
    ...snapshot,
    sessionId: id,
    opencodeSessionId: snapshot.opencodeSessionId ?? snapshot.sessionId,
  };
}

export function createSessionSelectionController(deps: SessionSelectionControllerDeps) {
  let selectRunCounter = 0;
  const selectGuard = createSelectSessionGuard();
  const [historyUnavailable, setHistoryUnavailable] = createSignal<SelectedSessionHistoryUnavailable | null>(null);

  const sessions = () => deps.store.sessions;
  const selectedSession = () => {
    const id = deps.selectedSessionId();
    if (!id) return null;
    return deps.store.sessions.find((session) => session.id === id) ?? null;
  };
  const selectedSessionStatus = () => {
    const id = deps.selectedSessionId();
    if (!id) return "idle";
    return deps.readStatusForSession(id);
  };
  const todos = () => {
    const id = deps.selectedSessionId();
    if (!id) return [];
    return deps.store.todos[id] ?? [];
  };
  const selectedSessionHistoryUnavailable = () => {
    const id = deps.selectedSessionId()?.trim() ?? "";
    const unavailable = historyUnavailable();
    if (!id || unavailable?.sessionId !== id) return null;
    return unavailable;
  };
  const selectedSessionHasEarlierMessages = () => {
    const id = deps.selectedSessionId();
    if (!id) return false;
    if (selectedSessionHistoryUnavailable()) return false;
    return !deps.messageCompleteBySession()[id];
  };
  const selectedSessionLoadingEarlierMessages = () => {
    const id = deps.selectedSessionId();
    if (!id) return false;
    return Boolean(deps.messageLoadBusyBySession()[id]);
  };
  const clearSessionHistoryUnavailable = (sessionID: string) => {
    setHistoryUnavailable((current) => (current?.sessionId === sessionID ? null : current));
  };
  const markSessionHistoryLoaded = (sessionID: string, messageCount: number, limit: number) => {
    clearSessionHistoryUnavailable(sessionID);
    deps.setMessageLimitBySession((prev: Record<string, number>) => ({
      ...prev,
      [sessionID]: limit,
    }));
    deps.setMessageCompleteBySession((prev: Record<string, boolean>) => ({
      ...prev,
      [sessionID]: messageCount < limit,
    }));
  };
  const markSessionHistoryUnavailable = (
    sessionID: string,
    history: Extract<SessionHistoryLoadResult, { status: "unavailable" }>,
  ) => {
    deps.setStore("todos", sessionID, []);
    setHistoryUnavailable({
      sessionId: history.scope.sessionId?.trim() || sessionID,
      workspaceId: history.scope.workspaceId ?? null,
      workspaceRoot: history.scope.workspaceRoot ?? null,
      directory: history.scope.directory ?? null,
      conversationId: history.scope.conversationId ?? null,
      opencodeSessionId: history.scope.opencodeSessionId ?? null,
      reason: history.reason ?? null,
    });
  };

  async function loadSessions(scopeRoot?: string) {
    const queryDirectories = directoryQueryPathVariants(scopeRoot, {
      mode: deps.directoryQueryPathMode?.() ?? "auto",
    });
    const queryDirectory = (queryDirectories[0] ?? normalizeDirectoryQueryPath(scopeRoot)) || undefined;

    const start = Date.now();
    deps.sessionDebug("sessions:load:start", {
      scopeRoot: scopeRoot ?? null,
      queryDirectory: queryDirectory ?? null,
    });
    let list: Session[] | null = null;
    let usedConversationRead = false;
    const workspaceId = deps.routing.activeWorkspaceId().trim();
    const c = deps.routing.active();
    const workspaceRuntimeReady = deps.isWorkspaceRuntimeReady(workspaceId);
    const reader = deps.conversationReader?.() ?? null;
    if (workspaceId && reader) {
      try {
        const result = await reader.listConversations(workspaceId, queryDirectory, {
          sync: Boolean(c) && workspaceRuntimeReady,
        });
        if (result.source !== "unavailable" || !workspaceRuntimeReady || !c) {
          list = result.items;
          usedConversationRead = true;
          deps.sessionDebug("sessions:load:conversation-read", {
            workspaceId,
            source: result.source ?? "unknown",
            count: list.length,
            ms: Date.now() - start,
          });
        } else {
          deps.sessionDebug("sessions:load:conversation-read-unavailable-fallback", {
            workspaceId,
            ms: Date.now() - start,
          });
        }
      } catch (error) {
        deps.sessionDebug("sessions:load:conversation-read-failed", {
          workspaceId,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (!workspaceRuntimeReady || !c) {
          list = [];
          usedConversationRead = true;
        }
      }
    }

    if (!list && workspaceId && !workspaceRuntimeReady) {
      list = [];
      usedConversationRead = true;
      deps.sessionDebug("sessions:load:runtime-not-ready-skip-sdk", {
        workspaceId,
        queryDirectory: queryDirectory ?? null,
        ms: Date.now() - start,
      });
    }

    if (!list) {
      if (!c) return;
      const candidates: Array<string | undefined> = queryDirectories.length > 0 ? queryDirectories : [undefined];
      const mergedById = new Map<string, Session>();
      const usedQueryDirectories: Array<string | null> = [];
      for (const candidate of candidates) {
        usedQueryDirectories.push(candidate ?? null);
        const fetchedList = unwrap(await c.session.list({ directory: candidate }));
        for (const session of fetchedList) {
          mergedById.set(session.id, session);
        }
      }
      list = Array.from(mergedById.values());
      deps.sessionDebug("sessions:load:raw", {
        count: list.length,
        queryDirectory: usedQueryDirectories[0] ?? null,
        queryDirectories: usedQueryDirectories,
        queryDirectoryFallbacks: Math.max(0, candidates.length - 1),
        ms: Date.now() - start,
      });
    }

    const root = normalizeDirectoryPath(scopeRoot);
    const filtered = root
      ? list
        .map((session) => deps.applySessionDirectoryOverride(session))
        .filter((session) => sessionDirectoryMatchesRoot(deps.resolveSessionDirectory(session), root))
      : list.map((session) => deps.applySessionDirectoryOverride(session));

    const overrideIds = root
      ? Object.entries(deps.sessionDirectoryOverrides())
        .filter(([, directory]) => sessionDirectoryMatchesRoot(directory, root))
        .map(([sessionID]) => sessionID)
      : [];

    const merged = new Map(filtered.map((session) => [session.id, session] as const));
    for (const sessionID of overrideIds) {
      if (merged.has(sessionID)) continue;
      if (usedConversationRead || !c) continue;
      try {
        const fetched = unwrap(await c.session.get({ sessionID }));
        merged.set(sessionID, deps.applySessionDirectoryOverride(fetched));
      } catch {
        // ignore stale local overrides; delete path is handled by app state
      }
    }

    let nextSessions = sortSessionsByActivity(Array.from(merged.values()));
    const selectedSessionId = deps.selectedSessionId()?.trim() ?? "";
    if (selectedSessionId && !nextSessions.some((session) => session.id === selectedSessionId)) {
      const selected = deps.store.sessions.find((session) => session.id === selectedSessionId) ?? null;
      const selectedSessionDirectory = selected ? deps.resolveSessionDirectory(selected) : "";
      if (selected && (!root || sessionDirectoryMatchesRoot(selectedSessionDirectory, root))) {
        nextSessions = sortSessionsByActivity([selected, ...nextSessions]);
        deps.sessionDebug("sessions:load:retained-selected", {
          sessionID: selected.id,
          root: root || null,
        });
      }
    }
    deps.sessionDebug("sessions:load:filtered", { root: root || null, count: nextSessions.length });

    deps.workspaceSessionIds.clear();
    for (const session of nextSessions) {
      deps.workspaceSessionIds.add(session.id);
    }

    deps.setStore("sessions", reconcile(nextSessions, { key: "id" }));
  }

  async function renameSession(sessionID: string, title: string, workspaceId?: string | null) {
    const ownerWorkspaceId = workspaceId?.trim() ?? "";
    const c = ownerWorkspaceId ? deps.routing.client(ownerWorkspaceId) : deps.routing.active();
    if (!c) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    const next = deps.applySessionDirectoryOverride(unwrap(await c.session.update({ sessionID, title: trimmed })));
    deps.setStore("sessions", (current: Session[]) => upsertSession(current, next));
  }

  async function selectSession(sessionID: string, options: { skipTranscriptRead?: boolean } = {}) {
    const perfEnabled = deps.developerMode();
    const selectionKey = deps.selectSessionScopeKey?.(sessionID)?.trim() || sessionID;

    const existing = selectGuard.tryDedup(selectionKey);
    if (existing) {
      deps.setSelectedSessionId(sessionID);
      deps.setError(null);
      recordPerfLog(perfEnabled, "session.select", "dedupe join", {
        sessionID,
        selectionKey,
      });
      return existing;
    }

    const runId = ++selectRunCounter;
    const version = selectGuard.nextVersion();
    deps.onSelectionStart?.(sessionID, version);
    deps.setSelectedSessionId(sessionID);
    deps.setError(null);
    const startedAt = perfNow();
    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.select", event, {
        runId,
        sessionID,
        selectionKey,
        elapsedMs,
        ...(payload ?? {}),
      });
    };
    const traceSelect = (event: string, payload?: Record<string, unknown>) => {
      recordSendWorkflowTrace("session.select", event, {
        runId,
        sessionID,
        selectionKey,
        elapsedMs: Math.round((perfNow() - startedAt) * 100) / 100,
        ...(payload ?? {}),
      });
    };
    const isStale = () =>
      version !== selectGuard.currentVersion() ||
      deps.selectedSessionId() !== sessionID ||
      (deps.selectSessionScopeKey?.(sessionID)?.trim() || sessionID) !== selectionKey;
    const abortIfStale = (reason: string) => {
      if (!isStale()) return false;
      mark(`aborting: ${reason}`);
      return true;
    };

    if (options.skipTranscriptRead) {
      mark("transcript read deferred");
      traceSelect("transcript-read-deferred", {
        reason: "submitted-run-admitted-before-select",
      });
      deps.onSessionLoadComplete?.();
      return;
    }

    const run = (async () => {
      mark("start");
      traceSelect("start");

      const existingLimit = deps.messageLimitBySession()[sessionID] ?? 0;
      const requestLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, existingLimit);
      const clearMessageLoadBusy = () => {
        deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
          ...prev,
          [sessionID]: false,
        }));
      };
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: true,
      }));
      const sessionClient = deps.clientForSession(sessionID);
      const c = sessionClient.client;
      const readPolicy = deps.sessionReadPolicy(sessionID, sessionClient.workspaceId);
      const unavailableHistory = (
        reason: string,
      ): Extract<SessionHistoryLoadResult, { status: "unavailable" }> => ({
        status: "unavailable",
        scope: {
          sessionId: sessionID,
          workspaceId:
            readPolicy.sessionWorkspaceId || sessionClient.workspaceId || readPolicy.activeWorkspaceId || null,
        },
        reason,
      });
      const loadOfflineTranscriptFallback = async (reason: string) => {
        const fallbackKind = classifyOfflineTranscriptFallbackReason(reason);
        const fallbackStartedAt = perfNow();
        const observationVersionAtStart = deps.transcriptObservationVersion?.(sessionID) ?? null;
        mark("calling offline transcript fallback", {
          limit: requestLimit,
          reason,
          fallbackKind,
          activeWorkspaceId: readPolicy.activeWorkspaceId || null,
          sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
        });
        traceSelect("offline-transcript-fallback:start", {
          limit: requestLimit,
          reason,
          fallbackKind,
          activeWorkspaceId: readPolicy.activeWorkspaceId || null,
          sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
          browseFromDb: readPolicy.browseFromDb,
          browseModeOnly: readPolicy.browseModeOnly,
          configuredBrowseFromDb: readPolicy.configuredBrowseFromDb,
          foreignWorkspace: readPolicy.foreignWorkspace,
          liveRecoveryFromUnavailable: readPolicy.liveRecoveryFromUnavailable,
        });
        let history: SessionHistoryLoadResult;
        try {
          history = normalizeHistoryLoadResult(
            await deps.loadOfflineTranscript?.(sessionID, requestLimit, {
              purpose: "selection",
              selectionVersion: version,
            }),
            {
              sessionId: sessionID,
              workspaceId: readPolicy.sessionWorkspaceId || readPolicy.activeWorkspaceId || null,
            },
            "offline-transcript-unavailable",
          );
        } catch (error) {
          deps.addError(error);
          mark("offline transcript fallback failed", {
            reason,
            fallbackKind,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          traceSelect("offline-transcript-fallback:error", {
            reason,
            fallbackKind,
            durationMs: Math.round((perfNow() - fallbackStartedAt) * 100) / 100,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          return {
            status: "unavailable" as const,
            history: unavailableHistory("offline-transcript-read-failed"),
          };
        }
        if (abortIfStale("selection changed before offline transcript applied")) {
          traceSelect("offline-transcript-fallback:stale", {
            reason,
            fallbackKind,
            durationMs: Math.round((perfNow() - fallbackStartedAt) * 100) / 100,
            status: history.status,
          });
          return { status: "stale" as const };
        }
        if (history.status === "loaded" || history.status === "empty") {
          const observationVersionNow = deps.transcriptObservationVersion?.(sessionID) ?? null;
          if (
            observationVersionAtStart !== null &&
            observationVersionNow !== null &&
            observationVersionNow !== observationVersionAtStart
          ) {
            traceSelect("offline-transcript-fallback:live-transcript-observed", {
              reason,
              fallbackKind,
              durationMs: Math.round((perfNow() - fallbackStartedAt) * 100) / 100,
              observationVersionAtStart,
              observationVersionNow,
            });
            return { status: "stale" as const };
          }
          if (history.projectionScope) {
            deps.publishTranscriptProjection?.(history.projectionScope, history.snapshot);
          }
          const snapshot = retargetSnapshotForUiSession(history.snapshot, sessionID);
          deps.hydrateTranscriptSnapshot(snapshot);
          deps.setStore("todos", sessionID, []);
          markSessionHistoryLoaded(sessionID, snapshot.messages.length, snapshot.limit);
          mark("offline transcript fallback done", {
            count: snapshot.messages.length,
            limit: requestLimit,
            reason,
            fallbackKind,
            status: history.status,
          });
          traceSelect("offline-transcript-fallback:done", {
            reason,
            fallbackKind,
            durationMs: Math.round((perfNow() - fallbackStartedAt) * 100) / 100,
            status: history.status,
            count: snapshot.messages.length,
            limit: requestLimit,
            assistantCount: snapshot.messages
              .filter((message) => (message as { role?: string }).role === "assistant")
              .length,
          });
          return { status: "applied" as const, history };
        }
        mark("offline transcript fallback unavailable", {
          reason,
          fallbackKind,
          unavailableReason: history.reason ?? null,
          unavailableKind: classifyOfflineTranscriptUnavailableReason(history.reason),
          scope: history.scope,
        });
        traceSelect("offline-transcript-fallback:unavailable", {
          reason,
          fallbackKind,
          durationMs: Math.round((perfNow() - fallbackStartedAt) * 100) / 100,
          unavailableReason: history.reason ?? null,
          unavailableKind: classifyOfflineTranscriptUnavailableReason(history.reason),
          scope: history.scope,
        });
        return { status: "unavailable" as const, history };
      };
      const recoverUnavailableHistoryFromLive = async (
        history: Extract<SessionHistoryLoadResult, { status: "unavailable" }>,
      ) => {
        const engineSessionID = history.scope.opencodeSessionId?.trim() ?? "";
        if (!c || !readPolicy.liveRecoveryFromUnavailable || !engineSessionID) {
          mark("live recovery skipped", {
            hasClient: Boolean(c),
            liveRecoveryFromUnavailable: readPolicy.liveRecoveryFromUnavailable,
            hasEngineSessionId: Boolean(engineSessionID),
            activeWorkspaceId: readPolicy.activeWorkspaceId || null,
            sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
          });
          traceSelect("live-recovery:skipped", {
            hasClient: Boolean(c),
            liveRecoveryFromUnavailable: readPolicy.liveRecoveryFromUnavailable,
            hasEngineSessionId: Boolean(engineSessionID),
            activeWorkspaceId: readPolicy.activeWorkspaceId || null,
            sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
          });
          return false;
        }
        const recoveryStartedAt = perfNow();
        mark("calling live recovery session.messages", {
          limit: requestLimit,
          uiSessionID: sessionID,
          engineSessionID,
        });
        traceSelect("live-recovery:start", {
          limit: requestLimit,
          uiSessionID: sessionID,
          engineSessionID,
        });
        let msgs: MessageWithParts[];
        try {
          msgs = unwrap(
            await deps.withTimeout(
              c.session.messages({ sessionID: engineSessionID, limit: requestLimit }),
              12000,
              "session.messages",
            ),
          );
        } catch (error) {
          mark("live recovery session.messages failed", {
            engineSessionID,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          traceSelect("live-recovery:error", {
            durationMs: Math.round((perfNow() - recoveryStartedAt) * 100) / 100,
            engineSessionID,
            error: error instanceof Error ? error.message : safeStringify(error),
            sessionNotFound: deps.isSessionNotFoundError(error),
          });
          if (deps.isSessionNotFoundError(error)) return false;
          deps.addError(error);
          return false;
        }
        mark("live recovery session.messages done", {
          limit: requestLimit,
          count: msgs.length,
          uiSessionID: sessionID,
          engineSessionID,
        });
        traceSelect("live-recovery:messages", {
          durationMs: Math.round((perfNow() - recoveryStartedAt) * 100) / 100,
          count: msgs.length,
          assistantCount: msgs
            .filter((message) => (message.info as { role?: string }).role === "assistant")
            .length,
          limit: requestLimit,
          uiSessionID: sessionID,
          engineSessionID,
        });
        if (abortIfStale("selection changed before live recovery messages applied")) return true;
        deps.setMessagesForSession(sessionID, msgs);
        deps.setStore("todos", sessionID, []);
        markSessionHistoryLoaded(sessionID, msgs.length, requestLimit);
        finishPerf(perfEnabled, "session.select", "complete", startedAt, {
          runId,
          sessionID,
          messageCount: msgs.length,
          todoCount: (deps.store.todos[sessionID] ?? []).length,
        });
        return true;
      };
      mark("client check", {
        hasClient: Boolean(c),
        browseModeOnly: readPolicy.browseModeOnly,
        browseFromDb: readPolicy.browseFromDb,
        configuredBrowseFromDb: readPolicy.configuredBrowseFromDb,
        foreignWorkspace: readPolicy.foreignWorkspace,
        liveRecoveryFromUnavailable: readPolicy.liveRecoveryFromUnavailable,
        sessionID,
        activeWorkspaceId: readPolicy.activeWorkspaceId || null,
        sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
      });
      traceSelect("read-policy", {
        hasClient: Boolean(c),
        browseModeOnly: readPolicy.browseModeOnly,
        browseFromDb: readPolicy.browseFromDb,
        configuredBrowseFromDb: readPolicy.configuredBrowseFromDb,
        foreignWorkspace: readPolicy.foreignWorkspace,
        liveRecoveryFromUnavailable: readPolicy.liveRecoveryFromUnavailable,
        activeWorkspaceId: readPolicy.activeWorkspaceId || null,
        sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
      });
      if (!c || readPolicy.browseFromDb) {
        try {
          const fallback = await loadOfflineTranscriptFallback(!c ? "client unavailable" : "read policy");
          if (fallback.status === "unavailable") {
            const recovered = await recoverUnavailableHistoryFromLive(fallback.history);
            if (!recovered && !abortIfStale("selection changed before unavailable history applied")) {
              markSessionHistoryUnavailable(sessionID, fallback.history);
            }
          }
        } finally {
          deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
            ...prev,
            [sessionID]: false,
          }));
        }
        return;
      }
      mark("calling session.messages", { limit: requestLimit });
      let msgs: MessageWithParts[];
      try {
        msgs = unwrap(
          await deps.withTimeout(c.session.messages({ sessionID, limit: requestLimit }), 12000, "session.messages"),
        );
      } catch (error) {
        mark("session.messages failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (deps.isSessionNotFoundError(error)) {
          const recovered = await loadOfflineTranscriptFallback("session not found");
          if (recovered.status === "applied" || recovered.status === "stale") {
            clearMessageLoadBusy();
            return;
          }
          if (recovered.status === "unavailable") {
            if (!abortIfStale("selection changed before unavailable history applied")) {
              markSessionHistoryUnavailable(sessionID, recovered.history);
            }
            clearMessageLoadBusy();
            return;
          }
        }
        if (!abortIfStale("selection changed before transcript read failure applied")) {
          markSessionHistoryUnavailable(sessionID, unavailableHistory("live-transcript-read-failed"));
        }
        clearMessageLoadBusy();
        deps.addError(error);
        return;
      }
      mark("session.messages done", { limit: requestLimit, count: msgs.length });
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: false,
      }));
      if (abortIfStale("selection changed before messages applied")) return;
      deps.setMessagesForSession(sessionID, msgs);
      markSessionHistoryLoaded(sessionID, msgs.length, requestLimit);

      finishPerf(perfEnabled, "session.select", "complete", startedAt, {
        runId,
        sessionID,
        messageCount: msgs.length,
        todoCount: (deps.store.todos[sessionID] ?? []).length,
      });
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: false,
      }));

      void (async () => {
        try {
          mark("calling session.todo");
          const list = unwrap(await deps.withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
          mark("session.todo done");
          if (abortIfStale("selection changed before todos applied")) return;
          deps.setStore("todos", sessionID, normalizeTodoItems(list));
        } catch (error) {
          mark("session.todo failed/timeout", {
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          if (abortIfStale("selection changed before todo fallback")) return;
          deps.setStore("todos", sessionID, []);
        }

        try {
          mark("calling permission.list");
          await deps.withTimeout(deps.refreshPendingPermissions(), 6000, "permission.list");
          mark("permission.list done");
          if (abortIfStale("selection changed before permissions applied")) return;
        } catch (error) {
          mark("permission.list failed/timeout", {
            error: error instanceof Error ? error.message : safeStringify(error),
          });
        }
      })();
    })();

    selectGuard.register(selectionKey, version, run);
    try {
      await run;
    } finally {
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: false,
      }));
      selectGuard.cleanup(selectionKey, run);
      deps.onSessionLoadComplete?.();
    }
  }

  async function loadEarlierMessages(sessionID: string, chunk = SESSION_MESSAGE_LOAD_CHUNK) {
    if (!sessionID) return;
    if (deps.messageLoadBusyBySession()[sessionID]) return;
    if (deps.messageCompleteBySession()[sessionID]) return;

    const currentLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, deps.messageLimitBySession()[sessionID] ?? 0);
    const nextLimit = currentLimit + Math.max(1, chunk);

    deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
      ...prev,
      [sessionID]: true,
    }));
    try {
      const sessionClient = deps.clientForSession(sessionID);
      const c = sessionClient.client;
      const readPolicy = deps.sessionReadPolicy(sessionID, sessionClient.workspaceId);
      const loadOfflineTranscriptFallback = async () => {
        const observationVersionAtStart = deps.transcriptObservationVersion?.(sessionID) ?? null;
        const history = normalizeHistoryLoadResult(
          await deps.loadOfflineTranscript?.(sessionID, nextLimit, { purpose: "load-earlier" }),
          {
            sessionId: sessionID,
            workspaceId: readPolicy.sessionWorkspaceId || readPolicy.activeWorkspaceId || null,
          },
          "offline-transcript-unavailable",
        );
        if (history.status === "unavailable") {
          return { status: "unavailable" as const, history };
        }
        const observationVersionNow = deps.transcriptObservationVersion?.(sessionID) ?? null;
        if (
          observationVersionAtStart !== null &&
          observationVersionNow !== null &&
          observationVersionNow !== observationVersionAtStart
        ) {
          return { status: "stale" as const };
        }
        const snapshot = retargetSnapshotForUiSession(history.snapshot, sessionID);
        deps.hydrateTranscriptSnapshot(snapshot);
        markSessionHistoryLoaded(sessionID, snapshot.messages.length, snapshot.limit);
        return { status: "applied" as const, history };
      };
      const recoverUnavailableHistoryFromLive = async (
        history: Extract<SessionHistoryLoadResult, { status: "unavailable" }>,
      ) => {
        const engineSessionID = history.scope.opencodeSessionId?.trim() ?? "";
        if (!c || !readPolicy.liveRecoveryFromUnavailable || !engineSessionID) return false;
        try {
          const msgs = unwrap(
            await deps.withTimeout(
              c.session.messages({ sessionID: engineSessionID, limit: nextLimit }),
              12000,
              "session.messages",
            ),
          );
          deps.setMessagesForSession(sessionID, msgs);
          markSessionHistoryLoaded(sessionID, msgs.length, nextLimit);
          return true;
        } catch (error) {
          if (deps.isSessionNotFoundError(error)) return false;
          throw error;
        }
      };
      if (!c || readPolicy.browseFromDb) {
        const fallback = await loadOfflineTranscriptFallback();
        if (fallback.status === "unavailable") {
          const recovered = await recoverUnavailableHistoryFromLive(fallback.history);
          if (!recovered) markSessionHistoryUnavailable(sessionID, fallback.history);
        }
        return;
      }
      try {
        const msgs = unwrap(
          await deps.withTimeout(c.session.messages({ sessionID, limit: nextLimit }), 12000, "session.messages"),
        );
        deps.setMessagesForSession(sessionID, msgs);
        markSessionHistoryLoaded(sessionID, msgs.length, nextLimit);
      } catch (error) {
        if (deps.isSessionNotFoundError(error)) {
          const fallback = await loadOfflineTranscriptFallback();
          if (fallback.status === "applied") return;
          if (fallback.status === "unavailable") {
            markSessionHistoryUnavailable(sessionID, fallback.history);
            return;
          }
        }
        throw error;
      }
    } catch (error) {
      deps.addError(error);
    } finally {
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: false,
      }));
    }
  }

  return {
    sessions,
    selectedSession,
    selectedSessionStatus,
    todos,
    selectedSessionHistoryUnavailable,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    loadSessions,
    renameSession,
    selectSession,
    loadEarlierMessages,
    currentSelectionVersion: () => selectGuard.currentVersion(),
  };
}
