import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createRunStore, type RunRecord } from "../run-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "veslo-run-store-"));
  tempDirs.push(dir);
  return createRunStore({ dbPath: join(dir, "runs.sqlite") });
}

async function createTempDbPath() {
  const dir = await mkdtemp(join(tmpdir(), "veslo-run-store-"));
  tempDirs.push(dir);
  return join(dir, "runs.sqlite");
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    workspaceId: "ws-a",
    conversationId: "conv-a",
    runId: "run-a",
    engineSessionId: "sess-a",
    clientMessageId: null,
    origin: null,
    directory: "/tmp/workspace-a",
    kind: "prompt",
    status: "running",
    abortRequested: false,
    createdAt: 1_000,
    startedAt: 1_000,
    completedAt: null,
    error: null,
    engineSlotId: null,
    engineOwnerState: "pending",
    activityKind: null,
    waitReason: null,
    lastUsefulProgressAt: 1_000,
    retrySince: null,
    lastProgressSignature: null,
    engineOwnerId: null,
    enginePid: null,
    engineStartedAt: null,
    engineBaseUrl: null,
  };
  return { ...base, ...overrides };
}

describe("run store", () => {
  test("activeForConversation excludes terminal records", async () => {
    const store = await createTempStore();
    store.insert(record());

    expect(store.activeForConversation("ws-a", "conv-a")?.runId).toBe("run-a");

    store.update("ws-a", "run-a", {
      status: "completed",
      completedAt: 2_000,
    });

    expect(store.activeForConversation("ws-a", "conv-a")).toBeNull();
  });

  test("sqlite enforces one active run per conversation", async () => {
    const store = await createTempStore();
    store.insert(record());

    expect(() => store.insert(record({
      runId: "run-b",
      engineSessionId: "sess-b",
      createdAt: 1_100,
      startedAt: 1_100,
    }))).toThrow();
  });

  test("persists client, exact OpenCode message, and origin identities across updates", async () => {
    const store = await createTempStore();
    store.insert(record({
      clientMessageId: "msg-a",
      opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
      origin: "composer",
    }));

    expect(store.get("ws-a", "run-a")).toMatchObject({
      clientMessageId: "msg-a",
      opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
      origin: "composer",
    });

    store.update("ws-a", "run-a", {
      status: "blocked",
      waitReason: "running_tool",
    });

    expect(store.get("ws-a", "run-a")).toMatchObject({
      clientMessageId: "msg-a",
      opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
      origin: "composer",
      status: "blocked",
    });
  });

  test("hasActiveForWorkspace finds only recent active workspace runs", async () => {
    const store = await createTempStore();
    store.insert(record({
      runId: "old-active",
      conversationId: "conv-old",
      engineSessionId: "sess-old",
      createdAt: 1_000,
      status: "running",
    }));
    store.insert(record({
      runId: "recent-terminal",
      conversationId: "conv-terminal",
      engineSessionId: "sess-terminal",
      createdAt: 3_000,
      status: "completed",
      completedAt: 3_500,
    }));
    store.insert(record({
      runId: "other-workspace",
      workspaceId: "ws-b",
      conversationId: "conv-b",
      engineSessionId: "sess-b",
      createdAt: 4_000,
      status: "running",
    }));

    expect(store.hasActiveForWorkspace("ws-a", 2_000)).toBe(false);

    store.insert(record({
      runId: "recent-active",
      conversationId: "conv-recent",
      engineSessionId: "sess-recent",
      createdAt: 5_000,
      status: "submitted",
    }));

    expect(store.hasActiveForWorkspace("ws-a", 2_000)).toBe(true);
    expect(store.hasActiveForWorkspace("ws-a", 2_000, { excludeRunId: "recent-active" })).toBe(false);
    expect(store.hasActiveForWorkspace("ws-b", 2_000)).toBe(true);
    expect(store.hasActiveForWorkspace("missing", 0)).toBe(false);
  });

  test("activeCreatedBefore returns only old active rows", async () => {
    const store = await createTempStore();
    store.insert(record({
      runId: "old-active-a",
      conversationId: "conv-old-a",
      engineSessionId: "sess-old-a",
      createdAt: 1_000,
      status: "running",
    }));
    store.insert(record({
      runId: "old-active-b",
      conversationId: "conv-old-b",
      engineSessionId: "sess-old-b",
      createdAt: 1_500,
      status: "submitted",
    }));
    store.insert(record({
      runId: "recent-active",
      conversationId: "conv-recent",
      engineSessionId: "sess-recent",
      createdAt: 5_000,
      status: "running",
    }));
    store.insert(record({
      runId: "old-terminal",
      conversationId: "conv-terminal",
      engineSessionId: "sess-terminal",
      createdAt: 500,
      status: "failed",
      completedAt: 700,
    }));

    expect(store.activeCreatedBefore(2_000).map((item) => item.runId)).toEqual([
      "old-active-a",
      "old-active-b",
    ]);
    expect(store.activeCreatedBefore(2_000, 1).map((item) => item.runId)).toEqual(["old-active-a"]);
  });

  test("persists engine ownership metadata and lists active runs by engine owner", async () => {
    const store = await createTempStore();
    store.insert(record({
      runId: "run-engine-a",
      conversationId: "conv-engine-a",
      engineSessionId: "sess-engine-a",
      engineOwnerId: "ws-a",
      engineOwnerState: "attached",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
    }));
    store.insert(record({
      runId: "run-engine-terminal",
      conversationId: "conv-engine-terminal",
      engineSessionId: "sess-engine-terminal",
      engineOwnerId: "ws-a",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
      status: "failed",
      completedAt: 8_000,
    }));
    store.insert(record({
      runId: "run-engine-b",
      conversationId: "conv-engine-b",
      engineSessionId: "sess-engine-b",
      engineOwnerId: "shared-unsandboxed",
      engineOwnerState: "attached",
      enginePid: 84,
      engineStartedAt: 9_000,
      engineBaseUrl: "http://127.0.0.1:6000",
    }));

    expect(store.get("ws-a", "run-engine-a")).toMatchObject({
      engineOwnerId: "ws-a",
      enginePid: 42,
      engineStartedAt: 7_000,
      engineBaseUrl: "http://127.0.0.1:5000",
    });
    expect(store.activeForEngineOwner("ws-a").map((item) => item.runId)).toEqual(["run-engine-a"]);
    expect(store.activeForEngineOwner("shared-unsandboxed").map((item) => item.runId)).toEqual(["run-engine-b"]);
  });

  test("migrates legacy workspace run records to a server-owned workspace id", async () => {
    const store = await createTempStore();
    store.insert(record({
      workspaceId: "app-ws",
      runId: "run-legacy",
      conversationId: "conv-legacy",
      engineSessionId: "sess-legacy",
      engineOwnerId: "app-ws",
    }));

    const result = store.migrateWorkspaceId("app-ws", "server-ws");

    expect(result).toEqual({
      migrated: true,
      sourceWorkspaceId: "app-ws",
      targetWorkspaceId: "server-ws",
      updated: 1,
      reason: "migrated",
    });
    expect(store.get("app-ws", "run-legacy")).toBeNull();
    expect(store.get("server-ws", "run-legacy")).toMatchObject({
      workspaceId: "server-ws",
      engineOwnerId: "server-ws",
    });
    expect(store.latestForConversation("server-ws", "conv-legacy")?.runId).toBe("run-legacy");
  });

  test("does not migrate legacy run records when the target already has history", async () => {
    const store = await createTempStore();
    store.insert(record({
      workspaceId: "app-ws",
      runId: "run-legacy",
      conversationId: "conv-legacy",
      engineSessionId: "sess-legacy",
    }));
    store.insert(record({
      workspaceId: "server-ws",
      runId: "run-server",
      conversationId: "conv-server",
      engineSessionId: "sess-server",
    }));

    const result = store.migrateWorkspaceId("app-ws", "server-ws");

    expect(result).toEqual({
      migrated: false,
      sourceWorkspaceId: "app-ws",
      targetWorkspaceId: "server-ws",
      updated: 0,
      reason: "target_has_records",
    });
    expect(store.get("app-ws", "run-legacy")?.workspaceId).toBe("app-ws");
    expect(store.get("server-ws", "run-server")?.workspaceId).toBe("server-ws");
  });

  test("migrates existing run databases without engine ownership columns", async () => {
    const dbPath = await createTempDbPath();
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE conversation_run (
          workspace_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          engine_session_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          abort_requested INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          error TEXT,
          PRIMARY KEY (workspace_id, run_id)
        );
      `);
    } finally {
      db.close();
    }

    const store = createRunStore({ dbPath });
    store.insert(record({
      runId: "run-migrated",
      engineSessionId: "sess-migrated",
      engineOwnerId: "ws-a",
      enginePid: 123,
      engineStartedAt: 4_000,
      engineBaseUrl: "http://127.0.0.1:7000",
    }));

    expect(store.get("ws-a", "run-migrated")).toMatchObject({
      engineOwnerId: "ws-a",
      enginePid: 123,
      engineStartedAt: 4_000,
      engineBaseUrl: "http://127.0.0.1:7000",
    });
  });
});
