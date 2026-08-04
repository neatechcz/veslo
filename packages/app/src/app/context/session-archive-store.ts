import { createEffect, createSignal, type Accessor } from "solid-js";

import {
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  buildArchivedSidebarSessionKey,
  buildLegacyArchiveMigration,
  buildSessionArchiveSnapshot,
  sortArchivedSessionsByRecency,
  toSessionArchiveItem,
} from "../lib/session-archive-model";
import { recordBootstrapDiagnostic as recordNativeBootstrapDiagnostic } from "../lib/bootstrap-diagnostics";
import {
  normalizeVesloServerResponseDiagnostic,
  VesloServerError,
} from "../lib/veslo-server/transport";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import type {
  VesloServerClient,
  VesloServerStatus,
  VesloSessionArchiveRecord,
} from "../lib/veslo-server";
import type { WorkspaceInfo } from "../lib/tauri";
import type { SessionArchiveItem, WorkspaceSessionGroup } from "../types";
import { isTauriRuntime, normalizeDirectoryPath } from "../utils";

export { LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY } from "../lib/session-archive-model";

export const SESSION_ARCHIVE_MIGRATION_KEY_PREFIX = "veslo.session-archives-cloud-migrated.v1:";
export const SESSION_ARCHIVE_LOAD_ERROR_MESSAGE =
  "Session archives could not be loaded. Check the connection and try again.";

export type SessionArchiveClient = Pick<
  VesloServerClient,
  "baseUrl" | "token" | "listSessionArchives" | "putSessionArchive" | "deleteSessionArchive"
>;

export type SessionArchiveStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type SessionArchiveStoreDeps = {
  vesloArchiveClient: Accessor<SessionArchiveClient | null | undefined>;
  sessionArchiveOwnerKey: Accessor<string | null | undefined>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  vesloServerCheckedAt: Accessor<number | null | undefined>;
  workspaces: Accessor<WorkspaceInfo[]>;
  sidebarWorkspaceGroups: Accessor<WorkspaceSessionGroup[]>;
  reportError: (error: unknown, scope: string) => void;
  setError: (message: string | null) => void;
  getError?: Accessor<string | null | undefined>;
  isTauriRuntime?: () => boolean;
  recordBootstrapDiagnostic?: (eventType: string, payload: unknown) => Promise<void> | void;
  recordTrace?: (event: string, payload: Record<string, unknown>) => void;
  storage?: SessionArchiveStorage | null;
  effect?: (fn: () => void) => void;
};

export type SessionArchiveStore = {
  archivedSessionIds: Accessor<string[]>;
  sessionArchives: Accessor<SessionArchiveItem[]>;
  archiveSession: (
    workspaceId: string,
    sessionId: string,
    target?: SessionArchiveTarget | null,
  ) => Promise<void>;
  unarchiveSession: (
    workspaceId: string,
    sessionId: string,
    workspaceIdentityHint?: string | null,
    target?: SessionArchiveTarget | null,
  ) => Promise<void>;
};

export type SessionArchiveTarget = {
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

type SessionArchiveSnapshot = {
  client: SessionArchiveClient;
  ownerKey: string;
  key: string;
  generation: number;
};

function defaultStorage(): SessionArchiveStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function readLegacyArchivedSessionIds(storage: SessionArchiveStorage | null) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function clearLegacyArchivedSessionIds(storage: SessionArchiveStorage | null) {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY);
  } catch {
    // ignore
  }
}

function readArchiveMigrationDone(storage: SessionArchiveStorage | null, accountId: string) {
  if (!storage) return false;
  try {
    return storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}${accountId}`) === "true";
  } catch {
    return false;
  }
}

function writeArchiveMigrationDone(storage: SessionArchiveStorage | null, accountId: string) {
  if (!storage) return;
  try {
    storage.setItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}${accountId}`, "true");
  } catch {
    // ignore
  }
}

function buildSessionArchiveClientKey(client: SessionArchiveClient, ownerKey: string): string {
  return JSON.stringify([client.baseUrl, client.token ?? "", ownerKey]);
}

function writeLegacyArchivedSessionIds(storage: SessionArchiveStorage | null, sessionIds: string[]) {
  if (!storage) return;
  try {
    storage.setItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY, JSON.stringify(sessionIds));
  } catch {
    // ignore
  }
}

function archiveMutationErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof VesloServerError) {
    return {
      errorKind: "veslo_server",
      errorCode: error.code ?? null,
      errorStatus: error.status ?? null,
    };
  }
  return { errorKind: "unknown" };
}

function sameSessionArchiveSnapshot(
  left: SessionArchiveSnapshot | null,
  right: SessionArchiveSnapshot | null,
): boolean {
  return Boolean(
    left
      && right
      && left.key === right.key
      && left.generation === right.generation,
  );
}

export function createSessionArchiveStore(deps: SessionArchiveStoreDeps): SessionArchiveStore {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const effect = deps.effect ?? ((fn: () => void) => createEffect(fn));
  const [sessionArchiveRecords, setSessionArchiveRecords] = createSignal<VesloSessionArchiveRecord[]>([]);
  const [sessionArchiveReady, setSessionArchiveReady] = createSignal(false);
  const [sessionArchivePendingIds, setSessionArchivePendingIds] = createSignal<Set<string>>(new Set());
  const recordArchiveTrace = deps.recordTrace ?? ((event, payload) => {
    recordSendWorkflowTrace("session-archive", event, payload);
  });

  const applySessionArchiveRecords = (items: VesloSessionArchiveRecord[]) => {
    setSessionArchiveRecords(sortArchivedSessionsByRecency(items));
    setSessionArchiveReady(true);
  };

  const archivedSessionIds = () => {
    const workspaces = deps.workspaces();
    const keys = sessionArchiveRecords().flatMap((record) => {
      const item = toSessionArchiveItem(record, workspaces);
      const legacyKey = buildArchivedSidebarSessionKey({
        workspaceId: item.workspaceId,
        workspaceIdentity: item.workspaceIdentity,
        sessionId: item.sessionId,
      });
      const directoryKey = buildArchivedSidebarSessionKey({
        workspaceId: item.workspaceId,
        workspaceIdentity: item.workspaceIdentity,
        sessionId: item.sessionId,
        directory: item.resolvedDirectory,
      });
      return [legacyKey, directoryKey].filter(Boolean);
    });
    return Array.from(new Set(keys));
  };

  const sessionArchives = () =>
    sortArchivedSessionsByRecency(
      sessionArchiveRecords().map((record) => toSessionArchiveItem(record, deps.workspaces())),
    );

  const withPendingArchivedSession = async (
    workspaceId: string,
    sessionId: string,
    task: () => Promise<void>,
    workspaceIdentity?: string | null,
    directory?: string | null,
  ) => {
    const id = buildArchivedSidebarSessionKey({ workspaceId, workspaceIdentity, sessionId, directory });
    if (!id) return;
    if (sessionArchivePendingIds().has(id)) return;

    setSessionArchivePendingIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    try {
      await task();
    } finally {
      setSessionArchivePendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const isArchiveTauriRuntime = deps.isTauriRuntime ?? isTauriRuntime;
  const emitBootstrapDiagnostic =
    deps.recordBootstrapDiagnostic ?? recordNativeBootstrapDiagnostic;
  let activeSessionArchiveKey = "";
  let sessionArchiveGeneration = 0;
  let sessionArchiveRecordsRevision = 0;
  let confirmedSessionArchiveSnapshot: SessionArchiveSnapshot | null = null;
  let failedSessionArchiveSnapshot: SessionArchiveSnapshot | null = null;
  let failedSessionArchiveCheckedAt: number | null = null;
  let lastStartedSessionArchiveGeneration: number | null = null;
  let sessionArchiveLoadInFlight: SessionArchiveSnapshot | null = null;
  let sessionArchiveMigrationRunning: SessionArchiveSnapshot | null = null;
  const sessionArchiveMutationTails = new Map<string, Promise<void>>();

  const enqueueSessionArchiveMutation = async (
    snapshot: SessionArchiveSnapshot,
    task: () => Promise<void>,
  ) => {
    const previous = sessionArchiveMutationTails.get(snapshot.key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    sessionArchiveMutationTails.set(snapshot.key, tail);
    await previous;
    try {
      await task();
    } finally {
      release();
      if (sessionArchiveMutationTails.get(snapshot.key) === tail) {
        sessionArchiveMutationTails.delete(snapshot.key);
      }
    }
  };

  const resolveSessionArchiveScope = () => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey()?.trim() ?? "";
    if (!client || !ownerKey) return null;
    return {
      client,
      ownerKey,
      key: buildSessionArchiveClientKey(client, ownerKey),
    };
  };

  const syncSessionArchiveScope = (): SessionArchiveSnapshot | null => {
    const scope = resolveSessionArchiveScope();
    const key = scope?.key ?? "";
    if (key !== activeSessionArchiveKey) {
      activeSessionArchiveKey = key;
      sessionArchiveGeneration += 1;
      confirmedSessionArchiveSnapshot = null;
      failedSessionArchiveSnapshot = null;
      failedSessionArchiveCheckedAt = null;
      lastStartedSessionArchiveGeneration = null;
      sessionArchiveRecordsRevision = 0;
      setSessionArchiveRecords([]);
      setSessionArchiveReady(false);
    }
    return scope ? { ...scope, generation: sessionArchiveGeneration } : null;
  };

  const isCurrentSessionArchiveSnapshot = (snapshot: SessionArchiveSnapshot): boolean => {
    const scope = resolveSessionArchiveScope();
    return Boolean(
      scope
        && snapshot.key === scope.key
        && snapshot.generation === sessionArchiveGeneration,
    );
  };

  const isConfirmedSessionArchiveSnapshot = (snapshot: SessionArchiveSnapshot): boolean =>
    sameSessionArchiveSnapshot(confirmedSessionArchiveSnapshot, snapshot);

  const applyCurrentSessionArchiveRecords = (
    snapshot: SessionArchiveSnapshot,
    items: VesloSessionArchiveRecord[],
  ): boolean => {
    if (!isCurrentSessionArchiveSnapshot(snapshot)) return false;
    applySessionArchiveRecords(items);
    return true;
  };

  const confirmCurrentSessionArchiveSnapshot = (snapshot: SessionArchiveSnapshot): boolean => {
    if (!isCurrentSessionArchiveSnapshot(snapshot)) return false;
    confirmedSessionArchiveSnapshot = snapshot;
    failedSessionArchiveSnapshot = null;
    failedSessionArchiveCheckedAt = null;
    return true;
  };

  const applyCurrentSessionArchiveMutation = (
    snapshot: SessionArchiveSnapshot,
    items: VesloSessionArchiveRecord[],
  ): boolean => {
    if (!confirmCurrentSessionArchiveSnapshot(snapshot)) return false;
    sessionArchiveRecordsRevision += 1;
    applySessionArchiveRecords(items);
    return true;
  };

  const clearOwnSessionArchiveLoadError = () => {
    if (deps.getError?.() === SESSION_ARCHIVE_LOAD_ERROR_MESSAGE) {
      deps.setError(null);
    }
  };

  const setOwnSessionArchiveLoadError = () => {
    const currentError = deps.getError?.();
    if (currentError && currentError !== SESSION_ARCHIVE_LOAD_ERROR_MESSAGE) return;
    deps.setError(SESSION_ARCHIVE_LOAD_ERROR_MESSAGE);
  };

  const emitSessionArchiveLoadFailure = (error: unknown) => {
    if (!isArchiveTauriRuntime() || !(error instanceof VesloServerError)) return;
    const responseDiagnostic = normalizeVesloServerResponseDiagnostic(error.responseDiagnostic);
    if (!responseDiagnostic) return;
    try {
      void Promise.resolve(
        emitBootstrapDiagnostic("session-archives:load-failed", responseDiagnostic),
      ).catch(() => undefined);
    } catch {
      // Diagnostics must never interrupt archive recovery.
    }
  };

  const startSessionArchiveLoad = (
    snapshot: SessionArchiveSnapshot,
    archiveServerCheckedAt: number | null,
  ) => {
    const recordsRevisionAtStart = sessionArchiveRecordsRevision;
    sessionArchiveLoadInFlight = snapshot;
    lastStartedSessionArchiveGeneration = snapshot.generation;
    if (!isConfirmedSessionArchiveSnapshot(snapshot)) {
      setSessionArchiveReady(false);
    }

    void snapshot.client.listSessionArchives()
      .then((response) => {
        if (
          !isCurrentSessionArchiveSnapshot(snapshot)
          || recordsRevisionAtStart !== sessionArchiveRecordsRevision
        ) {
          return;
        }
        if (!confirmCurrentSessionArchiveSnapshot(snapshot)) return;
        if (applyCurrentSessionArchiveRecords(snapshot, response.items ?? [])) {
          clearOwnSessionArchiveLoadError();
        }
      })
      .catch((error) => {
        if (
          !isCurrentSessionArchiveSnapshot(snapshot)
          || recordsRevisionAtStart !== sessionArchiveRecordsRevision
        ) {
          return;
        }
        failedSessionArchiveSnapshot = snapshot;
        failedSessionArchiveCheckedAt = archiveServerCheckedAt;
        deps.reportError(error, "sessionArchives.load");
        emitSessionArchiveLoadFailure(error);
        if (!isConfirmedSessionArchiveSnapshot(snapshot)) {
          setSessionArchiveRecords([]);
          setSessionArchiveReady(false);
        }
        setOwnSessionArchiveLoadError();
      })
      .finally(() => {
        if (sameSessionArchiveSnapshot(sessionArchiveLoadInFlight, snapshot)) {
          sessionArchiveLoadInFlight = null;
        }
      });
  };

  effect(() => {
    const snapshot = syncSessionArchiveScope();
    const archiveServerStatus = deps.vesloServerStatus();
    const archiveServerCheckedAt = deps.vesloServerCheckedAt() ?? null;
    if (!snapshot) return;
    if (archiveServerStatus !== "connected" || archiveServerCheckedAt === null) return;

    const retryFailedSessionArchiveLoad =
      sameSessionArchiveSnapshot(failedSessionArchiveSnapshot, snapshot)
      && archiveServerCheckedAt !== failedSessionArchiveCheckedAt;
    if (
      lastStartedSessionArchiveGeneration === snapshot.generation
      && !retryFailedSessionArchiveLoad
    ) {
      return;
    }
    if (sameSessionArchiveSnapshot(sessionArchiveLoadInFlight, snapshot)) return;

    startSessionArchiveLoad(snapshot, archiveServerCheckedAt);
  });

  effect(() => {
    const snapshot = syncSessionArchiveScope();
    const ready = sessionArchiveReady();
    const records = sessionArchiveRecords();
    const groups = deps.sidebarWorkspaceGroups();

    if (
      !snapshot
      || !ready
      || !isConfirmedSessionArchiveSnapshot(snapshot)
      || sameSessionArchiveSnapshot(sessionArchiveMigrationRunning, snapshot)
    ) {
      return;
    }
    if (readArchiveMigrationDone(storage, snapshot.ownerKey)) return;

    const legacyIds = readLegacyArchivedSessionIds(storage);
    if (legacyIds.length === 0) {
      writeArchiveMigrationDone(storage, snapshot.ownerKey);
      return;
    }

    const archivedLegacyIds = new Set(records.map((record) => record.sessionId.trim()).filter(Boolean));
    const migrationRecords = buildLegacyArchiveMigration(legacyIds, groups)
      .filter((record) => !archivedLegacyIds.has(record.sessionId));
    const resolvedLegacyIds = new Set([
      ...archivedLegacyIds,
      ...migrationRecords.map((record) => record.sessionId),
    ]);
    const remainingLegacyIds = legacyIds.filter((sessionId) => !resolvedLegacyIds.has(sessionId));
    if (migrationRecords.length === 0) {
      if (remainingLegacyIds.length === 0) {
        clearLegacyArchivedSessionIds(storage);
        writeArchiveMigrationDone(storage, snapshot.ownerKey);
      }
      return;
    }

    sessionArchiveMigrationRunning = snapshot;
    void (async () => {
      try {
        await enqueueSessionArchiveMutation(snapshot, async () => {
          let latest: VesloSessionArchiveRecord[] = records;
          for (const record of migrationRecords) {
            const { sessionId, ...payload } = record;
            latest = (await snapshot.client.putSessionArchive(sessionId, payload)).items ?? [];
            if (
              !isCurrentSessionArchiveSnapshot(snapshot)
              || !isConfirmedSessionArchiveSnapshot(snapshot)
            ) {
              return;
            }
            sessionArchiveRecordsRevision += 1;
          }
          if (!applyCurrentSessionArchiveRecords(snapshot, latest)) return;
        });
        if (!isConfirmedSessionArchiveSnapshot(snapshot)) return;
        if (remainingLegacyIds.length === 0) {
          clearLegacyArchivedSessionIds(storage);
          writeArchiveMigrationDone(storage, snapshot.ownerKey);
        } else {
          writeLegacyArchivedSessionIds(storage, remainingLegacyIds);
        }
      } catch (error) {
        if (isCurrentSessionArchiveSnapshot(snapshot)) {
          deps.reportError(error, "sessionArchives.migrateLegacy");
        }
      } finally {
        if (sameSessionArchiveSnapshot(sessionArchiveMigrationRunning, snapshot)) {
          sessionArchiveMigrationRunning = null;
        }
      }
    })();
  });

  const archiveSession = async (
    workspaceId: string,
    sessionId: string,
    target?: SessionArchiveTarget | null,
  ) => {
    const snapshot = syncSessionArchiveScope();
    if (!snapshot) {
      recordArchiveTrace("session-archive:mutation-rejected", {
        operation: "archive",
        workspaceId,
        sessionId,
        reason: "archive_scope_unavailable",
      });
      deps.setError("A Veslo server connection or cloud sign-in is required to archive sessions.");
      return;
    }

    const targetDirectory = normalizeDirectoryPath(target?.directory ?? "");
    const targetConversationId = target?.conversationId?.trim() ?? "";
    const targetOpencodeSessionId = target?.opencodeSessionId?.trim() ?? "";
    const group = deps.sidebarWorkspaceGroups().find((entry) => entry.workspace.id === workspaceId) ?? null;
    const session = group?.sessions.find((entry) => {
      if (entry.id !== sessionId) return false;
      if (targetDirectory && normalizeDirectoryPath(entry.directory ?? "") !== targetDirectory) return false;
      if (targetConversationId && (entry.conversationId?.trim() ?? "") !== targetConversationId) return false;
      if (targetOpencodeSessionId && (entry.opencodeSessionId?.trim() || entry.id) !== targetOpencodeSessionId) {
        return false;
      }
      return true;
    }) ?? null;
    if (!group || !session) {
      recordArchiveTrace("session-archive:mutation-rejected", {
        operation: "archive",
        workspaceId,
        sessionId,
        scopeGeneration: snapshot.generation,
        reason: group ? "session_target_unavailable" : "workspace_target_unavailable",
      });
      return;
    }

    await withPendingArchivedSession(workspaceId, sessionId, () => enqueueSessionArchiveMutation(snapshot, async () => {
      recordArchiveTrace("session-archive:mutation-requested", {
        operation: "archive",
        workspaceId,
        sessionId,
        scopeGeneration: snapshot.generation,
        hasConversationTarget: Boolean(targetConversationId),
        hasOpenCodeSessionTarget: Boolean(targetOpencodeSessionId),
      });
      try {
        const response = await snapshot.client.putSessionArchive(
          sessionId,
          buildSessionArchiveSnapshot({ session, workspace: group.workspace }),
        );
        const itemCount = response.items?.length ?? 0;
        recordArchiveTrace("session-archive:mutation-committed", {
          operation: "archive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          itemCount,
        });
        if (!applyCurrentSessionArchiveMutation(snapshot, response.items ?? [])) {
          recordArchiveTrace("session-archive:projection-superseded", {
            operation: "archive",
            workspaceId,
            sessionId,
            scopeGeneration: snapshot.generation,
          });
          return;
        }
        clearOwnSessionArchiveLoadError();
        if (
          isConfirmedSessionArchiveSnapshot(snapshot)
          && readLegacyArchivedSessionIds(storage).length === 0
        ) {
          writeArchiveMigrationDone(storage, snapshot.ownerKey);
        }
        recordArchiveTrace("session-archive:projection-applied", {
          operation: "archive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          itemCount,
        });
      } catch (error) {
        recordArchiveTrace("session-archive:mutation-failed", {
          operation: "archive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          ...archiveMutationErrorDetails(error),
        });
        throw error;
      }
    }), null, targetDirectory);
  };

  const unarchiveSession = async (
    workspaceId: string,
    sessionId: string,
    workspaceIdentityHint?: string | null,
    target?: SessionArchiveTarget | null,
  ) => {
    const snapshot = syncSessionArchiveScope();
    if (!snapshot) {
      recordArchiveTrace("session-archive:mutation-rejected", {
        operation: "unarchive",
        workspaceId,
        sessionId,
        reason: "archive_scope_unavailable",
      });
      deps.setError("A Veslo server connection or cloud sign-in is required to unarchive sessions.");
      return;
    }

    const workspaces = deps.workspaces();
    const normalizedIdentityHint = workspaceIdentityHint?.trim() ?? "";
    const targetDirectory = normalizeDirectoryPath(target?.directory ?? "");
    const archiveItem = sessionArchiveRecords()
      .map((record) => toSessionArchiveItem(record, workspaces))
      .find((item) =>
        item.sessionId === sessionId &&
        item.workspaceId === workspaceId &&
        (!normalizedIdentityHint || item.workspaceIdentity === normalizedIdentityHint) &&
        (!targetDirectory || normalizeDirectoryPath(item.resolvedDirectory ?? "") === targetDirectory)
      );
    const workspaceIdentity = normalizedIdentityHint || archiveItem?.workspaceIdentity?.trim() || undefined;

    await withPendingArchivedSession(workspaceId, sessionId, () => enqueueSessionArchiveMutation(snapshot, async () => {
      recordArchiveTrace("session-archive:mutation-requested", {
        operation: "unarchive",
        workspaceId,
        sessionId,
        scopeGeneration: snapshot.generation,
        hasDirectoryTarget: Boolean(targetDirectory),
        hasWorkspaceIdentity: Boolean(workspaceIdentity),
      });
      try {
        const deleteOptions: { workspaceId: string; workspaceIdentity?: string; directory?: string } = {
          workspaceId,
        };
        if (workspaceIdentity) deleteOptions.workspaceIdentity = workspaceIdentity;
        if (targetDirectory) deleteOptions.directory = targetDirectory;

        const response = await snapshot.client.deleteSessionArchive(sessionId, deleteOptions);
        const itemCount = response.items?.length ?? 0;
        recordArchiveTrace("session-archive:mutation-committed", {
          operation: "unarchive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          itemCount,
        });
        if (!applyCurrentSessionArchiveMutation(snapshot, response.items ?? [])) {
          recordArchiveTrace("session-archive:projection-superseded", {
            operation: "unarchive",
            workspaceId,
            sessionId,
            scopeGeneration: snapshot.generation,
          });
          return;
        }
        clearOwnSessionArchiveLoadError();
        if (
          isConfirmedSessionArchiveSnapshot(snapshot)
          && readLegacyArchivedSessionIds(storage).length === 0
        ) {
          writeArchiveMigrationDone(storage, snapshot.ownerKey);
        }
        recordArchiveTrace("session-archive:projection-applied", {
          operation: "unarchive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          itemCount,
        });
      } catch (error) {
        recordArchiveTrace("session-archive:mutation-failed", {
          operation: "unarchive",
          workspaceId,
          sessionId,
          scopeGeneration: snapshot.generation,
          ...archiveMutationErrorDetails(error),
        });
        throw error;
      }
    }), workspaceIdentity, targetDirectory || archiveItem?.resolvedDirectory);
  };

  return {
    archivedSessionIds,
    sessionArchives,
    archiveSession,
    unarchiveSession,
  };
}
