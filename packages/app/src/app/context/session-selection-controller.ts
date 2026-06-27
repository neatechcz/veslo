import { reconcile } from "solid-js/store";

import type { Session } from "@opencode-ai/sdk/v2/client";

import type { VesloSessionTranscriptSnapshot } from "../lib/veslo-server";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
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
import { sortSessionsByActivity, upsertSession } from "./session-store-model";
import type { WorkspaceRouting } from "./workspace-routing";
import {
  INITIAL_SESSION_MESSAGE_LIMIT,
  SESSION_MESSAGE_LOAD_CHUNK,
} from "./session-transcript-controller";
import { createSelectSessionGuard } from "./select-session-guard";

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
  sessionWorkspaceId: string;
};

type ConversationReader = {
  listConversations: (
    workspaceId: string,
    directory?: string,
    options?: { sync?: boolean },
  ) => Promise<{ items: Session[]; source?: "sqlite" | "unavailable" }>;
};

export type SessionSelectionControllerDeps = {
  store: SelectionStoreState;
  setStore: (...args: any[]) => void;
  routing: WorkspaceRouting;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  selectSessionScopeKey?: (sessionID: string) => string;
  directoryQueryPathMode?: () => DirectoryQueryPathMode;
  conversationReader?: () => ConversationReader | null;
  loadOfflineTranscript?: (sessionID: string, limit: number) => Promise<VesloSessionTranscriptSnapshot | null>;
  shouldBrowseSessionFromDb?: (sessionID: string) => boolean;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  onSessionLoadComplete?: () => void;
  sessionDebug: (label: string, payload?: unknown) => void;
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
  messageLimitBySession: () => Record<string, number>;
  setMessageLimitBySession: (value: any) => void;
  messageCompleteBySession: () => Record<string, boolean>;
  setMessageCompleteBySession: (value: any) => void;
  messageLoadBusyBySession: () => Record<string, boolean>;
  setMessageLoadBusyBySession: (value: any) => void;
  refreshPendingPermissions: () => Promise<void>;
};

export function isSessionNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : safeStringify(error);
  return /Session not found|NotFoundError|status\W*404|\b404\b/i.test(message);
}

export function createSessionSelectionController(deps: SessionSelectionControllerDeps) {
  let selectRunCounter = 0;
  const selectGuard = createSelectSessionGuard();

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
  const selectedSessionHasEarlierMessages = () => {
    const id = deps.selectedSessionId();
    if (!id) return false;
    return !deps.messageCompleteBySession()[id];
  };
  const selectedSessionLoadingEarlierMessages = () => {
    const id = deps.selectedSessionId();
    if (!id) return false;
    return Boolean(deps.messageLoadBusyBySession()[id]);
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

  async function selectSession(sessionID: string) {
    const perfEnabled = deps.developerMode();
    deps.setSelectedSessionId(sessionID);
    deps.setError(null);
    const selectionKey = deps.selectSessionScopeKey?.(sessionID)?.trim() || sessionID;

    const existing = selectGuard.tryDedup(selectionKey);
    if (existing) {
      recordPerfLog(perfEnabled, "session.select", "dedupe join", {
        sessionID,
        selectionKey,
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
        selectionKey,
        elapsedMs,
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

    const run = (async () => {
      mark("start");

      const existingLimit = deps.messageLimitBySession()[sessionID] ?? 0;
      const requestLimit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, existingLimit);
      deps.setMessageLoadBusyBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: true,
      }));
      const sessionClient = deps.clientForSession(sessionID);
      const c = sessionClient.client;
      const readPolicy = deps.sessionReadPolicy(sessionID, sessionClient.workspaceId);
      const loadOfflineTranscriptFallback = async (reason: string) => {
        mark("calling offline transcript fallback", {
          limit: requestLimit,
          reason,
          activeWorkspaceId: readPolicy.activeWorkspaceId || null,
          sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
        });
        let snapshot: VesloSessionTranscriptSnapshot | null = null;
        try {
          snapshot = (await deps.loadOfflineTranscript?.(sessionID, requestLimit)) ?? null;
        } catch (error) {
          deps.addError(error);
          mark("offline transcript fallback failed", {
            reason,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
          return false;
        }
        if (abortIfStale("selection changed before offline transcript applied")) return true;
        if (snapshot) {
          deps.hydrateTranscriptSnapshot(snapshot);
          deps.setStore("todos", sessionID, []);
          mark("offline transcript fallback done", {
            count: snapshot.messages.length,
            limit: requestLimit,
            reason,
          });
          return true;
        }
        mark("offline transcript fallback unavailable", { reason });
        return false;
      };
      mark("client check", {
        hasClient: Boolean(c),
        browseModeOnly: readPolicy.browseModeOnly,
        browseFromDb: readPolicy.browseFromDb,
        configuredBrowseFromDb: readPolicy.configuredBrowseFromDb,
        foreignWorkspace: readPolicy.foreignWorkspace,
        sessionID,
        activeWorkspaceId: readPolicy.activeWorkspaceId || null,
        sessionWorkspaceId: readPolicy.sessionWorkspaceId || null,
      });
      if (!c || readPolicy.browseFromDb) {
        try {
          await loadOfflineTranscriptFallback(!c ? "client unavailable" : "read policy");
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
          if (recovered) return;
        }
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
      deps.setMessageLimitBySession((prev: Record<string, number>) => ({
        ...prev,
        [sessionID]: requestLimit,
      }));
      deps.setMessageCompleteBySession((prev: Record<string, boolean>) => ({
        ...prev,
        [sessionID]: msgs.length < requestLimit,
      }));

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
        const snapshot = (await deps.loadOfflineTranscript?.(sessionID, nextLimit)) ?? null;
        if (!snapshot) return false;
        deps.hydrateTranscriptSnapshot(snapshot);
        return true;
      };
      if (!c || readPolicy.browseFromDb) {
        await loadOfflineTranscriptFallback();
        return;
      }
      try {
        const msgs = unwrap(
          await deps.withTimeout(c.session.messages({ sessionID, limit: nextLimit }), 12000, "session.messages"),
        );
        deps.setMessagesForSession(sessionID, msgs);
        deps.setMessageLimitBySession((prev: Record<string, number>) => ({
          ...prev,
          [sessionID]: nextLimit,
        }));
        deps.setMessageCompleteBySession((prev: Record<string, boolean>) => ({
          ...prev,
          [sessionID]: msgs.length < nextLimit,
        }));
      } catch (error) {
        if (deps.isSessionNotFoundError(error) && await loadOfflineTranscriptFallback()) {
          return;
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
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    loadSessions,
    renameSession,
    selectSession,
    loadEarlierMessages,
  };
}
