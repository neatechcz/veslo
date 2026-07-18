import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationRunQueueStore } from "../conversation-run-queue-store.js";

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

  test("recovers starting rows so startup can drain them again", async () => {
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
    const recovered = store.recoverStarting();

    expect(recovered).toEqual([{ workspaceId: "ws-a", conversationId: "conv-a" }]);
    const pending = store.nextPending("ws-a", "conv-a");
    expect(pending?.queueItemId).toBe(queued.item.queueItemId);
    expect(pending?.state).toBe("pending");
    expect(pending?.activeRunId).toBeNull();
    expect(pending?.startedAt).toBeNull();
    expect(pending?.attempts).toBe(1);
    expect(store.pendingConversationKeys()).toEqual([{ workspaceId: "ws-a", conversationId: "conv-a" }]);
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
      firstStore.markStarting(queued.item.queueItemId),
      secondStore.markStarting(queued.item.queueItemId),
    ];

    expect(claims.filter((claim) => claim?.state === "starting")).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(firstStore.getForConversation("ws-a", "conv-a", queued.item.queueItemId)?.state).toBe("starting");
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
    });
    expect(reserved.state).toBe("starting");
    expect(first.activateWorkspaceRun("ws-a", "run-a")?.state).toBe("active");

    const restarted = createConversationRunQueueStore({ dataDir, now: () => 3_000 });
    expect(restarted.listWorkspaceRunReservations()).toEqual([
      expect.objectContaining({ workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a", state: "active" }),
    ]);
    expect(restarted.releaseWorkspaceRun("ws-a", "run-a")).toBe(true);
    expect(restarted.releaseWorkspaceRun("ws-a", "run-a")).toBe(false);
    expect(restarted.listWorkspaceRunReservations()).toEqual([]);
  });
});
