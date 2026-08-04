import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import {
  createSessionArchiveStore,
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  SESSION_ARCHIVE_LOAD_ERROR_MESSAGE,
  SESSION_ARCHIVE_MIGRATION_KEY_PREFIX,
  type SessionArchiveClient,
} from "../../context/session-archive-store.js";
import type { WorkspaceSessionGroup } from "../../types.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import { VesloServerError, type VesloSessionArchiveRecord } from "../../lib/veslo-server.js";

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

function archiveRecord(
  sessionId: string,
  overrides: Partial<VesloSessionArchiveRecord> = {},
): VesloSessionArchiveRecord {
  return {
    sessionId,
    archivedAt: 10,
    titleSnapshot: sessionId,
    workspaceIdAtArchive: "ws-1",
    workspaceIdentity: "local:/repo",
    resolvedDirectoryAtArchive: "/repo",
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

test("archive store waits for a connected server health check before its initial load", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const { client, calls } = createArchiveClient([archiveRecord("sess-a")]);
      const [serverStatus, setServerStatus] = createSignal<"connected" | "disconnected">(
        "disconnected",
      );
      const [checkedAt, setCheckedAt] = createSignal<number | null>(null);
      const reported: unknown[] = [];
      const visibleErrors: Array<string | null> = [];
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: serverStatus,
        vesloServerCheckedAt: checkedAt,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: (error) => reported.push(error),
        setError: (message) => visibleErrors.push(message),
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      assert.equal(calls.list, 0);

      setServerStatus("connected");
      await effects.flush();
      assert.equal(calls.list, 0);

      setCheckedAt(1);
      await effects.flush();

      assert.equal(calls.list, 1);
      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["sess-a"]);
      assert.deepEqual(reported, []);
      assert.deepEqual(visibleErrors, []);
    } finally {
      dispose();
    }
  });
});

test("archive mutations trace the durable commit and the visible projection without recording content", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const { client } = createArchiveClient();
      const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: () => {},
        recordTrace: (event, payload) => traces.push({ event, payload }),
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      await store.archiveSession("ws-1", "sess-a");
      await store.unarchiveSession("ws-1", "sess-a");

      const hasTrace = (event: string, operation: string) => traces.some((entry) =>
        entry.event === event && entry.payload.operation === operation,
      );
      assert.equal(hasTrace("session-archive:mutation-requested", "archive"), true);
      assert.equal(hasTrace("session-archive:mutation-committed", "archive"), true);
      assert.equal(hasTrace("session-archive:projection-applied", "archive"), true);
      assert.equal(hasTrace("session-archive:mutation-requested", "unarchive"), true);
      assert.equal(hasTrace("session-archive:mutation-committed", "unarchive"), true);
      assert.equal(hasTrace("session-archive:projection-applied", "unarchive"), true);
      assert.equal(traces.some(({ payload }) => "directory" in payload || "title" in payload), false);
    } finally {
      dispose();
    }
  });
});

test("legacy archive migration retains unresolved ids until their sidebar session is available", async () => {
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
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), JSON.stringify(["missing-session"]));
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), null);

      setGroups([readyGroup({
        sessions: [{ id: "missing-session", title: "Recovered", directory: "/repo" }],
      })]);
      await effects.flush();

      assert.equal(calls.puts.length, 1);
      assert.equal(calls.puts[0]?.sessionId, "missing-session");
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), null);
      assert.equal(storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`), "true");
    } finally {
      dispose();
    }
  });
});

test("legacy archive migration merges into an existing server archive", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage({
        [LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY]: JSON.stringify(["sess-a"]),
      });
      const effects = createManualEffectRunner();
      const { client, calls } = createArchiveClient([archiveRecord("server-session")]);
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

      assert.equal(calls.puts.length, 1);
      assert.equal(calls.puts[0]?.sessionId, "sess-a");
      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId).sort(), ["server-session", "sess-a"]);
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

test("archive load discards a stale owner response after the archive scope changes", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const oldList = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const newList = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const oldClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-a-token",
        listSessionArchives: async () => oldList.promise,
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const newClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-b-token",
        listSessionArchives: async () => newList.promise,
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const [client, setClient] = createSignal<SessionArchiveClient | null>(oldClient);
      const [ownerKey, setOwnerKey] = createSignal("owner-a");
      const store = createSessionArchiveStore({
        vesloArchiveClient: client,
        sessionArchiveOwnerKey: ownerKey,
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: () => {},
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      setClient(newClient);
      setOwnerKey("owner-b");
      await effects.flush();

      newList.resolve({ items: [archiveRecord("current-session", { titleSnapshot: "Current owner" })] });
      await effects.flush();
      oldList.resolve({ items: [archiveRecord("stale-session", { titleSnapshot: "Stale owner" })] });
      await effects.flush();

      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["current-session"]);
    } finally {
      dispose();
    }
  });
});

test("archive load failure preserves legacy migration state and emits one typed desktop diagnostic", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage({
        [LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY]: JSON.stringify(["sess-a"]),
      });
      const effects = createManualEffectRunner();
      const reported: unknown[] = [];
      const diagnostics: Array<{ eventType: string; payload: unknown }> = [];
      const responseError = new VesloServerError(
        404,
        "non_json_response",
        "The Veslo server returned a non-JSON response.",
        undefined,
        {
          requestMethod: "GET",
          operation: "session-archives:list",
          requestOrigin: "http://veslo.test",
          requestPathname: "/session-archives",
          httpStatus: 404,
          mediaType: "text/plain",
          responseContentType: "text/plain",
          responseKind: "non_json",
          responsePreview: "Not Found",
        },
      );
      let listAttempts = 0;
      const client: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "archive-token",
        listSessionArchives: async () => {
          listAttempts += 1;
          if (listAttempts === 1) throw responseError;
          return { items: [] };
        },
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const [checkedAt, setCheckedAt] = createSignal<number | null>(1);
      let currentError: string | null = null;
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: checkedAt,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: (error) => reported.push(error),
        setError: (message) => {
          currentError = message;
        },
        getError: () => currentError,
        isTauriRuntime: () => true,
        recordBootstrapDiagnostic: (eventType, payload) => {
          diagnostics.push({ eventType, payload });
        },
        storage,
        effect: effects.effect,
      });

      await effects.flush();

      assert.equal(listAttempts, 1);
      assert.deepEqual(store.sessionArchives(), []);
      assert.equal(currentError, SESSION_ARCHIVE_LOAD_ERROR_MESSAGE);
      assert.deepEqual(reported, [responseError]);
      assert.deepEqual(diagnostics, [
        {
          eventType: "session-archives:load-failed",
          payload: {
            requestMethod: "GET",
            operation: "session-archives:list",
            requestOrigin: "http://veslo.test",
            requestPathname: "/session-archives",
            httpStatus: 404,
            mediaType: "text/plain",
            responseContentType: "text/plain",
            responseKind: "non_json",
            responsePreview: "Not Found",
          },
        },
      ]);
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), JSON.stringify(["sess-a"]));
      assert.equal(
        storage.getItem(SESSION_ARCHIVE_MIGRATION_KEY_PREFIX + "owner-a"),
        null,
      );

      setCheckedAt(2);
      await effects.flush();

      assert.equal(listAttempts, 2);
      assert.equal(currentError, null);
    } finally {
      dispose();
    }
  });
});

test("archive mutation wins over an older list response in the same archive scope", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const pendingList = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const client: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "archive-token",
        listSessionArchives: async () => pendingList.promise,
        putSessionArchive: async () => ({ items: [archiveRecord("sess-a")] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: () => {},
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await settleEffects();
      await store.archiveSession("ws-1", "sess-a");
      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["sess-a"]);

      pendingList.resolve({ items: [] });
      await effects.flush();

      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["sess-a"]);
    } finally {
      dispose();
    }
  });
});

test("archive store serializes same-scope mutations so an older snapshot cannot arrive last", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const firstPut = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const secondPut = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const putCalls: string[] = [];
      const client: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "archive-token",
        listSessionArchives: async () => ({ items: [] }),
        putSessionArchive: async (sessionId) => {
          putCalls.push(sessionId);
          return sessionId === "sess-a" ? firstPut.promise : secondPut.promise;
        },
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const store = createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup({
          sessions: [
            { id: "sess-a", title: "A", directory: "/repo" },
            { id: "sess-b", title: "B", directory: "/repo" },
          ],
        })],
        reportError: () => {},
        setError: () => {},
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      const archiveA = store.archiveSession("ws-1", "sess-a");
      const archiveB = store.archiveSession("ws-1", "sess-b");
      await settleEffects();
      assert.deepEqual(putCalls, ["sess-a"]);

      firstPut.resolve({ items: [archiveRecord("sess-a")] });
      await settleEffects();
      assert.deepEqual(putCalls, ["sess-a", "sess-b"]);

      secondPut.resolve({ items: [archiveRecord("sess-a"), archiveRecord("sess-b", { archivedAt: 20 })] });
      await Promise.all([archiveA, archiveB]);

      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["sess-b", "sess-a"]);
    } finally {
      dispose();
    }
  });
});

test("successful archive mutation confirms a scope after its initial list failure", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage({
        [LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY]: JSON.stringify(["sess-a"]),
      });
      const effects = createManualEffectRunner();
      const client: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "archive-token",
        listSessionArchives: async () => {
          throw new Error("archive list unavailable");
        },
        putSessionArchive: async () => ({ items: [archiveRecord("sess-a")] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
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
      await effects.flush();

      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), null);
      assert.equal(
        storage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}owner-a`),
        "true",
      );
    } finally {
      dispose();
    }
  });
});

test("archive load failure does not replace an unrelated global error", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      let listAttempts = 0;
      let currentError: string | null = "A different workflow failed.";
      const setErrorCalls: Array<string | null> = [];
      const [checkedAt, setCheckedAt] = createSignal<number | null>(1);
      const client: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "archive-token",
        listSessionArchives: async () => {
          listAttempts += 1;
          if (listAttempts === 1) throw new Error("archive list unavailable");
          return { items: [] };
        },
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      createSessionArchiveStore({
        vesloArchiveClient: () => client,
        sessionArchiveOwnerKey: () => "owner-a",
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: checkedAt,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: (message) => {
          setErrorCalls.push(message);
          currentError = message;
        },
        getError: () => currentError,
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      assert.equal(currentError, "A different workflow failed.");
      assert.deepEqual(setErrorCalls, []);

      setCheckedAt(2);
      await effects.flush();
      assert.equal(currentError, "A different workflow failed.");
      assert.deepEqual(setErrorCalls, []);
    } finally {
      dispose();
    }
  });
});

test("archive mutation ignores a stale response after the owner changes", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const stalePut = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      const oldClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-a-token",
        listSessionArchives: async () => ({ items: [] }),
        putSessionArchive: async () => stalePut.promise,
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const newClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-b-token",
        listSessionArchives: async () => ({ items: [archiveRecord("owner-b-session")] }),
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const [client, setClient] = createSignal<SessionArchiveClient | null>(oldClient);
      const [ownerKey, setOwnerKey] = createSignal("owner-a");
      const store = createSessionArchiveStore({
        vesloArchiveClient: client,
        sessionArchiveOwnerKey: ownerKey,
        vesloServerStatus: () => "connected",
        vesloServerCheckedAt: () => 1,
        workspaces: () => [workspace()],
        sidebarWorkspaceGroups: () => [readyGroup()],
        reportError: () => {},
        setError: () => {},
        storage: createMemoryStorage(),
        effect: effects.effect,
      });

      await effects.flush();
      const archive = store.archiveSession("ws-1", "sess-a");
      await settleEffects();

      setClient(newClient);
      setOwnerKey("owner-b");
      await effects.flush();
      stalePut.resolve({ items: [archiveRecord("stale-session")] });
      await archive;
      await effects.flush();

      assert.deepEqual(store.sessionArchives().map((item) => item.sessionId), ["owner-b-session"]);
    } finally {
      dispose();
    }
  });
});

test("legacy archive migration ignores a stale write after the owner changes", async () => {
  await createRoot(async (dispose) => {
    try {
      const storage = createMemoryStorage({
        [LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY]: JSON.stringify(["sess-a"]),
      });
      const effects = createManualEffectRunner();
      const staleMigrationPut = createDeferred<{ items: VesloSessionArchiveRecord[] }>();
      let oldMigrationCalls = 0;
      const oldClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-a-token",
        listSessionArchives: async () => ({ items: [] }),
        putSessionArchive: async () => {
          oldMigrationCalls += 1;
          return staleMigrationPut.promise;
        },
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const newClient: SessionArchiveClient = {
        baseUrl: "http://veslo.test",
        token: "owner-b-token",
        listSessionArchives: async () => ({ items: [] }),
        putSessionArchive: async () => ({ items: [] }),
        deleteSessionArchive: async () => ({ items: [] }),
      };
      const [client, setClient] = createSignal<SessionArchiveClient | null>(oldClient);
      const [ownerKey, setOwnerKey] = createSignal("owner-a");
      const [groups, setGroups] = createSignal<WorkspaceSessionGroup[]>([readyGroup()]);
      const store = createSessionArchiveStore({
        vesloArchiveClient: client,
        sessionArchiveOwnerKey: ownerKey,
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
      assert.equal(oldMigrationCalls, 1);

      setGroups([{ workspace: workspace(), status: "loading", error: null, sessions: [] }]);
      setClient(newClient);
      setOwnerKey("owner-b");
      await effects.flush();
      staleMigrationPut.resolve({ items: [archiveRecord("stale-session")] });
      await effects.flush();

      assert.deepEqual(store.sessionArchives(), []);
      assert.equal(storage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY), JSON.stringify(["sess-a"]));
      assert.equal(storage.getItem(SESSION_ARCHIVE_MIGRATION_KEY_PREFIX + "owner-a"), null);
    } finally {
      dispose();
    }
  });
});
