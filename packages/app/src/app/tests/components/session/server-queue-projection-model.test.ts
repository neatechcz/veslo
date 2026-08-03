import assert from "node:assert/strict";
import test from "node:test";

import type { VesloConversationQueueItem } from "../../../lib/veslo-server.js";
import {
  retainServerQueuedRunProjectionScope,
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

const scope = (
  workspaceId = "ws-a",
  conversationId = "conv-a",
  uiConversationKey = "ui-a",
  selectionGeneration = 1,
) => ({ workspaceId, conversationId, uiConversationKey, selectionGeneration });

test("server queue projection deduplicates by queue item id without using local draft content", () => {
  const first = upsertServerQueuedRunProjection([], item("queue-1"), scope());
  const updated = upsertServerQueuedRunProjection(first, item("queue-1", { status: "failed", error: "safe failure" }), scope());

  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.status, "failed");
  assert.equal(updated[0]?.error, "safe failure");
  assert.equal(updated[0]?.reservedRunId, "run-queue-1");
  assert.equal("draft" in (updated[0] ?? {}), false);

  const sameClientMessage = upsertServerQueuedRunProjection(
    updated,
    item("queue-2", { clientMessageId: "msg-queue-1" }),
    scope(),
  );
  assert.deepEqual(
    sameClientMessage.map((row) => row.queueItemId),
    ["queue-1", "queue-2"],
    "server rows are keyed only by their durable queue item id, never by local client message identity",
  );
});

test("server queue projection replaces only the captured workspace and conversation scope", () => {
  const current = [
    ...replaceServerQueuedRunScope([], scope(), [item("queue-a")]),
    ...replaceServerQueuedRunScope([], scope("ws-b", "conv-b", "ui-b"), [item("queue-b", { workspaceId: "ws-b", conversationId: "conv-b" })]),
  ];
  const nextScope = scope("ws-a", "conv-a", "ui-a-next", 2);
  const replaced = replaceServerQueuedRunScope(current, nextScope, [item("queue-next")]);

  assert.deepEqual(serverQueuedRunsForScope(replaced, nextScope).map((row) => row.queueItemId), ["queue-next"]);
  assert.deepEqual(serverQueuedRunsForScope(replaced, scope("ws-b", "conv-b", "ui-b")).map((row) => row.queueItemId), ["queue-b"]);
});

test("server queue projection rejects a foreign queue-list item before it can inherit the selected UI key", () => {
  const projectionScope = scope("ws-a", "conv-a", "ui-a", 1);
  const projected = replaceServerQueuedRunScope([], projectionScope, [
    item("queue-a"),
    item("queue-foreign", { workspaceId: "ws-a", conversationId: "conv-b" }),
  ]);
  const afterForeignImmediate = upsertServerQueuedRunProjection(
    projected,
    item("queue-foreign-immediate", { workspaceId: "ws-a", conversationId: "conv-b" }),
    projectionScope,
  );

  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(afterForeignImmediate, projectionScope).map((row) => row.queueItemId),
    ["queue-a"],
  );
});

test("server queue projection stays with its UI conversation while accepting a materialized id handoff", () => {
  const immediate = upsertServerQueuedRunProjection([], item("queue-1"), scope("ws-a", "conv-a", "pending-ui"));

  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(immediate, {
      workspaceId: "ws-a",
      uiConversationKey: "pending-ui",
      selectionGeneration: 1,
    }).map((row) => row.queueItemId),
    ["queue-1"],
  );
  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(immediate, {
      workspaceId: "ws-a",
      conversationId: "conv-a",
      uiConversationKey: "materialized-ui",
      selectionGeneration: 1,
    }).map((row) => row.queueItemId),
    ["queue-1"],
  );
});

test("server queue projection does not render a prior selection generation after returning to the same conversation", () => {
  const firstSelection = scope("ws-a", "conv-a", "ui-a", 1);
  const reenteredSelection = scope("ws-a", "conv-a", "ui-a", 3);
  const stale = replaceServerQueuedRunScope([], firstSelection, [item("queue-stale")]);

  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(stale, reenteredSelection).map((row) => row.queueItemId),
    [],
  );
});

test("server queue projection evicts inactive selections instead of retaining a historical queue cache", () => {
  const first = scope("ws-a", "conv-a", "ui-a", 1);
  const second = scope("ws-a", "conv-b", "ui-b", 2);
  const third = scope("ws-a", "conv-c", "ui-c", 3);
  const historical = [
    ...replaceServerQueuedRunScope([], first, [item("queue-a")]),
    ...replaceServerQueuedRunScope([], second, [item("queue-b", { conversationId: "conv-b" })]),
    ...replaceServerQueuedRunScope([], third, [item("queue-c", { conversationId: "conv-c" })]),
  ];

  const retained = retainServerQueuedRunProjectionScope(historical, third);

  assert.deepEqual(retained.map((row) => row.queueItemId), ["queue-c"]);
  assert.deepEqual(
    serverQueuedRunsForVisibleConversation(retained, first).map((row) => row.queueItemId),
    [],
    "reopening a previous conversation must wait for a fresh scoped server list",
  );
});

test("server queue projection removes a submitted handoff when its waiting-row refresh no longer returns it", () => {
  const projectionScope = scope();
  const waiting = replaceServerQueuedRunScope([], projectionScope, [item("queue-submitted")]);
  const afterLifecycleHandoff = replaceServerQueuedRunScope(waiting, projectionScope, []);

  assert.equal(waiting[0]?.reservedRunId, "run-queue-submitted");
  assert.deepEqual(afterLifecycleHandoff, []);
});
