import { reconcile } from "solid-js/store";

import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import {
  DEFAULT_WORKSPACE_SNAPSHOT_CACHE_LIMIT,
  selectWorkspaceSnapshotEvictions,
} from "../lib/workspace-snapshot-cache";
import { pickSessionStatusSnapshot } from "../lib/scoped-session-status";
import type {
  MessageInfo,
  OpencodeEvent,
  PendingPermission,
  PendingQuestion,
  SessionErrorTurn,
  TodoItem,
} from "../types";
import type { TranscriptFreshness } from "./session-transcript-controller";
import type { WorkspaceRouting } from "./workspace-routing";

type SessionWorkspaceCacheStoreState = {
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

type SignalSetter<T> = (value: T | ((prev: T) => T)) => void;

export type WorkspaceSessionCache = {
  workspaceId: string;
  sessions: Session[];
  sessionStatus: Record<string, string>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  messageLimitBySession: Record<string, number>;
  messageCompleteBySession: Record<string, boolean>;
  transcriptFreshnessBySession: Record<string, TranscriptFreshness>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  selectedSessionId: string | null;
  lastUsed: number;
};

export type SessionWorkspaceCacheControllerDeps = {
  store: SessionWorkspaceCacheStoreState;
  setStore: (...args: any[]) => void;
  routing: Pick<WorkspaceRouting, "activeWorkspaceId">;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  workspaceSessionIds: Set<string>;
  messageLimitBySession: () => Record<string, number>;
  setMessageLimitBySession: SignalSetter<Record<string, number>>;
  messageCompleteBySession: () => Record<string, boolean>;
  setMessageCompleteBySession: SignalSetter<Record<string, boolean>>;
  setMessageLoadBusyBySession: SignalSetter<Record<string, boolean>>;
  transcriptFreshnessBySession: () => Record<string, TranscriptFreshness>;
  setTranscriptFreshnessBySession: SignalSetter<Record<string, TranscriptFreshness>>;
};

export type SessionWorkspaceCacheController = {
  saveWorkspaceSnapshot: (workspaceId: string) => void;
  loadWorkspaceSnapshot: (workspaceId: string) => boolean;
  clearWorkspaceSnapshot: (workspaceId: string) => void;
};

export function pickWorkspaceSnapshotRecord<T>(
  record: Record<string, T>,
  keys: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) next[key] = value;
  }
  return next;
}

export function resolveWorkspaceSnapshotSelectedSessionId(
  snapshot: Pick<WorkspaceSessionCache, "sessions" | "selectedSessionId">,
): string | null {
  const selectedSessionId = snapshot.selectedSessionId?.trim() ?? "";
  if (!selectedSessionId) return null;
  return snapshot.sessions.some((session) => session.id === selectedSessionId) ? selectedSessionId : null;
}

export function createSessionWorkspaceCacheController(
  deps: SessionWorkspaceCacheControllerDeps,
): SessionWorkspaceCacheController {
  const perWorkspaceCache = new Map<string, WorkspaceSessionCache>();

  const pruneWorkspaceSnapshotCache = (keepIds: Array<string | null | undefined> = []) => {
    const activeWorkspaceId = deps.routing.activeWorkspaceId()?.trim() ?? "";
    const evictIds = selectWorkspaceSnapshotEvictions(
      Array.from(perWorkspaceCache.values()).map((entry) => ({
        workspaceId: entry.workspaceId,
        lastUsed: entry.lastUsed,
      })),
      DEFAULT_WORKSPACE_SNAPSHOT_CACHE_LIMIT,
      [activeWorkspaceId, ...keepIds],
    );
    for (const id of evictIds) perWorkspaceCache.delete(id);
  };

  const selectedSessionIdForSnapshot = () => {
    const selectedSessionId = deps.selectedSessionId()?.trim() ?? "";
    if (!selectedSessionId) return null;
    return deps.store.sessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : null;
  };

  const saveWorkspaceSnapshot = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    const sessionIds = new Set(deps.store.sessions.map((session) => session.id).filter(Boolean));
    const messagesForSnapshot = pickWorkspaceSnapshotRecord(deps.store.messages, sessionIds);
    const messageIds = new Set<string>();
    for (const messages of Object.values(messagesForSnapshot)) {
      for (const message of messages) {
        if (message.id) messageIds.add(message.id);
      }
    }

    perWorkspaceCache.set(id, {
      workspaceId: id,
      sessions: deps.store.sessions.slice(),
      sessionStatus: pickSessionStatusSnapshot(deps.store.sessionStatus, id, sessionIds),
      sessionErrorTurns: pickWorkspaceSnapshotRecord(deps.store.sessionErrorTurns, sessionIds),
      messages: messagesForSnapshot,
      parts: pickWorkspaceSnapshotRecord(deps.store.parts, messageIds),
      messageLimitBySession: pickWorkspaceSnapshotRecord(deps.messageLimitBySession(), sessionIds),
      messageCompleteBySession: pickWorkspaceSnapshotRecord(deps.messageCompleteBySession(), sessionIds),
      transcriptFreshnessBySession: pickWorkspaceSnapshotRecord(
        deps.transcriptFreshnessBySession(),
        sessionIds,
      ),
      todos: pickWorkspaceSnapshotRecord(deps.store.todos, sessionIds),
      pendingPermissions: deps.store.pendingPermissions.slice(),
      pendingQuestions: deps.store.pendingQuestions.slice(),
      selectedSessionId: selectedSessionIdForSnapshot(),
      lastUsed: Date.now(),
    });
    pruneWorkspaceSnapshotCache([id]);
  };

  const loadWorkspaceSnapshot = (workspaceId: string): boolean => {
    const id = workspaceId.trim();
    if (!id) return false;

    const snapshot = perWorkspaceCache.get(id);
    if (!snapshot) return false;

    deps.setStore(
      reconcile(
        {
          sessions: snapshot.sessions,
          sessionStatus: snapshot.sessionStatus,
          sessionErrorTurns: snapshot.sessionErrorTurns,
          messages: snapshot.messages,
          parts: snapshot.parts,
          commandDisplayByMessageID: {},
          todos: snapshot.todos,
          pendingPermissions: snapshot.pendingPermissions,
          pendingQuestions: snapshot.pendingQuestions,
          events: [],
        },
        { merge: false },
      ),
    );
    deps.setMessageLimitBySession({ ...(snapshot.messageLimitBySession ?? {}) });
    deps.setMessageCompleteBySession({ ...(snapshot.messageCompleteBySession ?? {}) });
    deps.setMessageLoadBusyBySession({});
    deps.setTranscriptFreshnessBySession({ ...(snapshot.transcriptFreshnessBySession ?? {}) });

    deps.workspaceSessionIds.clear();
    for (const session of snapshot.sessions) {
      if (session.id) deps.workspaceSessionIds.add(session.id);
    }

    const selectedSessionId = resolveWorkspaceSnapshotSelectedSessionId(snapshot);
    deps.setSelectedSessionId(selectedSessionId);
    snapshot.selectedSessionId = selectedSessionId;
    snapshot.lastUsed = Date.now();
    pruneWorkspaceSnapshotCache([id]);
    return true;
  };

  const clearWorkspaceSnapshot = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    perWorkspaceCache.delete(id);
  };

  return {
    saveWorkspaceSnapshot,
    loadWorkspaceSnapshot,
    clearWorkspaceSnapshot,
  };
}
