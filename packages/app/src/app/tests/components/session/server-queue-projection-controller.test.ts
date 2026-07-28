import assert from "node:assert/strict";
import test from "node:test";

import type { VesloConversationQueueItem } from "../../../lib/veslo-server.js";
import {
  SERVER_QUEUE_PROJECTION_POLL_BACKOFF_MS,
  createServerQueueProjectionController,
} from "../../../components/session/server-queue-projection-controller.js";
import type { ServerQueuedRunProjectionScope } from "../../../components/session/server-queue-projection-model.js";

const scope = (uiConversationKey = "ui-a"): ServerQueuedRunProjectionScope => ({
  workspaceId: "ws-a",
  conversationId: "conv-a",
  uiConversationKey,
});

const item = (status: VesloConversationQueueItem["status"]): VesloConversationQueueItem => ({
  workspaceId: "ws-a",
  conversationId: "conv-a",
  opencodeSessionId: "ses-a",
  queueItemId: "queue-a",
  reservedRunId: "run-a",
  clientMessageId: "message-a",
  kind: "prompt_async",
  status,
  queuePosition: 1,
  order: { createdAt: 1, queueItemId: "queue-a" },
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
  error: status === "failed" ? "safe failure" : null,
});

type Timer = { callback: () => void; delayMs: number; cleared: boolean };

const flushAsyncWork = () => new Promise<void>((resolve) => setImmediate(resolve));

test("server queue projection ignores a stale hydration result", async () => {
  let activeScope: ServerQueuedRunProjectionScope | null = scope();
  let resolveFetch!: (value: VesloConversationQueueItem[]) => void;
  const replacements: VesloConversationQueueItem[][] = [];
  const controller = createServerQueueProjectionController({
    getScope: () => activeScope,
    fetchScope: () => new Promise((resolve) => {
      resolveFetch = resolve;
    }),
    replaceScope: (_scope, items) => replacements.push(items),
  });

  const refresh = controller.refresh();
  activeScope = scope("ui-b");
  resolveFetch([item("pending")]);

  assert.deepEqual(await refresh, { kind: "stale" });
  assert.deepEqual(replacements, []);
});

test("a stale hydration completion cannot stop polling for the newly active scope", async () => {
  const scopeA = scope("ui-a");
  const scopeB = scope("ui-b");
  let activeScope: ServerQueuedRunProjectionScope | null = scopeA;
  let resolveFirstFetch!: (value: VesloConversationQueueItem[]) => void;
  const timers: Timer[] = [];
  const controller = createServerQueueProjectionController({
    getScope: () => activeScope,
    fetchScope: (requestedScope) =>
      requestedScope.uiConversationKey === "ui-a"
        ? new Promise((resolve) => {
            resolveFirstFetch = resolve;
          })
        : Promise.resolve([item("pending")]),
    replaceScope: () => undefined,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as Timer).cleared = true;
    },
  });

  const staleRefresh = controller.refreshAndPoll(scopeA);
  activeScope = scopeB;
  await controller.refreshAndPoll(scopeB);
  resolveFirstFetch([item("pending")]);
  await staleRefresh;

  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.cleared, false, "the newer scope retains its polling timer");
});

test("server queue projection polls known waiting rows with bounded backoff and stops on terminal state", async () => {
  let activeScope: ServerQueuedRunProjectionScope | null = scope();
  const timers: Timer[] = [];
  const statuses: VesloConversationQueueItem[][] = [[item("pending")], [item("failed")]];
  const replacements: string[][] = [];
  const controller = createServerQueueProjectionController({
    getScope: () => activeScope,
    fetchScope: async () => statuses.shift() ?? [],
    replaceScope: (_scope, items) => replacements.push(items.map((row) => row.status)),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as Timer).cleared = true;
    },
  });

  assert.deepEqual(await controller.refreshAndPoll(), {
    kind: "updated",
    itemCount: 1,
    hasPollingRows: true,
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delayMs, SERVER_QUEUE_PROJECTION_POLL_BACKOFF_MS[0]);

  timers[0]?.callback();
  await flushAsyncWork();

  assert.deepEqual(replacements, [["pending"], ["failed"]]);
  assert.equal(timers.length, 1, "failed rows remain visible but do not schedule another poll");
  assert.equal(timers[0]?.cleared, false);
});

test("server queue projection stops polling when its scope changes or controller is disposed", async () => {
  let activeScope: ServerQueuedRunProjectionScope | null = scope();
  const timers: Timer[] = [];
  let fetchCount = 0;
  const controller = createServerQueueProjectionController({
    getScope: () => activeScope,
    fetchScope: async () => {
      fetchCount += 1;
      return [item("pending")];
    },
    replaceScope: () => undefined,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as Timer).cleared = true;
    },
  });

  await controller.refreshAndPoll();
  activeScope = scope("ui-b");
  timers[0]?.callback();
  await flushAsyncWork();
  assert.equal(fetchCount, 1, "scope change prevents the queued poll from issuing a stale request");

  activeScope = scope("ui-a");
  await controller.refreshAndPoll();
  const liveTimer = timers.at(-1);
  controller.dispose();
  assert.equal(liveTimer?.cleared, true);
  liveTimer?.callback();
  await flushAsyncWork();
  assert.equal(fetchCount, 2, "disposed controller cannot issue another request");
});

test("a burst of refreshes for one scope shares a single fetch", async () => {
  let fetchCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = scope();
  const controller = createServerQueueProjectionController({
    getScope: () => active,
    fetchScope: async () => {
      fetchCount += 1;
      await gate;
      return [item("failed")];
    },
    replaceScope: () => undefined,
  });

  // Reactive callers fire this in bursts. Without a guard each call started its
  // own fetch, and the transport only hid the duplicate request, not the
  // per-caller work that followed it.
  const bursts = [
    controller.refresh(active),
    controller.refresh(active),
    controller.refresh(active),
    controller.refreshAndPoll(active),
    controller.refresh(active),
  ];
  release();
  const results = await Promise.all(bursts);

  assert.equal(fetchCount, 1);
  assert.deepEqual(
    results.map((result) => result.kind),
    ["updated", "updated", "updated", "updated", "updated"],
  );

  // Once settled, a later refresh is a new fetch rather than a stale share.
  await controller.refresh(active);
  assert.equal(fetchCount, 2);
  controller.dispose();
});

test("refreshes for different scopes are not shared", async () => {
  const seen: string[] = [];
  let current = scope("ui-a");
  const controller = createServerQueueProjectionController({
    getScope: () => current,
    fetchScope: async (requested) => {
      seen.push(requested.uiConversationKey);
      return [];
    },
    replaceScope: () => undefined,
  });

  await controller.refresh(scope("ui-a"));
  current = scope("ui-b");
  await controller.refresh(scope("ui-b"));

  assert.deepEqual(seen, ["ui-a", "ui-b"]);
  controller.dispose();
});
