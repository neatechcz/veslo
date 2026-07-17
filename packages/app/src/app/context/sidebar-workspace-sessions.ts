import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";

import { promoteStoredProjectOrderKey } from "../components/session/workspace-session-list-prefs";
import { createClient, unwrap, type OpencodeAuth } from "../lib/opencode";
import { recordPerfLog } from "../lib/perf-log";
import {
  findSidebarSessionItemMergeIndex,
  sidebarSessionIdentityKey,
} from "../lib/sidebar-session-identity";
import {
  shouldPreserveSidebarRowsOnRead,
  shouldSyncSidebarFromSessionStore,
} from "../lib/sidebar-session-sync-guard";
import { deriveSidebarRowsFromSessionStore } from "../lib/sidebar-session-store-sync";
import {
  parseVesloWorkspaceIdFromUrl,
  normalizeVesloServerUrl,
} from "../lib/veslo-server";
import { partitionVesloUtilitySessions } from "../lib/veslo-utility-session";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  deriveSidebarHasMore,
  expandSidebarSessionSliceWithAncestors,
  initialSidebarSessionLimit,
  nextSidebarSessionLimit,
} from "../pages/sidebar-session-pagination";
import type {
  SidebarSessionItem,
  WorkspaceSessionGroup,
} from "../types";
import {
  type DirectoryQueryPathMode,
  directoryQueryPathVariants,
  normalizeDirectoryPath,
  normalizeDirectoryQueryPath,
  safeStringify,
  sessionDirectoryMatchesRoot,
} from "../utils";
import type { WorkspaceRouting } from "./workspace-routing";
import type { WorkspaceStore } from "./workspace";

type SidebarWorkspaceSessionsStatus = WorkspaceSessionGroup["status"];
type SidebarSessionsByWorkspaceId = Record<string, SidebarSessionItem[]>;
type SidebarStatusByWorkspaceId = Record<string, SidebarWorkspaceSessionsStatus>;

const sidebarReadUnavailableMessage = (reason: string) =>
  `Sidebar conversation read unavailable: ${reason}`;

type ConversationReadResult = {
  items: Session[];
  source?: "sqlite" | "unavailable";
};

type SidebarWorkspaceSessionsOptions = {
  workspaceStore: WorkspaceStore;
  workspaceRouting: WorkspaceRouting;
  activeWorkspaceRuntimeReady: () => boolean;
  directoryQueryPathMode?: () => DirectoryQueryPathMode;
  activeSendTraceId?: () => string | null;
  developerMode: () => boolean;
  sessions: () => Session[];
  sessionDirectoryOverrideById: () => Record<string, string>;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  applySessionDirectoryOverride: <T extends Session | SidebarSessionItem>(session: T) => T;
  applyPendingInitialSessionTitle: <T extends Session | SidebarSessionItem>(session: T) => T;
  listConversationsFromVesloReadApi: (
    workspaceId: string,
    directory?: string,
    options?: { sync?: boolean },
  ) => Promise<ConversationReadResult>;
  shouldSyncConversationRead?: (workspaceId: string) => boolean;
  allowLiveWorkspaceSessionList?: (workspaceId: string) => boolean;
  backfillConversationsToVesloReadApi?: (
    workspaceId: string,
    directory: string,
    sessions: Session[],
  ) => Promise<void>;
  reportError: (error: unknown, scope: string) => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

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

const normalizeParentSessionId = (value: string | null | undefined) => value?.trim() ?? "";

const hydrateSidebarSessionAncestors = async (
  sessions: Session[],
  resolveSessionById: (sessionId: string) => Promise<Session>,
) => {
  const expanded = new Map(sessions.map((session) => [session.id, session] as const));
  const pendingParentIds = sessions
    .map((session) => normalizeParentSessionId(session.parentID))
    .filter((parentId) => parentId && !expanded.has(parentId));
  const queuedParentIds = new Set(pendingParentIds);

  while (pendingParentIds.length > 0) {
    const parentId = pendingParentIds.shift();
    if (!parentId) continue;
    queuedParentIds.delete(parentId);
    if (expanded.has(parentId)) continue;
    try {
      const fetched = await resolveSessionById(parentId);
      expanded.set(fetched.id, fetched);
      const nextParentId = normalizeParentSessionId(fetched.parentID);
      if (nextParentId && !expanded.has(nextParentId) && !queuedParentIds.has(nextParentId)) {
        pendingParentIds.push(nextParentId);
        queuedParentIds.add(nextParentId);
      }
    } catch {
      // ignore stale/missing ancestors; the child row will remain visible on its own
    }
  }

  return Array.from(expanded.values());
};

const sidebarSessionItemsEqual = (left: SidebarSessionItem[], right: SidebarSessionItem[]) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left.at(index);
    const b = right.at(index);
    if (!a || !b) return false;
    if (
      a.id !== b.id ||
      a.title !== b.title ||
      a.slug !== b.slug ||
      a.parentID !== b.parentID ||
      a.directory !== b.directory ||
      a.conversationId !== b.conversationId ||
      a.opencodeSessionId !== b.opencodeSessionId ||
      a.parentConversationId !== b.parentConversationId ||
      a.branchId !== b.branchId ||
      a.pendingSessionInstanceId !== b.pendingSessionInstanceId ||
      (a.time?.created ?? 0) !== (b.time?.created ?? 0)
    ) {
      return false;
    }
  }
  return true;
};

const sidebarItemActivity = (item: SidebarSessionItem) =>
  item.time?.updated ?? item.time?.created ?? 0;

const latestOptionalTime = (
  left: number | null | undefined,
  right: number | null | undefined,
) => {
  const leftValue = Number.isFinite(left ?? NaN) ? Math.floor(left as number) : null;
  const rightValue = Number.isFinite(right ?? NaN) ? Math.floor(right as number) : null;
  if (leftValue === null) return rightValue;
  if (rightValue === null) return leftValue;
  return Math.max(leftValue, rightValue);
};

const mergeSidebarSessionItem = (
  existing: SidebarSessionItem,
  incoming: SidebarSessionItem,
) => {
  const created = latestOptionalTime(existing.time?.created, incoming.time?.created);
  const updated = latestOptionalTime(existing.time?.updated, incoming.time?.updated);
  return {
    ...existing,
    ...incoming,
    title: incoming.title?.trim() ? incoming.title : existing.title,
    slug: incoming.slug ?? existing.slug,
    parentID: incoming.parentID ?? existing.parentID,
    directory: incoming.directory ?? existing.directory,
    conversationId: incoming.conversationId ?? existing.conversationId,
    opencodeSessionId: incoming.opencodeSessionId ?? existing.opencodeSessionId,
    parentConversationId: incoming.parentConversationId ?? existing.parentConversationId,
    branchId: incoming.branchId ?? existing.branchId,
    pendingSessionInstanceId: incoming.pendingSessionInstanceId ?? existing.pendingSessionInstanceId,
    ...(created !== null || updated !== null
      ? { time: { created, updated } }
      : {}),
  };
};

export const mergeSidebarSessionItemsByActivity = (
  primary: SidebarSessionItem[],
  secondary: SidebarSessionItem[],
): SidebarSessionItem[] => {
  const items: SidebarSessionItem[] = [];
  const upsert = (item: SidebarSessionItem) => {
    const id = item.id.trim();
    if (!id) return;
    const existingIndex = findSidebarSessionItemMergeIndex(items, item);
    if (existingIndex === -1) {
      items.push(item);
      return;
    }
    const existing = items[existingIndex];
    items[existingIndex] = mergeSidebarSessionItem(existing, item);
  };

  secondary.forEach(upsert);
  primary.forEach(upsert);

  return items.sort((a, b) => {
    const delta = sidebarItemActivity(b) - sidebarItemActivity(a);
    if (delta !== 0) return delta;
    return sidebarSessionIdentityKey(a).localeCompare(sidebarSessionIdentityKey(b));
  });
};

export const removeSidebarSessionFromWorkspaceRows = (
  current: SidebarSessionsByWorkspaceId,
  workspaceId: string,
  sessionId: string,
): SidebarSessionsByWorkspaceId => {
  const id = workspaceId.trim();
  const targetSessionId = sessionId.trim();
  if (!id || !targetSessionId) return current;
  const currentRows = current[id] ?? [];
  const nextRows = currentRows.filter((session) => session.id !== targetSessionId);
  if (nextRows.length === currentRows.length) return current;
  return { ...current, [id]: nextRows };
};

export const replaceSidebarWorkspaceSessionRows = (input: {
  sessionsByWorkspaceId: SidebarSessionsByWorkspaceId;
  statusByWorkspaceId: SidebarStatusByWorkspaceId;
  workspaceId: string;
  items: SidebarSessionItem[];
}) => {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    return {
      sessionsByWorkspaceId: input.sessionsByWorkspaceId,
      statusByWorkspaceId: input.statusByWorkspaceId,
    };
  }
  return {
    sessionsByWorkspaceId: { ...input.sessionsByWorkspaceId, [workspaceId]: input.items },
    statusByWorkspaceId: { ...input.statusByWorkspaceId, [workspaceId]: "ready" as const },
  };
};

export const prependSidebarSessionToWorkspaceRows = (
  current: SidebarSessionsByWorkspaceId,
  workspaceId: string,
  item: SidebarSessionItem,
): SidebarSessionsByWorkspaceId => {
  const id = workspaceId.trim();
  const sessionId = item.id.trim();
  if (!id || !sessionId) return current;
  const currentRows = current[id] ?? [];
  if (currentRows.some((session) => session.id === sessionId)) return current;
  return { ...current, [id]: [item, ...currentRows] };
};

export const materializePendingSidebarSessionRows = (input: {
  current: SidebarSessionsByWorkspaceId;
  workspaceId: string;
  pendingSessionInstanceId?: string | null;
  item: SidebarSessionItem;
}): SidebarSessionsByWorkspaceId => {
  const id = input.workspaceId.trim();
  const sessionId = input.item.id.trim();
  if (!id || !sessionId) return input.current;
  const pendingSessionInstanceId =
    input.pendingSessionInstanceId?.trim() || input.item.pendingSessionInstanceId?.trim() || "";
  const currentRows = input.current[id] ?? [];
  const nextRows = currentRows.filter((session) => {
    if (session.id === sessionId) return false;
    if (!pendingSessionInstanceId) return true;
    return session.id !== pendingSessionInstanceId && session.pendingSessionInstanceId !== pendingSessionInstanceId;
  });
  return { ...input.current, [id]: [input.item, ...nextRows] };
};

export const moveSidebarSessionBetweenWorkspaceRows = (input: {
  current: SidebarSessionsByWorkspaceId;
  sourceWorkspaceId?: string | null;
  targetWorkspaceId: string;
  item: SidebarSessionItem;
}): SidebarSessionsByWorkspaceId => {
  const sourceWorkspaceId = input.sourceWorkspaceId?.trim() ?? "";
  const targetWorkspaceId = input.targetWorkspaceId.trim();
  const sessionId = input.item.id.trim();
  if (!targetWorkspaceId || !sessionId) return input.current;
  const sourceRows = sourceWorkspaceId
    ? (input.current[sourceWorkspaceId] ?? []).filter((session) => session.id !== sessionId)
    : undefined;
  const targetRows = (input.current[targetWorkspaceId] ?? []).filter((session) => session.id !== sessionId);
  return {
    ...input.current,
    ...(sourceWorkspaceId ? { [sourceWorkspaceId]: sourceRows ?? [] } : {}),
    [targetWorkspaceId]: [input.item, ...targetRows],
  };
};

export const ensureSidebarSessionInWorkspaceRows = (
  current: SidebarSessionsByWorkspaceId,
  workspaceId: string,
  item: SidebarSessionItem,
): SidebarSessionsByWorkspaceId => prependSidebarSessionToWorkspaceRows(current, workspaceId, item);

export const countFreshlyCreatedSessionsInSidebarRows = (
  sessions: Session[],
  rows: SidebarSessionItem[],
): number => {
  const freshIds = new Set<string>();
  for (const row of rows) {
    if (!row.pendingSessionInstanceId?.trim()) continue;
    for (const value of [row.id, row.conversationId, row.opencodeSessionId]) {
      const id = value?.trim() ?? "";
      if (id) freshIds.add(id);
    }
  }
  if (freshIds.size === 0) return 0;
  let count = 0;
  for (const session of sessions) {
    const conversationId = (session as { conversationId?: string | null }).conversationId?.trim() ?? "";
    const opencodeSessionId = (session as { opencodeSessionId?: string | null }).opencodeSessionId?.trim() ?? "";
    if (freshIds.has(session.id) || (conversationId && freshIds.has(conversationId)) || (opencodeSessionId && freshIds.has(opencodeSessionId))) {
      count += 1;
    }
  }
  return count;
};

export function createSidebarWorkspaceSessions(options: SidebarWorkspaceSessionsOptions) {
  const [sidebarSessionsByWorkspaceId, setSidebarSessionsByWorkspaceId] = createSignal<
    Record<string, SidebarSessionItem[]>
  >({});
  const [sidebarSessionStatusByWorkspaceId, setSidebarSessionStatusByWorkspaceId] = createSignal<
    Record<string, SidebarWorkspaceSessionsStatus>
  >({});
  const [sidebarSessionErrorByWorkspaceId, setSidebarSessionErrorByWorkspaceId] = createSignal<
    Record<string, string | null>
  >({});
  const [sidebarSessionLimitByWorkspaceId, setSidebarSessionLimitByWorkspaceId] = createSignal<
    Record<string, number>
  >({});
  const [sidebarSessionHasMoreByWorkspaceId, setSidebarSessionHasMoreByWorkspaceId] = createSignal<
    Record<string, boolean>
  >({});
  const [sidebarSessionLoadingMoreByWorkspaceId, setSidebarSessionLoadingMoreByWorkspaceId] = createSignal<
    Record<string, boolean>
  >({});

  const pruneSidebarSessionState = (workspaceIds: Set<string>) => {
    setSidebarSessionsByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarSessionItem[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = list;
      }
      return changed ? next : prev;
    });
    setSidebarSessionStatusByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarWorkspaceSessionsStatus> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = status;
      }
      return changed ? next : prev;
    });
    setSidebarSessionErrorByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, error] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = error;
      }
      return changed ? next : prev;
    });
    setSidebarSessionLimitByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, limit] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = limit;
      }
      return changed ? next : prev;
    });
    setSidebarSessionHasMoreByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, hasMore] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = hasMore;
      }
      return changed ? next : prev;
    });
    setSidebarSessionLoadingMoreByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, loading] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = loading;
      }
      return changed ? next : prev;
    });
  };

  const clearStaleWorkspaceSessionError = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setSidebarSessionStatusByWorkspaceId((prev) => {
      if (prev[id] !== "error") return prev;
      const next = { ...prev };
      next[id] = "idle" as const;
      return next;
    });
    setSidebarSessionErrorByWorkspaceId((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      next[id] = null;
      return next;
    });
  };

  // Apply a read-API list result without ever destroying browsable rows. An
  // unavailable read (server unreachable, workspace not yet registered, sandbox
  // path mismatch) or a transient empty result must not wipe rows the user can
  // still open — that is the "conversation disappeared and I can't get back"
  // symptom. Only write rows when we actually read something, or when the
  // workspace genuinely has no rows yet.
  const applyWorkspaceSidebarReadResult = (input: {
    workspaceId: string;
    items: SidebarSessionItem[];
    available: boolean;
    reason?: string;
  }) => {
    const id = input.workspaceId.trim();
    if (!id) return;
    const existingRows = untrack(() => sidebarSessionsByWorkspaceId()[id] ?? []);
    const preserveExisting = shouldPreserveSidebarRowsOnRead({
      available: input.available,
      incomingCount: input.items.length,
      existingCount: existingRows.length,
    });
    recordPerfLog(options.developerMode(), "workspace.sidebar", "rows-read-result", {
      workspaceId: id,
      available: input.available,
      preserved: preserveExisting,
      previousCount: existingRows.length,
      incomingCount: input.items.length,
      nextCount: preserveExisting ? existingRows.length : input.items.length,
    });
    if (!preserveExisting) {
      setSidebarSessionsByWorkspaceId((prev) => ({ ...prev, [id]: input.items }));
    }
    if (input.available) {
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" as const }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));
    } else {
      const reason = input.reason?.trim() || "unavailable";
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" as const }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({
        ...prev,
        [id]: sidebarReadUnavailableMessage(reason),
      }));
    }
  };

  const isSidebarRuntimeUnavailableError = (message: string) =>
    /engine_not_running|Failed to fetch|error sending request for url|Request timed out|ECONN|connection refused|upstream status (?:401|404|502|503)|status (?:401|404|502|503)|Invalid bearer token|unauthorized/i.test(
      message,
    );

  const listSidebarWorkspaceSessionsFromReadApi = async (
    workspaceId: string,
    directory: string,
    readOptions?: { sync?: boolean },
  ) => {
    const sync = readOptions?.sync ?? (options.shouldSyncConversationRead?.(workspaceId) === true);
    const result = await options.listConversationsFromVesloReadApi(workspaceId, directory, { sync });
    const { visible: items } = partitionVesloUtilitySessions(
      result.items.map(options.applyPendingInitialSessionTitle),
    );
    return {
      items,
      source: result.source ?? "unknown",
      available: result.source !== "unavailable",
      sync,
    };
  };

  const refreshSidebarWorkspaceSessionsFromReadApi = async (
    workspaceId: string,
    directory: string,
    reason: string,
    readOptions?: { sync?: boolean },
  ) => {
    const result = await listSidebarWorkspaceSessionsFromReadApi(workspaceId, directory, readOptions);
    applyWorkspaceSidebarReadResult({
      workspaceId,
      items: result.items,
      available: result.available,
      reason,
    });
    if (result.available || result.items.length > 0) {
      setSidebarSessionHasMoreByWorkspaceId((prev) => ({ ...prev, [workspaceId]: false }));
    }
    options.wsDebug("sidebar:conversation-read", {
      id: workspaceId,
      reason,
      source: result.source,
      sync: result.sync,
      count: result.items.length,
    });
    return result;
  };

  const resolveSidebarClientConfig = (workspaceId: string) => {
    const workspace = options.workspaceStore.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return null;

    if (workspace.workspaceType === "local") {
      const directory = workspace.path?.trim() ?? "";
      const entry = options.workspaceRouting.entry(workspace.id);
      const isActiveWorkspace = workspace.id === options.workspaceStore.activeWorkspaceId().trim();
      const activeInfo = isActiveWorkspace ? options.workspaceStore.engine() : null;
      const activeInfoDirectory = activeInfo?.projectDir?.trim() ?? "";
      const info = activeInfo && activeInfoDirectory === directory ? activeInfo : null;
      const baseUrl = entry?.baseUrl?.trim() || info?.baseUrl?.trim() || "";
      const username = info?.opencodeUsername?.trim() ?? "";
      const password = info?.opencodePassword?.trim() ?? "";
      const activeEngineAuth: OpencodeAuth | undefined = username && password ? { username, password } : undefined;
      const auth = entry?.auth ?? activeEngineAuth;
      return {
        baseUrl,
        directory,
        auth,
      };
    }

    const baseUrl = workspace.baseUrl?.trim() ?? "";
    const directory = workspace.directory?.trim() ?? "";
    if (workspace.remoteType === "veslo") {
      const token = workspace.vesloToken?.trim() ?? "";
      const auth: OpencodeAuth | undefined = token ? { token, mode: "veslo" } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }
    return {
      baseUrl,
      directory,
      auth: undefined as OpencodeAuth | undefined,
    };
  };

  const sidebarRefreshSeqByWorkspaceId: Record<string, number> = {};
  const deferredSidebarRefreshTimers = new Map<string, number>();
  onCleanup(() => {
    for (const timer of deferredSidebarRefreshTimers.values()) {
      window.clearTimeout(timer);
    }
    deferredSidebarRefreshTimers.clear();
  });
  const scheduleDeferredSidebarRefresh = (workspaceId: string, activeSendTraceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    if (deferredSidebarRefreshTimers.has(id)) return;
    recordPerfLog(options.developerMode(), "sidebar.sessions", "refresh-defer-active-send", {
      workspaceId: id,
      activeSendTraceId,
    });
    const timer = window.setTimeout(() => {
      deferredSidebarRefreshTimers.delete(id);
      const nextActiveSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
      if (nextActiveSendTraceId) {
        scheduleDeferredSidebarRefresh(id, nextActiveSendTraceId);
        return;
      }
      void refreshSidebarWorkspaceSessions(id)
        .catch(e => options.reportError(e, "sidebar.refreshDeferred"));
    }, 750);
    deferredSidebarRefreshTimers.set(id, timer);
  };

  const markSidebarRefreshUnavailable = (id: string, reason: string) => {
    setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" as const }));
    setSidebarSessionErrorByWorkspaceId((prev) => ({
      ...prev,
      [id]: sidebarReadUnavailableMessage(reason),
    }));
    setSidebarSessionLoadingMoreByWorkspaceId((prev) => ({ ...prev, [id]: false }));
    options.wsDebug("sidebar:conversation-read:unavailable", {
      id,
      reason,
      existingCount: untrack(() => sidebarSessionsByWorkspaceId()[id]?.length ?? 0),
    });
  };

  const skipLiveSidebarSessionList = (id: string, reason: string) => {
    const existingCount = untrack(() => sidebarSessionsByWorkspaceId()[id]?.length ?? 0);
    setSidebarSessionStatusByWorkspaceId((prev) =>
      prev[id] === "ready" ? prev : { ...prev, [id]: "ready" as const },
    );
    setSidebarSessionErrorByWorkspaceId((prev) =>
      prev[id] == null ? prev : { ...prev, [id]: null },
    );
    setSidebarSessionLoadingMoreByWorkspaceId((prev) =>
      prev[id] === false ? prev : { ...prev, [id]: false },
    );
    options.wsDebug("sidebar:live-session-list:skipped", {
      id,
      reason,
      existingCount,
    });
  };

  const refreshSidebarWorkspaceSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    const config = resolveSidebarClientConfig(id);
    if (!config) return;
    const workspace = options.workspaceStore.workspaces().find((w) => w.id === id) ?? null;
    const hostReadDirectory = workspace?.workspaceType === "local" ? workspace.path?.trim() ?? "" : "";
    const refreshFromHostReadApi = async (
      reason: string,
      readOptions?: { sync?: boolean },
    ) => {
      if (!hostReadDirectory) return null;
      try {
        const result = await refreshSidebarWorkspaceSessionsFromReadApi(id, hostReadDirectory, reason, readOptions);
        if (result.available) return result;
      } catch (e) {
        options.wsDebug("sidebar:conversation-read:host-first-error", {
          id,
          reason,
          error: e instanceof Error ? e.message : safeStringify(e),
        });
      }
      return null;
    };

    const activeSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
    if (activeSendTraceId) {
      scheduleDeferredSidebarRefresh(id, activeSendTraceId);
      await refreshFromHostReadApi("active-send-host-read", { sync: false });
      return;
    }

    const hostFirstResult = await refreshFromHostReadApi("host-first");
    if (hostFirstResult) return;

    const activeWorkspaceId = options.workspaceStore.activeWorkspaceId().trim();
    if (hostReadDirectory && options.allowLiveWorkspaceSessionList?.(id) !== true) {
      skipLiveSidebarSessionList(id, "live-session-list-not-allowed");
      return;
    }

    if (activeWorkspaceId === id && !options.activeWorkspaceRuntimeReady()) {
      markSidebarRefreshUnavailable(id, "active-runtime-not-ready");
      return;
    }

    if (!config.baseUrl) {
      markSidebarRefreshUnavailable(id, "no-engine-base-url");
      return;
    }

    sidebarRefreshSeqByWorkspaceId[id] = (sidebarRefreshSeqByWorkspaceId[id] ?? 0) + 1;
    const seq = sidebarRefreshSeqByWorkspaceId[id];

    setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "loading" }));
    setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));

    try {
      const start = Date.now();
      let directory = config.directory;
      let c = createClient(config.baseUrl, directory || undefined, config.auth);

      if (!directory) {
        try {
          const pathInfo = unwrap(await c.path.get());
          const discovered = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
          if (discovered) {
            directory = discovered;
            c = createClient(config.baseUrl, directory, config.auth);
          }
        } catch {
          // ignore
        }
      }

      const queryDirectory = normalizeDirectoryQueryPath(directory) || undefined;
      const queryDirectories = directoryQueryPathVariants(directory, {
        mode: options.directoryQueryPathMode?.() ?? "auto",
      });
      const requestLimit = sidebarSessionLimitByWorkspaceId()[id] ?? initialSidebarSessionLimit();
      const root = normalizeDirectoryPath(directory);
      const listWorkspaceSessions = async (limit: number) => {
        const candidates: Array<string | undefined> = queryDirectories.length > 0 ? queryDirectories : [undefined];
        const mergedById = new Map<string, Session>();
        const usedQueryDirectories: Array<string | null> = [];
        for (const candidate of candidates) {
          usedQueryDirectories.push(candidate ?? null);
          const fetchedList = unwrap(
            await c.session.list({ directory: candidate, limit }),
          );
          for (const session of fetchedList) {
            mergedById.set(session.id, session);
          }
        }
        const list = Array.from(mergedById.values());
        options.wsDebug("sidebar:list", {
          id,
          baseUrl: config.baseUrl,
          directory: directory || null,
          queryDirectory: usedQueryDirectories[0] ?? null,
          queryDirectories: usedQueryDirectories,
          queryDirectoryFallbacks: Math.max(0, candidates.length - 1),
          count: list.length,
          limit,
          ms: Date.now() - start,
        });

        const filtered = root
          ? list
            .map((session) => options.applySessionDirectoryOverride(session))
            .filter((session) => sessionDirectoryMatchesRoot(options.resolveSessionDirectory(session), root))
          : list.map((session) => options.applySessionDirectoryOverride(session));

        const overrideIds = root
          ? Object.entries(options.sessionDirectoryOverrideById())
            .filter(([, directory]) => sessionDirectoryMatchesRoot(directory, root))
            .map(([sessionID]) => sessionID)
          : [];
        const merged = new Map(filtered.map((session) => [session.id, session] as const));
        for (const sessionID of overrideIds) {
          if (merged.has(sessionID)) continue;
          try {
            const fetched = options.applySessionDirectoryOverride(
              unwrap(await c.session.get({ sessionID })),
            );
            merged.set(sessionID, fetched);
          } catch {
            // ignore stale local overrides
          }
        }

        return {
          rawCount: list.length,
          sessions: Array.from(merged.values()),
        };
      };

      let fetchLimit = requestLimit;
      let rawCount = 0;
      let visibleSessions: Session[] = [];
      for (let pass = 0; pass < 4; pass += 1) {
        const result = await listWorkspaceSessions(fetchLimit);
        if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
        rawCount = result.rawCount;

        const hydrated = await hydrateSidebarSessionAncestors(
          result.sessions,
          async (sessionId) => options.applySessionDirectoryOverride(
            unwrap(await c.session.get({ sessionID: sessionId })),
          ),
        );
        if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;

        const sorted = sortSessionsByActivity(hydrated);
        const { visible, utility } = partitionVesloUtilitySessions(sorted);
        visibleSessions = visible;
        if (utility.length === 0 || visible.length >= requestLimit) break;
        fetchLimit += utility.length;
      }

      const visible = expandSidebarSessionSliceWithAncestors(visibleSessions, requestLimit);
      if (queryDirectory && visibleSessions.length > 0) {
        void options.backfillConversationsToVesloReadApi?.(id, queryDirectory, visibleSessions)
          .catch((error) => {
            options.wsDebug("sidebar:conversation-read:backfill-error", {
              id,
              error: error instanceof Error ? error.message : safeStringify(error),
            });
          });
      }
      const items: SidebarSessionItem[] = visible.map((session) => {
        const displaySession = options.applyPendingInitialSessionTitle(session);
        return {
          id: displaySession.id,
          title: displaySession.title,
          slug: displaySession.slug,
          parentID: displaySession.parentID,
          time: displaySession.time,
          directory: displaySession.directory,
        };
      });
      const workspace = options.workspaceStore.workspaces().find((w) => w.id === id) ?? null;
      const readDirectory = workspace?.workspaceType === "local"
        ? workspace.path?.trim() || directory || config.directory
        : "";
      let nextItems = items;
      let usedReadApiUnion = false;
      if (readDirectory) {
        try {
          const readResult = await listSidebarWorkspaceSessionsFromReadApi(id, readDirectory);
          if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
          if (readResult.items.length > 0) {
            nextItems = mergeSidebarSessionItemsByActivity(items, readResult.items);
            usedReadApiUnion = true;
          } else if (items.length === 0) {
            applyWorkspaceSidebarReadResult({
              workspaceId: id,
              items: readResult.items,
              available: readResult.available,
              reason: "live-empty",
            });
            if (readResult.available || readResult.items.length > 0) {
              setSidebarSessionHasMoreByWorkspaceId((prev) => ({ ...prev, [id]: false }));
            }
            options.wsDebug("sidebar:conversation-read", {
              id,
              reason: "live-empty",
              source: readResult.source,
              sync: readResult.sync,
              count: readResult.items.length,
              liveCount: items.length,
              mergedCount: readResult.items.length,
            });
            return;
          }
          options.wsDebug("sidebar:conversation-read", {
            id,
            reason: items.length === 0 ? "live-empty-union" : "live-union",
            source: readResult.source,
            sync: readResult.sync,
            count: readResult.items.length,
            liveCount: items.length,
            mergedCount: nextItems.length,
          });
        } catch (readError) {
          options.wsDebug("sidebar:conversation-read:union-error", {
            id,
            liveCount: items.length,
            error: readError instanceof Error ? readError.message : safeStringify(readError),
          });
        }
      }

      applyWorkspaceSidebarReadResult({
        workspaceId: id,
        items: nextItems,
        available: true,
      });
      setSidebarSessionHasMoreByWorkspaceId((prev) => ({
        ...prev,
        [id]: usedReadApiUnion ? false : deriveSidebarHasMore(rawCount, requestLimit),
      }));
    } catch (error) {
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
      const message = error instanceof Error ? error.message : safeStringify(error);
      if (hostReadDirectory && isSidebarRuntimeUnavailableError(message)) {
        try {
          await refreshSidebarWorkspaceSessionsFromReadApi(id, hostReadDirectory, "engine-runtime-unavailable");
          return;
        } catch (readError) {
          options.wsDebug("sidebar:conversation-read:fallback-error", {
            id,
            error: readError instanceof Error ? readError.message : safeStringify(readError),
          });
        }
      }
      options.wsDebug("sidebar:error", { id, message });
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: message }));
    }
  };

  const loadMoreWorkspaceSidebarSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    if (sidebarSessionLoadingMoreByWorkspaceId()[id]) return;
    if (sidebarSessionHasMoreByWorkspaceId()[id] === false) return;

    setSidebarSessionLoadingMoreByWorkspaceId((prev) => ({ ...prev, [id]: true }));
    setSidebarSessionLimitByWorkspaceId((prev) => ({
      ...prev,
      [id]: nextSidebarSessionLimit(
        prev[id] ?? initialSidebarSessionLimit(),
        SIDEBAR_SESSION_PAGE_SIZE,
      ),
    }));

    try {
      await refreshSidebarWorkspaceSessions(id);
    } finally {
      setSidebarSessionLoadingMoreByWorkspaceId((prev) => ({ ...prev, [id]: false }));
    }
  };

  const publishRegisteredWorkspaceToSidebar = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    setSidebarSessionsByWorkspaceId((prev) =>
      Object.prototype.hasOwnProperty.call(prev, id) ? prev : { ...prev, [id]: [] },
    );
    setSidebarSessionStatusByWorkspaceId((prev) =>
      Object.prototype.hasOwnProperty.call(prev, id) ? prev : { ...prev, [id]: "ready" as const },
    );
    setSidebarSessionErrorByWorkspaceId((prev) =>
      Object.prototype.hasOwnProperty.call(prev, id) ? prev : { ...prev, [id]: null },
    );
    setSidebarSessionHasMoreByWorkspaceId((prev) =>
      Object.prototype.hasOwnProperty.call(prev, id) ? prev : { ...prev, [id]: false },
    );

    const workspace = options.workspaceStore.workspaces().find((entry) => entry.id === id) ?? null;
    const projectKey = workspace?.workspaceType === "local"
      ? normalizeDirectoryPath(workspace.path?.trim() || workspace.directory?.trim() || "")
      : "";
    if (projectKey && !options.workspaceStore.isPrivateWorkspacePath(projectKey)) {
      promoteStoredProjectOrderKey(projectKey);
    }
  };

  const removeSessionFromWorkspaceSidebar = (workspaceId: string, sessionId: string) => {
    setSidebarSessionsByWorkspaceId((prev) =>
      removeSidebarSessionFromWorkspaceRows(prev, workspaceId, sessionId),
    );
  };

  const replaceWorkspaceSidebarSessions = (workspaceId: string, items: SidebarSessionItem[]) => {
    setSidebarSessionsByWorkspaceId((sessionsPrev) => {
      const statusPrev = untrack(sidebarSessionStatusByWorkspaceId);
      const next = replaceSidebarWorkspaceSessionRows({
        sessionsByWorkspaceId: sessionsPrev,
        statusByWorkspaceId: statusPrev,
        workspaceId,
        items,
      });
      setSidebarSessionStatusByWorkspaceId(next.statusByWorkspaceId);
      return next.sessionsByWorkspaceId;
    });
  };

  const markWorkspaceSidebarLoading = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "loading" as const }));
  };

  const prependSessionToWorkspaceSidebar = (workspaceId: string, item: SidebarSessionItem) => {
    setSidebarSessionsByWorkspaceId((prev) => prependSidebarSessionToWorkspaceRows(prev, workspaceId, item));
    const id = workspaceId.trim();
    if (id) {
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" as const }));
    }
  };

  const materializePendingSessionInWorkspaceSidebar = (input: {
    workspaceId: string;
    pendingSessionInstanceId?: string | null;
    item: SidebarSessionItem;
  }) => {
    setSidebarSessionsByWorkspaceId((prev) => materializePendingSidebarSessionRows({ current: prev, ...input }));
    const id = input.workspaceId.trim();
    if (id) {
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" as const }));
    }
  };

  const moveSessionBetweenWorkspaceSidebars = (input: {
    sourceWorkspaceId?: string | null;
    targetWorkspaceId: string;
    item: SidebarSessionItem;
  }) => {
    setSidebarSessionsByWorkspaceId((prev) => moveSidebarSessionBetweenWorkspaceRows({ current: prev, ...input }));
  };

  const ensureSessionInWorkspaceSidebar = (workspaceId: string, item: SidebarSessionItem) => {
    setSidebarSessionsByWorkspaceId((prev) => ensureSidebarSessionInWorkspaceRows(prev, workspaceId, item));
  };

  let sidebarBulkRefreshInFlight: Promise<void> | null = null;
  const sidebarReadyEmptyRetryKeyByWorkspaceId: Record<string, string> = {};

  const refreshAllSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const existingBulkRefresh = sidebarBulkRefreshInFlight;
    if (existingBulkRefresh) {
      await existingBulkRefresh;
      recordPerfLog(options.developerMode(), "sidebar.sessions", "refresh-all-joined", {
        prioritizeWorkspaceId: prioritizeWorkspaceId ?? null,
      });
      return;
    }

    const list = options.workspaceStore.workspaces();
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    const run = (async () => {
      for (const ws of ordered) {
        await refreshSidebarWorkspaceSessions(ws.id);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })();
    sidebarBulkRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (sidebarBulkRefreshInFlight === run) {
        sidebarBulkRefreshInFlight = null;
      }
    }
  };

  const refreshLocalSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const existingBulkRefresh = sidebarBulkRefreshInFlight;
    if (existingBulkRefresh) {
      await existingBulkRefresh;
      recordPerfLog(options.developerMode(), "sidebar.sessions", "refresh-local-joined", {
        prioritizeWorkspaceId: prioritizeWorkspaceId ?? null,
      });
      return;
    }

    const list = options.workspaceStore.workspaces().filter((ws) => ws.workspaceType === "local");
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    const run = (async () => {
      for (const ws of ordered) {
        await refreshSidebarWorkspaceSessions(ws.id);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })();
    sidebarBulkRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (sidebarBulkRefreshInFlight === run) {
        sidebarBulkRefreshInFlight = null;
      }
    }
  };

  let lastSidebarEngineKey = "";
  let lastSidebarWorkspaceKey = "";
  createEffect(() => {
    const engineInfo = options.workspaceStore.engine();
    const engineBaseUrl = engineInfo?.baseUrl?.trim() ?? "";
    const engineUser = engineInfo?.opencodeUsername?.trim() ?? "";
    const enginePass = engineInfo?.opencodePassword?.trim() ?? "";

    const engineKey = [engineBaseUrl, engineUser, enginePass].join("::");
    const workspaceKey = options.workspaceStore
      .workspaces()
      .map((ws) => {
        const root = ws.workspaceType === "local" ? ws.path?.trim() ?? "" : ws.directory?.trim() ?? "";
        const base = ws.workspaceType === "local" ? "" : ws.baseUrl?.trim() ?? "";
        const remoteType = ws.workspaceType === "remote" ? (ws.remoteType ?? "") : "";
        const token = ws.remoteType === "veslo" ? (ws.vesloToken?.trim() ?? "") : "";
        return [ws.id, ws.workspaceType, remoteType, root, base, token].join("|");
      })
      .join(";");

    if (engineKey === lastSidebarEngineKey && workspaceKey === lastSidebarWorkspaceKey) return;

    const engineChanged = engineKey !== lastSidebarEngineKey;
    const workspacesChanged = workspaceKey !== lastSidebarWorkspaceKey;

    lastSidebarEngineKey = engineKey;
    lastSidebarWorkspaceKey = workspaceKey;

    pruneSidebarSessionState(new Set(options.workspaceStore.workspaces().map((ws) => ws.id)));

    options.wsDebug("sidebar:refresh", {
      engineChanged,
      workspacesChanged,
      activeWorkspaceId: options.workspaceStore.activeWorkspaceId(),
      engineBaseUrl,
    });

    if (engineChanged && !workspacesChanged) {
      void refreshLocalSidebarWorkspaceSessions(options.workspaceStore.activeWorkspaceId())
        .catch(e => options.reportError(e, "sidebar.refreshLocal"));
      return;
    }

    void refreshAllSidebarWorkspaceSessions(options.workspaceStore.activeWorkspaceId())
      .catch(e => options.reportError(e, "sidebar.refreshAll"));
  });

  createEffect(() => {
    const id = options.workspaceStore.activeWorkspaceId().trim();
    if (!id) return;
    if (!options.activeWorkspaceRuntimeReady()) return;
    const status = sidebarSessionStatusByWorkspaceId()[id] ?? "idle";
    if (status === "idle") {
      refreshSidebarWorkspaceSessions(id).catch(e => options.reportError(e, "sidebar.refreshSessions"));
      return;
    }
    if (status !== "ready") return;
    const existingRows = sidebarSessionsByWorkspaceId()[id] ?? [];
    if (existingRows.length > 0) {
      delete sidebarReadyEmptyRetryKeyByWorkspaceId[id];
      return;
    }
    const config = resolveSidebarClientConfig(id);
    if (!config?.baseUrl) return;
    const retryKey = [config.baseUrl, config.directory, options.workspaceStore.engine()?.projectDir ?? ""].join("::");
    if (sidebarReadyEmptyRetryKeyByWorkspaceId[id] === retryKey) return;
    sidebarReadyEmptyRetryKeyByWorkspaceId[id] = retryKey;
    refreshSidebarWorkspaceSessions(id).catch(e => options.reportError(e, "sidebar.refreshSessions"));
  });

  createEffect(() => {
    if (!options.activeWorkspaceRuntimeReady()) return;
    const allSessions = options.sessions();
    const activeWorkspaceId = options.workspaceStore.activeWorkspaceId().trim();
    const connectingWorkspaceId = options.workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    const activeSendInProgress = Boolean(options.activeSendTraceId?.()?.trim());
    const wsId = (connectingWorkspaceId || activeWorkspaceId).trim();
    if (!wsId) return;
    const status = sidebarSessionStatusByWorkspaceId()[wsId];

    if (status === "ready") {
      const activeWorkspace = options.workspaceStore.workspaces().find((workspace) => workspace.id === wsId) ?? null;
      const activeWorkspaceRoot = normalizeDirectoryPath(
        activeWorkspace?.workspaceType === "local"
          ? activeWorkspace.path
          : activeWorkspace?.directory ?? activeWorkspace?.path,
      );
      const scopedSessions = activeWorkspaceRoot
        ? allSessions.filter((session) =>
            sessionDirectoryMatchesRoot(options.resolveSessionDirectory(session), activeWorkspaceRoot),
          )
        : allSessions;
      const existingTargetSidebarRows = untrack(() => sidebarSessionsByWorkspaceId()[wsId] ?? []);
      const existingTargetSessionCount = existingTargetSidebarRows.length;
      const freshlyCreatedSessionCount = countFreshlyCreatedSessionsInSidebarRows(
        allSessions,
        existingTargetSidebarRows,
      );
      if (
        !shouldSyncSidebarFromSessionStore({
          activeWorkspaceId,
          connectingWorkspaceId: connectingWorkspaceId || null,
          targetWorkspaceId: wsId,
          allSessionCount: allSessions.length,
          scopedSessionCount: scopedSessions.length,
          existingTargetSessionCount,
          freshlyCreatedSessionCount,
          activeSendInProgress,
        })
      ) {
        options.wsDebug("sidebar:sync:skip-stale-session-store", {
          wsId,
          activeWorkspaceId,
          connectingWorkspaceId: connectingWorkspaceId || null,
          allSessionCount: allSessions.length,
          scopedSessionCount: scopedSessions.length,
          existingTargetSessionCount,
          freshlyCreatedSessionCount,
          activeSendInProgress,
        });
        return;
      }
      const sorted = sortSessionsByActivity(scopedSessions);
      const { visible: visibleSessions } = partitionVesloUtilitySessions(sorted);
      const requestLimit = sidebarSessionLimitByWorkspaceId()[wsId] ?? initialSidebarSessionLimit();
      const incomingVisibleRows = expandSidebarSessionSliceWithAncestors(visibleSessions, requestLimit);
      const nextRows = deriveSidebarRowsFromSessionStore({
        incomingSessions: visibleSessions,
        existingRows: existingTargetSidebarRows,
        requestLimit,
        expandVisibleSessions: expandSidebarSessionSliceWithAncestors,
        mapSession: (s) => {
          const displaySession = options.applyPendingInitialSessionTitle(s);
          return {
            id: displaySession.id,
            title: displaySession.title,
            slug: displaySession.slug,
            parentID: displaySession.parentID,
            time: displaySession.time,
            directory: displaySession.directory,
          };
        },
      });
      const retainedExistingSidebarRows = nextRows.length > incomingVisibleRows.length;
      setSidebarSessionsByWorkspaceId((prev) => {
        const currentRows = prev[wsId] ?? [];
        if (sidebarSessionItemsEqual(currentRows, nextRows)) return prev;
        recordPerfLog(options.developerMode(), "workspace.sidebar", "rows-session-store-sync", {
          workspaceId: wsId,
          activeWorkspaceId,
          connectingWorkspaceId: connectingWorkspaceId || null,
          previousCount: currentRows.length,
          incomingVisibleCount: incomingVisibleRows.length,
          nextCount: nextRows.length,
          retainedExistingSidebarRows,
          allSessionCount: allSessions.length,
          scopedSessionCount: scopedSessions.length,
          freshlyCreatedSessionCount,
          activeSendInProgress,
        });
        return {
          ...prev,
          [wsId]: nextRows,
        };
      });
      setSidebarSessionHasMoreByWorkspaceId((prev) => {
        const nextHasMore = retainedExistingSidebarRows
          ? prev[wsId] ?? deriveSidebarHasMore(nextRows.length, requestLimit)
          : deriveSidebarHasMore(visibleSessions.length, requestLimit);
        if ((prev[wsId] ?? false) === nextHasMore) return prev;
        return {
          ...prev,
          [wsId]: nextHasMore,
        };
      });
    }
  });

  const sidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const workspaces = options.workspaceStore.workspaces();
    const activeWorkspaceId = options.workspaceStore.activeWorkspaceId().trim();
    const connectingWorkspaceId = options.workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    const sessionsById = sidebarSessionsByWorkspaceId();
    const statusById = sidebarSessionStatusByWorkspaceId();
    const errorById = sidebarSessionErrorByWorkspaceId();
    const dedupedWorkspaces: typeof workspaces = [];
    const dedupeKeyToIndex = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const hostKey =
        normalizeVesloServerUrl(workspace.vesloHostUrl?.trim() ?? "") ??
        normalizeVesloServerUrl(workspace.baseUrl?.trim() ?? "") ??
        "";
      const workspaceIdKey =
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        "";
      const directoryKey = normalizeDirectoryPath(workspace.directory?.trim() ?? workspace.path?.trim() ?? "");
      const identityKey = workspaceIdKey ? `id:${workspaceIdKey}` : (directoryKey ? `dir:${directoryKey}` : "");
      if (!hostKey || !identityKey) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const dedupeKey = `${workspace.remoteType ?? ""}|${hostKey}|${identityKey}`;
      const existingIndex = dedupeKeyToIndex.get(dedupeKey);
      if (existingIndex === undefined) {
        dedupeKeyToIndex.set(dedupeKey, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingWorkspace = dedupedWorkspaces[existingIndex];
      const existingIsPriority =
        existingWorkspace.id === activeWorkspaceId || existingWorkspace.id === connectingWorkspaceId;
      const currentIsPriority =
        workspace.id === activeWorkspaceId || workspace.id === connectingWorkspaceId;
      if (currentIsPriority && !existingIsPriority) {
        dedupedWorkspaces[existingIndex] = workspace;
      }
    }
    return dedupedWorkspaces.map((workspace) => {
      const groupSessions = sessionsById[workspace.id] ?? [];
      return {
        workspace,
        sessions: groupSessions,
        status: statusById[workspace.id] ?? "idle",
        error: errorById[workspace.id] ?? null,
      };
    });
  });

  const workspaceSessionPagingById = createMemo<Record<string, { hasMore: boolean; loadingMore: boolean }>>(() => {
    const hasMoreById = sidebarSessionHasMoreByWorkspaceId();
    const loadingById = sidebarSessionLoadingMoreByWorkspaceId();
    const paging: Record<string, { hasMore: boolean; loadingMore: boolean }> = {};
    for (const workspace of options.workspaceStore.workspaces()) {
      paging[workspace.id] = {
        hasMore: hasMoreById[workspace.id] ?? false,
        loadingMore: loadingById[workspace.id] ?? false,
      };
    }
    return paging;
  });

  return {
    sidebarSessionsByWorkspaceId,
    sidebarWorkspaceGroups,
    workspaceSessionPagingById,
    clearStaleWorkspaceSessionError,
    refreshSidebarWorkspaceSessions,
    loadMoreWorkspaceSidebarSessions,
    publishRegisteredWorkspaceToSidebar,
    markWorkspaceSidebarLoading,
    replaceWorkspaceSidebarSessions,
    applyWorkspaceSidebarReadResult,
    removeSessionFromWorkspaceSidebar,
    prependSessionToWorkspaceSidebar,
    materializePendingSessionInWorkspaceSidebar,
    moveSessionBetweenWorkspaceSidebars,
    ensureSessionInWorkspaceSidebar,
  };
}
