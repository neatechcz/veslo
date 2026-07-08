import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createSessionArchiveStore,
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  SESSION_ARCHIVE_MIGRATION_KEY_PREFIX,
  type SessionArchiveClient,
} from "../../context/session-archive-store.js";
import type { WorkspaceSessionGroup } from "../../types.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import type { VesloSessionArchiveRecord } from "../../lib/veslo-server.js";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  const removals: string[] = [];

  return {
    writes,
    removals,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push({ key, value });
      values.set(key, value);
    },
    removeItem: (key: string) => {
      removals.push(key);
      values.delete(key);
    },
  };
}

function workspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws-1",
    name: "workspace-one",
    path: "/repo",
    preset: "opencode",
    workspaceType: "local",
    directory: "/repo",
    displayName: "Workspace One",
    ...overrides,
  };
}

function readyGroup(overrides: Partial<WorkspaceSessionGroup> = {}): WorkspaceSessionGroup {
  const info = workspace();
  return {
    workspace: info,
    status: "ready",
    error: null,
    sessions: [
      {
        id: "sess-a",
        title: "Build feature",
        directory: "/repo",
        time: { created: 10, updated: 20 },
      },
    ],
    ...overrides,
  };
}

function createArchiveClient(initial: VesloSessionArchiveRecord[] = []) {
  let records = [...initial];
  const calls: {
    list: number;
    puts: Array<{ sessionId: string; payload: Omit<VesloSessionArchiveRecord, "sessionId"> }>;
    deletes: Array<{
      sessionId: string;
      options?: { workspaceId?: string | null; workspaceIdentity?: string | null; directory?: string | null };
    }>;
  } = {
    list: 0,
    puts: [],
    deletes: [],
  };

  const recordDirectory = (record: Pick<VesloSessionArchiveRecord, "resolvedDirectoryAtArchive" | "projectRootAtArchive">) =>
    record.resolvedDirectoryAtArchive?.trim() || record.projectRootAtArchive?.trim() || "";
  const recordKey = (
    record: Pick<
      VesloSessionArchiveRecord,
      "sessionId" | "workspaceIdAtArchive" | "workspaceIdentity" | "resolvedDirectoryAtArchive" | "projectRootAtArchive"
    >,
  ) =>
    [
      record.workspaceIdAtArchive?.trim() || record.workspaceIdentity?.trim() || "",
      record.sessionId.trim(),
      recordDirectory(record),
    ]
      .filter(Boolean)
      .join("\0");
  const matchesDeleteScope = (
    record: VesloSessionArchiveRecord,
    sessionId: string,
    options?: { workspaceId?: string | null; workspaceIdentity?: string | null; directory?: string | null },
  ) => {
    if (record.sessionId !== sessionId) return false;
    const directory = options?.directory?.trim() ?? "";
    if (directory && recordDirectory(record) !== directory) return false;
    const workspaceId = options?.workspaceId?.trim() ?? "";
    const workspaceIdentity = options?.workspaceIdentity?.trim() ?? "";
    if (!workspaceId && !workspaceIdentity) return true;
    const recordWorkspaceId = record.workspaceIdAtArchive?.trim() ?? "";
    if (workspaceId && recordWorkspaceId) return recordWorkspaceId === workspaceId;
    const recordWorkspaceIdentity = record.workspaceIdentity?.trim() ?? "";
    if (workspaceIdentity && recordWorkspaceIdentity) return recordWorkspaceIdentity === workspaceIdentity;
    return false;
  };

  const client: SessionArchiveClient = {
    baseUrl: "http://veslo.test",
    token: "archive-token",
    listSessionArchives: async () => {
      calls.list += 1;
      return { items: records };
    },
    putSessionArchive: async (sessionId, payload) => {
      calls.puts.push({ sessionId, payload });
      const nextRecord = { sessionId, ...payload };
      records = [...records.filter((record) => recordKey(record) !== recordKey(nextRecord)), nextRecord];
      return { items: records };
    },
    deleteSessionArchive: async (sessionId, options) => {
      calls.deletes.push({ sessionId, options });
      records = records.filter((record) => !matchesDeleteScope(record, sessionId, options));
      return { items: records };
    },
  };

  return { client, calls };
}

function createManualEffectRunner() {
  const effects: Array<() => void> = [];

  return {
    effect: (fn: () => void) => {
      effects.push(fn);
      fn();
    },
    flush: async () => {
      for (let index = 0; index < 4; index += 1) {
        await settleEffects();
        for (const fn of effects) {
          fn();
        }
      }
      await settleEffects();
    },
  };
}

async function settleEffects() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

test("archive store handles missing client or owner without mutating records", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const errors: string[] = [];
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => null,
        sessionArchiveOwnerKey: () => "",
        vesloServerStatus: () => "disconnected",
        vesloServerCheckedAt: () => null,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: (message) => {
          if (message) errors.push(message);
        },
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      await store.archiveSession("ws-1", "sess-a");
      await store.unarchiveSession("ws-1", "sess-a");

      assert.deepEqual(store.archivedSessionIds(), []);
      assert.deepEqual(store.sessionArchives(), []);
      assert.deepEqual(errors, [
        "A Veslo server connection or cloud sign-in is required to archive sessions.",
        "A Veslo server connection or cloud sign-in is required to unarchive sessions.",
      ]);
    } finally {
      dispose();
    }
  });
});

test("legacy archive migration is marked complete only after sidebar groups settle", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage({
        [LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY]: JSON.stringify(["missing-session"]),
      });
      const effects = createManualEffectRunner();
      const { client, calls } = createArchiveClient();
      const [groups, setGroups] = createSignal<WorkspaceSessionGroup[]>([
        { workspace: workspace(), status: "loading", error: null, sessions: [] },
      ]);

      createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: groups,
        reportError: () => {},
        setError: () => {},
        storage,
        effect: effects.effect,
      });

      await effects.flush();
      assert.equal(calls.puts.length, 0);
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), null);
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), JSON.stringify(["missing-session"]));

      setGroups([{ workspace: workspace(), status: "ready", error: null, sessions: [] }]);
      await effects.flush();

      assert.equal(calls.puts.length, 0);
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), null);
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), "true");
    } finally {
      dispose();
    }
  });
});

test("archive and unarchive write owner migration key and publish updated records", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage();
      const effects = createManualEffectRunner();
      const { client, calls } = createArchiveClient();
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: () => {},
        storage,
        effect: effects.effect,
      });

      await effects.flush();
      await store.archiveSession("ws-1", "sess-a");

      assert.equal(calls.puts.length, 1);
      assert.equal(calls.puts[0]?.sessionId, "sess-a");
      assert.equal(calls.puts[0]?.payload.workspaceIdAtArchive, "ws-1");
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), "true");
      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["sess-a"]);
      assert.deepEqual(store.archivedSessionIds(), ["ws-1\0sess-a", "ws-1\0sess-a\0/repo"]);

      await store.unarchiveSession("ws-1", "sess-a");

      assert.deepEqual(calls.deletes, [
        {
          sessionId: "sess-a",
          options: {
            workspaceId: "ws-1",
            workspaceIdentity: "local:/repo",
          },
        },
      ]);
      assert.deepEqual(store.sessionArchives(), []);
      assert.deepEqual(store.archivedSessionIds(), []);
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), "true");
    } finally {
      dispose();
    }
  });
});

test("archive and unarchive can target duplicate session ids by directory", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage();
      const effects = createManualEffectRunner();
      const { client, calls } = createArchiveClient();
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [
          readyGroup({
            sessions: [
              {
                id: "shared",
                title: "Shared A",
                directory: "/repo/a",
                time: { created: 10, updated: 20 },
              },
              {
                id: "shared",
                title: "Shared B",
                directory: "/repo/b",
                time: { created: 30, updated: 40 },
              },
            ],
          }),
        ],
        reportError: () => {},
        setError: () => {},
        storage,
        effect: effects.effect,
      });

      await effects.flush();
      await store.archiveSession("ws-1", "shared", { directory: "/repo/a" });
      await store.archiveSession("ws-1", "shared", { directory: "/repo/b" });

      assert.deepEqual(
        store.sessionArchives().map((item) => item.resolvedDirectory).sort(),
        ["/repo/a", "/repo/b"],
      );
      assert.deepEqual(
        new Set(store.archivedSessionIds()),
        new Set(["ws-1\0shared", "ws-1\0shared\0/repo/a", "ws-1\0shared\0/repo/b"]),
      );

      await store.unarchiveSession("ws-1", "shared", null, { directory: "/repo/a" });

      assert.deepEqual(
        store.sessionArchives().map((item) => item.resolvedDirectory),
        ["/repo/b"],
      );
      assert.deepEqual(calls.deletes.at(-1), {
        sessionId: "shared",
        options: {
          workspaceId: "ws-1",
          workspaceIdentity: "local:/repo",
          directory: "/repo/a",
        },
      });
    } finally {
      dispose();
    }
  });
});
