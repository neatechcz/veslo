import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  ConversationRunReservationConflictError,
  createConversationRunQueueStore,
} from "../conversation-run-queue-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDataDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-conversation-run-queue-"));
  tempDirs.push(dir);
  return dir;
};

describe("conversation run queue store", () => {
  test("enqueue is idempotent by client message id", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 1_000 });
    const input = {
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      clientMessageId: "msg-a",
      origin: "session:normal",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
      activeRunId: "run-active",
    };

    const first = store.enqueue(input);
    const second = store.enqueue({ ...input, reservedRunId: "run-b" });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.item.queueItemId).toBe(first.item.queueItemId);
    expect(second.item.reservedRunId).toBe("run-a");
    expect(store.nextPending("ws-a", "conv-a")?.queueItemId).toBe(first.item.queueItemId);
  });

  test("enqueue rejects same client message id with different request body", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 1_500 });
    const input = {
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      clientMessageId: "msg-a",
      origin: "session:normal",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
      activeRunId: "run-active",
    };

    store.enqueue(input);

    expect(() =>
      store.enqueue({
        ...input,
        reservedRunId: "run-b",
        bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "different" }] }),
      })
    ).toThrow("clientMessageId was already used for a different queued run request");

    expect(store.nextPending("ws-a", "conv-a")?.reservedRunId).toBe("run-a");
  });

  test("workspace-wide idempotency conflicts when the same key targets another conversation", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 1_600 });
    const input = {
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      clientMessageId: "msg-cross-conversation",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
    };

    const first = store.enqueue(input);
    expect(() => store.enqueue({
      ...input,
      conversationId: "conv-b",
      opencodeSessionId: "sess-b",
      reservedRunId: "run-b",
    })).toThrow("clientMessageId was already used for a different queued run request");
    expect(() => store.enqueue({
      ...input,
      conversationId: "conv-b",
      opencodeSessionId: "sess-b",
      reservedRunId: "run-c",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "different" }] }),
    })).toThrow("clientMessageId was already used for a different queued run request");
    expect(first.item.conversationId).toBe("conv-a");
  });

  test("legacy duplicate migration conflicts only pre-handoff rows and preserves submitted handoff evidence", async () => {
    const dataDir = await tempDataDir();
    const dbPath = join(dataDir, "conversations", "run-queue.sqlite");
    await mkdir(join(dataDir, "conversations"), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE conversation_run_queue (
        queue_item_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        opencode_session_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        reserved_run_id TEXT NOT NULL,
        client_message_id TEXT,
        origin TEXT,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        request_hash TEXT,
        state TEXT NOT NULL,
        active_run_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        submitted_at INTEGER,
        completed_at INTEGER,
        error TEXT
      );
      CREATE UNIQUE INDEX conversation_run_queue_client_message_uidx
        ON conversation_run_queue (workspace_id, conversation_id, client_message_id)
        WHERE client_message_id IS NOT NULL AND client_message_id <> '';
    `);
    const insert = db.query(`
      INSERT INTO conversation_run_queue (
        queue_item_id, workspace_id, conversation_id, opencode_session_id,
        directory, reserved_run_id, client_message_id, origin, kind, body_json,
        request_hash, state, active_run_id, attempts, created_at, updated_at,
        started_at, submitted_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'prompt_async', ?, NULL, ?, NULL, 0, ?, ?, NULL, NULL, NULL, NULL)
    `);
    const body = JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] });
    insert.run("queue-b", "ws-a", "conv-b", "sess-b", "/tmp/workspace-a", "run-b", "msg-legacy", body, "submitted", 1_000, 1_000);
    insert.run("queue-a", "ws-a", "conv-a", "sess-a", "/tmp/workspace-a", "run-a", "msg-legacy", body, "pending", 1_001, 1_001);
    db.close();

    const store = createConversationRunQueueStore({ dataDir, now: () => 2_000 });
    const pending = store.getForConversation("ws-a", "conv-a", "queue-a");
    const submitted = store.getForConversation("ws-a", "conv-b", "queue-b");

    expect(pending?.state).toBe("conflict");
    expect(pending?.idempotencyConflictClientMessageId).toBe("msg-legacy");
    expect(submitted?.state).toBe("submitted");
    expect(submitted?.idempotencyConflictClientMessageId).toBeNull();
    expect(submitted?.clientMessageId).toBe("msg-legacy");
  });

  test("lists starting rows without changing their unknown submit outcome", async () => {
    let timestamp = 2_000;
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => timestamp });
    const queued = store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
      activeRunId: "run-active",
    });
    const starting = store.markStarting(queued.item.queueItemId);
    expect(starting?.state).toBe("starting");
    expect(store.nextPending("ws-a", "conv-a")).toBeNull();

    timestamp = 3_000;
    const recovered = store.listStarting();

    expect(recovered.map((item) => item.queueItemId)).toEqual([queued.item.queueItemId]);
    expect(recovered[0]?.state).toBe("starting");
    expect(recovered[0]?.attempts).toBe(1);
    expect(store.nextPending("ws-a", "conv-a")).toBeNull();
    expect(store.pendingConversationKeys()).toEqual([]);
  });

  test("marks pending items through starting and submitted states", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    const queued = store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
      activeRunId: "run-active",
    });

    const starting = store.markStarting(queued.item.queueItemId);
    expect(starting?.state).toBe("starting");
    expect(starting?.attempts).toBe(1);

    const submitted = store.markSubmitted(queued.item.queueItemId);
    expect(submitted?.state).toBe("submitted");
    expect(store.nextPending("ws-a", "conv-a")).toBeNull();
  });

  test("claims a pending row exactly once across two stores sharing one SQLite file", async () => {
    const dataDir = await tempDataDir();
    const firstStore = createConversationRunQueueStore({ dataDir, now: () => 2_000 });
    const secondStore = createConversationRunQueueStore({ dataDir, now: () => 2_001 });
    const queued = firstStore.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
    });

    const claims = [
      firstStore.claimStartingWithReservation(queued.item.queueItemId),
      secondStore.claimStartingWithReservation(queued.item.queueItemId),
    ];

    expect(claims.filter((claim) => claim?.item.state === "starting")).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(firstStore.getForConversation("ws-a", "conv-a", queued.item.queueItemId)?.state).toBe("starting");
    expect(firstStore.listWorkspaceRunReservations()).toEqual([
      expect.objectContaining({ workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a" }),
    ]);
  });

  test("rolls a conflicting admission claim back to pending", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    store.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-active",
    });
    const queued = store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-queued",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
    });

    expect(() => store.claimStartingWithReservation(queued.item.queueItemId))
      .toThrow(ConversationRunReservationConflictError);
    expect(store.getForConversation("ws-a", "conv-a", queued.item.queueItemId)).toEqual(
      expect.objectContaining({ state: "pending", attempts: 0 }),
    );
  });

  test("guards stale queue transitions without overwriting the winning state", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    const queued = store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
    });

    expect(store.markPending(queued.item.queueItemId, "run-other")).toBeNull();
    expect(store.markSubmitted(queued.item.queueItemId)).toBeNull();
    expect(store.markFailed(queued.item.queueItemId, "stale failure")).toBeNull();
    expect(store.getForConversation("ws-a", "conv-a", queued.item.queueItemId)?.state).toBe("pending");

    expect(store.markStarting(queued.item.queueItemId)?.state).toBe("starting");
    expect(store.markPending(queued.item.queueItemId, "run-active")?.state).toBe("pending");
    expect(store.markSubmitted(queued.item.queueItemId)).toBeNull();
    expect(store.markFailed(queued.item.queueItemId, "stale failure")).toBeNull();
    expect(store.getForConversation("ws-a", "conv-a", queued.item.queueItemId)?.state).toBe("pending");

    expect(store.markStarting(queued.item.queueItemId)?.state).toBe("starting");
    expect(store.markSubmitted(queued.item.queueItemId)?.state).toBe("submitted");
    expect(store.markFailed(queued.item.queueItemId, "late failure")).toBeNull();
    expect(store.getForConversation("ws-a", "conv-a", queued.item.queueItemId)?.state).toBe("submitted");
  });

  test("lists scoped readable rows in stable cursor order without submitted rows", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    const enqueue = (clientMessageId: string) => store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: `run-${clientMessageId}`,
      clientMessageId,
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: clientMessageId }] }),
    }).item;
    const pending = enqueue("pending");
    const starting = enqueue("starting");
    const failed = enqueue("failed");
    const submitted = enqueue("submitted");
    store.markStarting(starting.queueItemId);
    store.markStarting(failed.queueItemId);
    store.markFailed(failed.queueItemId, "failed");
    store.markStarting(submitted.queueItemId);
    store.markSubmitted(submitted.queueItemId);

    const all = store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      states: ["pending", "starting", "failed"],
      limit: 100,
    });
    const firstPage = store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      states: ["pending", "starting", "failed"],
      limit: 2,
    });
    const secondPage = store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      states: ["pending", "starting", "failed"],
      cursor: firstPage.nextCursor,
      limit: 2,
    });

    expect(all.items.map(({ item }) => item.queueItemId)).toEqual([
      ...firstPage.items.map(({ item }) => item.queueItemId),
      ...secondPage.items.map(({ item }) => item.queueItemId),
    ]);
    expect(all.items.map(({ item }) => item.queueItemId)).toEqual(expect.not.arrayContaining([submitted.queueItemId]));
    expect(firstPage.nextCursor).toEqual({
      createdAt: firstPage.items[1]?.item.createdAt,
      queueItemId: firstPage.items[1]?.item.queueItemId,
    });
    const waitingPositions = all.items
      .filter(({ item }) => item.queueItemId === pending.queueItemId || item.queueItemId === starting.queueItemId)
      .map(({ queuePosition }) => queuePosition)
      .sort();
    expect(waitingPositions).toEqual([1, 2]);
    expect(all.items.find(({ item }) => item.queueItemId === failed.queueItemId)?.queuePosition).toBeNull();
  });

  test("rejects unbounded list inputs and keeps workspace/conversation scope isolated", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [] }),
    });

    expect(() => store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      states: ["submitted" as never],
      limit: 1,
    })).toThrow("states must contain only pending, starting, or failed");
    expect(() => store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      states: ["pending"],
      limit: 101,
    })).toThrow("limit must be an integer from 1 to 100");
    expect(store.listForConversation({
      workspaceId: "ws-a",
      conversationId: "conv-other",
      states: ["pending"],
      limit: 10,
    }).items).toEqual([]);
    expect(store.listForConversation({
      workspaceId: "ws-other",
      conversationId: "conv-a",
      states: ["pending"],
      limit: 10,
    }).items).toEqual([]);
  });

  test("reads queue item status only inside its workspace and conversation", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    const queued = store.enqueue({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      reservedRunId: "run-a",
      clientMessageId: "msg-a",
      kind: "prompt_async",
      bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "hello" }] }),
      activeRunId: "run-active",
    });

    store.markStarting(queued.item.queueItemId);
    store.markFailed(queued.item.queueItemId, "engine rejected queued run");

    const status = store.getForConversation("ws-a", "conv-a", queued.item.queueItemId);

    expect(status?.queueItemId).toBe(queued.item.queueItemId);
    expect(status?.state).toBe("failed");
    expect(status?.error).toBe("engine rejected queued run");
    expect(store.getForConversation("ws-other", "conv-a", queued.item.queueItemId)).toBeNull();
    expect(store.getForConversation("ws-a", "conv-other", queued.item.queueItemId)).toBeNull();
  });

  test("persists workspace run reservations until their idempotent release", async () => {
    const dataDir = await tempDataDir();
    const first = createConversationRunQueueStore({ dataDir, now: () => 2_000 });
    const reserved = first.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
      directory: "C:/repo",
      opencodeSessionId: "sess-a",
    });
    expect(reserved.state).toBe("starting");
    expect(first.activateWorkspaceRun("ws-a", "run-a")?.state).toBe("active");
    expect(first.markWorkspaceRunProviderStartAbortPending({
      workspaceId: "ws-a",
      runId: "run-a",
      directory: "C:/repo",
      opencodeSessionId: "sess-a",
    })).toEqual(expect.objectContaining({ providerStartAbortPending: true }));

    const restarted = createConversationRunQueueStore({ dataDir, now: () => 3_000 });
    expect(restarted.listWorkspaceRunReservations()).toEqual([
      expect.objectContaining({
        workspaceId: "ws-a",
        conversationId: "conv-a",
        runId: "run-a",
        state: "active",
        providerStartAbortPending: true,
        providerStartAbortDirectory: "C:/repo",
        providerStartAbortOpenCodeSessionId: "sess-a",
      }),
    ]);
    expect(restarted.releaseWorkspaceRun("ws-a", "run-a")).toBe(true);
    expect(restarted.releaseWorkspaceRun("ws-a", "run-a")).toBe(false);
    expect(restarted.listWorkspaceRunReservations()).toEqual([]);
  });

  test("rejects a second active reservation for the same conversation", async () => {
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => 2_000 });
    store.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
    });

    expect(() => store.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-b",
    })).toThrow(ConversationRunReservationConflictError);
    expect(store.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-b",
      runId: "run-b",
    }).runId).toBe("run-b");
  });

  test("persists the exact engine generation owner and rejects a stale replacement", async () => {
    const dataDir = await tempDataDir();
    const store = createConversationRunQueueStore({ dataDir, now: () => 2_000 });
    store.reserveWorkspaceRun({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
    });
    const owner = {
      engineSlotId: "ws-a",
      engineOwnerId: "generation-1",
      directoryInstanceEpoch: 7,
      enginePid: 101,
      engineStartedAt: 1_000,
      engineBaseUrl: "http://127.0.0.1:4101",
      skillViewRevision: "skill-view-1",
      authorizationRevision: "authorization-1",
      openCodeConfigDigest: "config-1",
    };
    expect(store.attachWorkspaceRunEngineOwner("ws-a", "run-a", owner)).toEqual(
      expect.objectContaining(owner),
    );
    expect(store.attachWorkspaceRunEngineOwner("ws-a", "run-a", {
      ...owner,
      engineOwnerId: "generation-2",
      enginePid: 202,
      engineStartedAt: 2_000,
      engineBaseUrl: "http://127.0.0.1:4202",
    })).toBeNull();
    expect(store.attachWorkspaceRunEngineOwner("ws-a", "run-a", {
      ...owner,
      engineSlotId: "other-slot",
    })).toBeNull();
    expect(store.attachWorkspaceRunEngineOwner("ws-a", "run-a", {
      ...owner,
      skillViewRevision: "skill-view-2",
    })).toBeNull();
    expect(store.attachWorkspaceRunEngineOwner("ws-a", "run-a", {
      ...owner,
      directoryInstanceEpoch: 8,
    })).toBeNull();

    const restarted = createConversationRunQueueStore({ dataDir, now: () => 3_000 });
    expect(restarted.listWorkspaceRunReservations()).toEqual([
      expect.objectContaining(owner),
    ]);
  });

  test("persists one active runtime-operation lease per workspace across store instances", async () => {
    const dataDir = await tempDataDir();
    const store = createConversationRunQueueStore({ dataDir, now: () => 1_000 });
    const acquired = store.acquireWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-a",
      kind: "rebind_control_plane",
      sourceClass: "automatic",
      reasonCode: "sse_invalid_bearer",
      expiresAt: 2_000,
    });

    expect(acquired).toEqual({
      acquired: true,
      operation: expect.objectContaining({
        workspaceId: "ws-a",
        operationId: "operation-a",
        state: "granted",
      }),
    });
    expect(store.beginWorkspaceRuntimeOperation("ws-a", "operation-a")).toEqual(
      expect.objectContaining({ state: "executing" }),
    );

    const restarted = createConversationRunQueueStore({ dataDir, now: () => 1_500 });
    const duplicate = restarted.acquireWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-b",
      kind: "rebind_control_plane",
      sourceClass: "automatic",
      reasonCode: "sse_invalid_bearer",
      expiresAt: 2_500,
    });
    expect(duplicate).toEqual({
      acquired: false,
      operation: expect.objectContaining({
        operationId: "operation-a",
        state: "executing",
      }),
    });
  });

  test("does not allow an expired or completed runtime-operation lease to block later work", async () => {
    let currentTime = 1_000;
    const store = createConversationRunQueueStore({ dataDir: await tempDataDir(), now: () => currentTime });
    store.acquireWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-a",
      kind: "rebind_control_plane",
      sourceClass: "automatic",
      reasonCode: "sse_invalid_bearer",
      expiresAt: 1_500,
    });
    expect(store.completeWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "wrong-operation",
      state: "completed",
    })).toBeNull();
    expect(store.completeWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-a",
      state: "completed",
      terminalCode: "rebound",
    })).toEqual(expect.objectContaining({ state: "completed", terminalCode: "rebound" }));

    const afterCompletion = store.acquireWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-b",
      kind: "reload_workspace_if_idle",
      sourceClass: "user",
      reasonCode: "manual_reload",
      expiresAt: 2_000,
    });
    expect(afterCompletion.acquired).toBe(true);

    currentTime = 2_100;
    expect(store.expireWorkspaceRuntimeOperations()).toEqual([
      expect.objectContaining({ operationId: "operation-b", state: "outcome_unknown", terminalCode: "lease_expired" }),
    ]);
    expect(store.listActiveWorkspaceRuntimeOperations()).toEqual([]);
    expect(store.acquireWorkspaceRuntimeOperation({
      workspaceId: "ws-a",
      operationId: "operation-c",
      kind: "rebind_control_plane",
      sourceClass: "automatic",
      reasonCode: "sse_invalid_bearer",
      expiresAt: 3_000,
    })).toEqual(expect.objectContaining({ acquired: true }));
  });
});
