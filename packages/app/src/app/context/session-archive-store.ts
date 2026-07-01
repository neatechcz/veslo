import { createEffect, createSignal, type Accessor } from "solid-js";

import {
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  buildArchivedSidebarSessionKey,
  buildLegacyArchiveMigration,
  buildSessionArchiveSnapshot,
  sortArchivedSessionsByRecency,
  toSessionArchiveItem,
} from "../lib/session-archive-model";
import type {
  VesloServerClient,
  VesloServerStatus,
  VesloSessionArchiveRecord,
} from "../lib/veslo-server";
import type { WorkspaceInfo } from "../lib/tauri";
import type { SessionArchiveItem, WorkspaceSessionGroup } from "../types";

export { LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY } from "../lib/session-archive-model";

export const SESSION_ARCHIVE_MIGRATION_KEY_PREFIX = "veslo.session-archives-cloud-migrated.v1:";

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
  storage?: SessionArchiveStorage | null;
  effect?: (fn: () => void) => void;
};

export type SessionArchiveStore = {
  archivedSessionIds: Accessor<string[]>;
  sessionArchives: Accessor<SessionArchiveItem[]>;
  archiveSession: (workspaceId: string, sessionId: string) => Promise<void>;
  unarchiveSession: (
    workspaceId: string,
    sessionId: string,
    workspaceIdentityHint?: string | null,
  ) => Promise<void>;
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

export function createSessionArchiveStore(deps: SessionArchiveStoreDeps): SessionArchiveStore {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const effect = deps.effect ?? ((fn: () => void) => createEffect(fn));
  const [sessionArchiveRecords, setSessionArchiveRecords] = createSignal<VesloSessionArchiveRecord[]>([]);
  const [sessionArchiveReady, setSessionArchiveReady] = createSignal(false);
  const [sessionArchivePendingIds, setSessionArchivePendingIds] = createSignal<Set<string>>(new Set());

  const applySessionArchiveRecords = (items: VesloSessionArchiveRecord[]) => {
    setSessionArchiveRecords(sortArchivedSessionsByRecency(items));
    setSessionArchiveReady(true);
  };

  const archivedSessionIds = () => {
    const workspaces = deps.workspaces();
    return sessionArchiveRecords().map((record) => {
      const item = toSessionArchiveItem(record, workspaces);
      return buildArchivedSidebarSessionKey({
        workspaceId: item.workspaceId,
        workspaceIdentity: item.workspaceIdentity,
        sessionId: item.sessionId,
      });
    });
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
  ) => {
    const id = buildArchivedSidebarSessionKey({ workspaceId, workspaceIdentity, sessionId });
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

  const loadSessionArchives = async () => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      setSessionArchiveRecords([]);
      setSessionArchiveReady(true);
      return;
    }

    const response = await client.listSessionArchives();
    applySessionArchiveRecords(response.items ?? []);
  };

  let lastSessionArchiveClientKey = "";
  let failedSessionArchiveClientKey = "";
  let sessionArchiveLoadInFlightKey = "";
  let lastSessionArchiveRetryCheckedAt: number | null = null;
  effect(() => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey();
    const archiveServerStatus = deps.vesloServerStatus();
    const archiveServerCheckedAt = deps.vesloServerCheckedAt();
    const key = client && ownerKey ? `${client.baseUrl}::${client.token ?? ""}::${ownerKey}` : "";
    const retryFailedSessionArchiveLoad =
      Boolean(key) &&
      failedSessionArchiveClientKey === key &&
      archiveServerStatus === "connected" &&
      archiveServerCheckedAt !== null &&
      archiveServerCheckedAt !== lastSessionArchiveRetryCheckedAt;

    if (key === lastSessionArchiveClientKey && !retryFailedSessionArchiveLoad) return;
    if (sessionArchiveLoadInFlightKey === key) return;

    lastSessionArchiveClientKey = key;
    if (retryFailedSessionArchiveLoad) {
      lastSessionArchiveRetryCheckedAt = archiveServerCheckedAt ?? null;
    } else {
      lastSessionArchiveRetryCheckedAt = null;
    }
    sessionArchiveLoadInFlightKey = key;
    setSessionArchiveReady(false);
    void loadSessionArchives()
      .then(() => {
        if (sessionArchiveLoadInFlightKey !== key) return;
        failedSessionArchiveClientKey = "";
        lastSessionArchiveRetryCheckedAt = null;
      })
      .catch((error) => {
        if (sessionArchiveLoadInFlightKey !== key) return;
        failedSessionArchiveClientKey = key;
        deps.reportError(error, "sessionArchives.load");
        setSessionArchiveRecords([]);
        setSessionArchiveReady(true);
      })
      .finally(() => {
        if (sessionArchiveLoadInFlightKey === key) {
          sessionArchiveLoadInFlightKey = "";
        }
      });
  });

  let sessionArchiveMigrationRunning = false;
  effect(() => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey();
    const ready = sessionArchiveReady();
    const records = sessionArchiveRecords();
    const groups = deps.sidebarWorkspaceGroups();

    if (!client || !ownerKey || !ready || sessionArchiveMigrationRunning) return;
    if (readArchiveMigrationDone(storage, ownerKey)) return;

    const legacyIds = readLegacyArchivedSessionIds(storage);
    if (legacyIds.length === 0) {
      writeArchiveMigrationDone(storage, ownerKey);
      return;
    }

    if (records.length > 0) {
      clearLegacyArchivedSessionIds(storage);
      writeArchiveMigrationDone(storage, ownerKey);
      return;
    }

    const migrationRecords = buildLegacyArchiveMigration(legacyIds, groups);
    if (migrationRecords.length === 0) {
      const allGroupsSettled =
        groups.length > 0 && groups.every((group) => group.status === "ready" || group.status === "error");
      if (allGroupsSettled) {
        clearLegacyArchivedSessionIds(storage);
        writeArchiveMigrationDone(storage, ownerKey);
      }
      return;
    }

    sessionArchiveMigrationRunning = true;
    void (async () => {
      try {
        let latest: VesloSessionArchiveRecord[] = records;
        for (const record of migrationRecords) {
          const { sessionId, ...payload } = record;
          latest = (await client.putSessionArchive(sessionId, payload)).items ?? [];
        }
        applySessionArchiveRecords(latest);
        clearLegacyArchivedSessionIds(storage);
        writeArchiveMigrationDone(storage, ownerKey);
      } catch (error) {
        deps.reportError(error, "sessionArchives.migrateLegacy");
      } finally {
        sessionArchiveMigrationRunning = false;
      }
    })();
  });

  const archiveSession = async (workspaceId: string, sessionId: string) => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      deps.setError("A Veslo server connection or cloud sign-in is required to archive sessions.");
      return;
    }

    const group = deps.sidebarWorkspaceGroups().find((entry) => entry.workspace.id === workspaceId) ?? null;
    const session = group?.sessions.find((entry) => entry.id === sessionId) ?? null;
    if (!group || !session) return;

    await withPendingArchivedSession(workspaceId, sessionId, async () => {
      const response = await client.putSessionArchive(
        sessionId,
        buildSessionArchiveSnapshot({ session, workspace: group.workspace }),
      );
      applySessionArchiveRecords(response.items ?? []);
      clearLegacyArchivedSessionIds(storage);
      writeArchiveMigrationDone(storage, ownerKey);
    });
  };

  const unarchiveSession = async (
    workspaceId: string,
    sessionId: string,
    workspaceIdentityHint?: string | null,
  ) => {
    const client = deps.vesloArchiveClient();
    const ownerKey = deps.sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      deps.setError("A Veslo server connection or cloud sign-in is required to unarchive sessions.");
      return;
    }

    const workspaces = deps.workspaces();
    const normalizedIdentityHint = workspaceIdentityHint?.trim() ?? "";
    const archiveItem = sessionArchiveRecords()
      .map((record) => toSessionArchiveItem(record, workspaces))
      .find((item) =>
        item.sessionId === sessionId &&
        item.workspaceId === workspaceId &&
        (!normalizedIdentityHint || item.workspaceIdentity === normalizedIdentityHint)
      );
    const workspaceIdentity = normalizedIdentityHint || archiveItem?.workspaceIdentity?.trim() || undefined;

    await withPendingArchivedSession(workspaceId, sessionId, async () => {
      const response = await client.deleteSessionArchive(sessionId, { workspaceId, workspaceIdentity });
      applySessionArchiveRecords(response.items ?? []);
      clearLegacyArchivedSessionIds(storage);
      writeArchiveMigrationDone(storage, ownerKey);
    }, workspaceIdentity);
  };

  return {
    archivedSessionIds,
    sessionArchives,
    archiveSession,
    unarchiveSession,
  };
}
