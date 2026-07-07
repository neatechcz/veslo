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

    store.markFailed(queued.item.queueItemId, "engine rejected queued run");

    const status = store.getForConversation("ws-a", "conv-a", queued.item.queueItemId);

    expect(status?.queueItemId).toBe(queued.item.queueItemId);
    expect(status?.state).toBe("failed");
    expect(status?.error).toBe("engine rejected queued run");
    expect(store.getForConversation("ws-other", "conv-a", queued.item.queueItemId)).toBeNull();
    expect(store.getForConversation("ws-a", "conv-other", queued.item.queueItemId)).toBeNull();
  });
});
