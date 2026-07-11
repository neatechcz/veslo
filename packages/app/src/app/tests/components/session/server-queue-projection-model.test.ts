import assert from "node:assert/strict";
import test from "node:test";

import type { VesloConversationQueueItem } from "../../../lib/veslo-server.js";
import {
  replaceServerQueuedRunScope,
  serverQueuedRunsForVisibleConversation,
  serverQueuedRunsForScope,
  upsertServerQueuedRunProjection,
} from "../../../components/session/server-queue-projection-model.js";

const item = (queueItemId: string, overrides: Partial<VesloConversationQueueItem> = {}): VesloConversationQueueItem => ({
  workspaceId: "ws-a",
  conversationId: "conv-a",
  opencodeSessionId: "ses-a",
  queueItemId,
  reservedRunId: `run-${queueItemId}`,
  clientMessageId: `msg-${queueItemId}`,
  kind: "prompt_async",
  status: "pending",
  queuePosition: 1,
  order: { createdAt: 1, queueItemId },
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
  error: null,
  ...overrides,
});

test("server queue projection deduplicates by queue item id without using local draft content", () => {
  const first = upsertServerQueuedRunProjection([], item("queue-1"), "ui-a");
  const updated = upsertServerQueuedRunProjection(first, item("queue-1", { status: "failed", error: "safe failure" }), "ui-a");

  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.status, "failed");
  assert.equal(updated[0]?.error, "safe failure");
  assert.equal(updated[0]?.reservedRunId, "run-queue-1");
  assert.equal("draft" in (updated[0] ?? {}), false);

  const sameClientMessage = upsertServerQueuedRunProjection(
    updated,
    item("queue-2", { clientMessageId: "msg-queue-1" }),
    "ui-a",
  );
  assert.deepEqual(
    sameClientMessage.map((row) => row.queueItemId),
    ["queue-1", "queue-2"],
    "server rows are keyed only by their durable queue item id, never by local client message identity",
  );
});

test("server queue projection replaces only the captured workspace and conversation scope", () => {
  const current = [
    ...replaceServerQueuedRunScope([], { workspaceId: "ws-a", conversationId: "conv-a", uiConversationKey: "ui-a" }, [item("queue-a")]),
    ...replaceServerQueuedRunScope([], { workspaceId: "ws-b", conversationId: "conv-b", uiConversationKey: "ui-b" }, [item("queue-b", { workspaceId: "ws-b", conversationId: "conv-b" })]),
  ];
  const replaced = replaceServerQueuedRunScope(current, { workspaceId: "ws-a", conversationId: "conv-a", uiConversationKey: "ui-a-next" }, [item("queue-next")]);

  assert.deepEqual(serverQueuedRunsForScope(replaced, "ws-a", "conv-a").map((row) => row.queueItemId), ["queue-next"]);
  assert.deepEqual(serverQueuedRunsForScope(replaced, "ws-b", "conv-b").map((row) => row.queueItemId), ["queue-b"]);
});

test("server queue projection stays with its UI conversation while accepting a materialized id handoff", () => {
  const immediate = upsertServerQueuedRunProjection([], item("queue-1"), "pending-ui");

  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(immediate, {
      workspaceId: "ws-a",
      uiConversationKey: "pending-ui",
    }).map((row) => row.queueItemId),
    ["queue-1"],
  );
  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(immediate, {
      workspaceId: "ws-a",
      conversationId: "conv-a",
      uiConversationKey: "materialized-ui",
    }).map((row) => row.queueItemId),
    ["queue-1"],
  );
});

test("server queue projection removes a submitted handoff when its waiting-row refresh no longer returns it", () => {
  const projectionScope = { workspaceId: "ws-a", conversationId: "conv-a", uiConversationKey: "ui-a" };
  const waiting = replaceServerQueuedRunScope([], projectionScope, [item("queue-submitted")]);
  const afterLifecycleHandoff = replaceServerQueuedRunScope(waiting, projectionScope, []);

  assert.equal(waiting[0]?.reservedRunId, "run-queue-submitted");
  assert.deepEqual(afterLifecycleHandoff, []);
});
