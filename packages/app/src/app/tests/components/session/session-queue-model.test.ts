import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../../types";
import {
  appendQueuedDraft as appendQueuedDraftModel,
  firstQueuedDraft,
  markQueuedDraftEditing,
  markQueuedDraftError,
  markQueuedDraftQueued,
  markQueuedDraftSending,
  moveQueuedDraft,
  removeQueuedDraft,
  resolveQueuedDraftSessionKey,
  restoreQueuedDraftAfterEditing,
  updateQueuedDraft,
} from "../../../components/session/session-queue-model.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

const appendQueuedDraft = (
  queue: Parameters<typeof appendQueuedDraftModel>[0],
  nextDraft: ComposerDraft,
  now = Date.now(),
  id = `draft-${now}`,
) => appendQueuedDraftModel(queue, nextDraft, { clientMessageId: `client-${id}` }, now, id);

test("queue model appends and returns the first drain-eligible item", () => {
  assert.equal(firstQueuedDraft([]), null);

  const queue = appendQueuedDraft([], draft("one"), 100);
  const next = appendQueuedDraft(queue, draft("two"), 200);

  assert.equal(next.length, 2);
  assert.equal(queue.length, 1);
  assert.equal(next[0]!.draft.text, "one");
  assert.equal(next[0]!.createdAt, 100);
  assert.equal(next[0]!.updatedAt, 100);
  assert.equal(next[0]!.state, "queued");
  assert.equal(next[1]!.draft.text, "two");
  assert.equal(firstQueuedDraft(next)?.draft.text, "one");
});

test("queue model appends deterministically with caller-provided id and timestamp", () => {
  const first = appendQueuedDraft([], draft("one"), 100, "draft-1");
  const second = appendQueuedDraft([], draft("one"), 100, "draft-1");

  assert.deepEqual(first, second);
  assert.equal(first[0]!.id, "draft-1");
});

test("queue model captures distinct client identities", () => {
  const first = appendQueuedDraftModel(
    [],
    draft("confirm"),
    { clientMessageId: "msg-confirm" },
    100,
    "row-confirm",
  );
  const second = appendQueuedDraftModel(
    first,
    draft("allow"),
    { clientMessageId: "msg-allow" },
    200,
    "row-allow",
  );
  const third = appendQueuedDraftModel(
    second,
    draft("disable"),
    { clientMessageId: "msg-disable" },
    300,
    "row-disable",
  );

  assert.deepEqual(
    third.map((item) => [item.id, item.clientMessageId]),
    [
      ["row-confirm", "msg-confirm"],
      ["row-allow", "msg-allow"],
      ["row-disable", "msg-disable"],
    ],
  );
});

test("queue model rotates identity only when edited content is saved and preserves it for retry", () => {
  const original = appendQueuedDraftModel(
    [],
    draft("original"),
    { clientMessageId: "msg-original" },
    100,
    "row-1",
  );
  const edited = updateQueuedDraft(
    original,
    "row-1",
    draft("edited"),
    200,
    { clientMessageId: "msg-edited" },
  );
  const retry = markQueuedDraftQueued(markQueuedDraftError(edited, "row-1", "response lost", 300), "row-1", 400);

  assert.equal(original[0]!.clientMessageId, "msg-original");
  assert.equal(edited[0]!.clientMessageId, "msg-edited");
  assert.equal(retry[0]!.clientMessageId, "msg-edited");
});

test("queue model captures a model override and allows an edit to clear it", () => {
  const selectedModel = { providerID: "codex_oauth", modelID: "gpt-5.6-sol" };
  const queued = appendQueuedDraftModel(
    [],
    draft("model snapshot"),
    { clientMessageId: "msg-model", modelOverride: selectedModel },
    100,
    "row-model",
  );
  const cleared = updateQueuedDraft(
    queued,
    "row-model",
    draft("use workspace default"),
    200,
    { clientMessageId: "msg-model-edited", modelOverride: null },
  );

  assert.deepEqual(queued[0]!.modelOverride, selectedModel);
  assert.equal(cleared[0]!.modelOverride, undefined);
});

test("queue model resolves a queued draft after session-key remap", () => {
  const pendingKey = "pending-draft:new-private";
  const remappedKey = "session-a";
  const unrelatedKey = "session-b";
  const remappedQueue = appendQueuedDraft([], draft("one"), 100, "queued-1");
  const originalQueue = appendQueuedDraft([], draft("original"), 100, "queued-2");

  assert.equal(
    resolveQueuedDraftSessionKey(
      {
        [pendingKey]: [],
        [unrelatedKey]: appendQueuedDraft([], draft("other"), 100, "queued-other"),
        [remappedKey]: remappedQueue,
      },
      pendingKey,
      "queued-1",
    ),
    remappedKey,
  );
  assert.equal(
    resolveQueuedDraftSessionKey({ [pendingKey]: originalQueue, [remappedKey]: remappedQueue }, pendingKey, "queued-2"),
    pendingKey,
  );
  assert.equal(resolveQueuedDraftSessionKey({ [remappedKey]: remappedQueue }, pendingKey, "missing"), pendingKey);
});

test("queue model updates drafts immutably", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const updated = updateQueuedDraft(queue, queue[0]!.id, draft("changed"), 200);
  const missing = updateQueuedDraft(queue, "missing", draft("ignored"), 300);

  assert.equal(updated.length, 1);
  assert.notEqual(updated, queue);
  assert.equal(updated[0]!.id, queue[0]!.id);
  assert.equal(updated[0]!.draft.text, "changed");
  assert.equal(updated[0]!.createdAt, 100);
  assert.equal(updated[0]!.updatedAt, 200);
  assert.equal(updated[0]!.state, "queued");
  assert.deepEqual(queue[0]!.draft, draft("one"));
  assert.equal(missing, queue);
});

test("queue model removes drafts immutably", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200);
  const removed = removeQueuedDraft(queue, queue[0]!.id);
  const missing = removeQueuedDraft(queue, "missing");

  assert.deepEqual(
    removed.map((item) => item.draft.text),
    ["two"],
  );
  assert.deepEqual(
    queue.map((item) => item.draft.text),
    ["one", "two"],
  );
  assert.equal(missing, queue);
});

test("queue model does not reorder around a blocked row", () => {
  const queue = appendQueuedDraft(
    appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200),
    draft("three"),
    300,
  );
  const withSending = markQueuedDraftSending(queue, queue[1]!.id);
  const moved = moveQueuedDraft(withSending, queue[2]!.id, 0);

  assert.deepEqual(
    moved.map((item) => item.draft.text),
    ["one", "two", "three"],
  );
  assert.equal(moved[1]!.state, "sending");
  assert.deepEqual(
    withSending.map((item) => item.draft.text),
    ["one", "two", "three"],
  );
});

test("queue model clamps reorder target indexes", () => {
  const queue = appendQueuedDraft(
    appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200),
    draft("three"),
    300,
  );

  assert.deepEqual(
    moveQueuedDraft(queue, queue[0]!.id, 99).map((item) => item.draft.text),
    ["two", "three", "one"],
  );
  assert.deepEqual(
    moveQueuedDraft(queue, queue[2]!.id, -10).map((item) => item.draft.text),
    ["three", "one", "two"],
  );
  assert.equal(moveQueuedDraft(queue, "missing", 0), queue);
});

test("queue model stops draining behind a sending head", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200);
  const sending = markQueuedDraftSending(queue, queue[0]!.id, 300);
  const missing = markQueuedDraftSending(queue, "missing", 400);

  assert.equal(sending[0]!.state, "sending");
  assert.equal(sending[0]!.error, undefined);
  assert.equal(sending[0]!.updatedAt, 300);
  assert.equal(firstQueuedDraft(sending), null);
  assert.equal(missing, queue);
});

test("queue model marks failed drafts as waiting for explicit retry", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const failed = markQueuedDraftError(queue, queue[0]!.id, "network failed", 200);
  const missing = markQueuedDraftError(queue, "missing", "ignored", 300);

  assert.equal(failed[0]!.state, "error");
  assert.equal(failed[0]!.error, "network failed");
  assert.equal(failed[0]!.updatedAt, 200);
  assert.equal(firstQueuedDraft(failed), null);
  assert.equal(missing, queue);
});

test("queue model marks drafts queued for retry and clears errors", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const failed = markQueuedDraftError(queue, queue[0]!.id, "network failed", 200);
  const retry = markQueuedDraftQueued(failed, queue[0]!.id, 300);
  const missing = markQueuedDraftQueued(queue, "missing", 400);

  assert.equal(retry[0]!.state, "queued");
  assert.equal(retry[0]!.error, undefined);
  assert.equal(retry[0]!.updatedAt, 300);
  assert.equal(firstQueuedDraft(retry)?.draft.text, "one");
  assert.equal(missing, queue);
});

test("queue model blocks later queued rows behind an error head", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("failed"), 100), draft("later"), 200);
  const failed = markQueuedDraftError(queue, queue[0]!.id, "network failed", 300);

  assert.equal(firstQueuedDraft(failed), null);
  assert.equal(firstQueuedDraft(markQueuedDraftQueued(failed, queue[0]!.id))?.draft.text, "failed");
});

test("queue model restores an unchanged failed edit with its original envelope", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const failed = {
    ...markQueuedDraftError(queue, queue[0]!.id, "network failed", 200)[0]!,
    clientMessageId: "msg-failed",
  };
  const failedQueue = [failed];
  const editing = markQueuedDraftEditing(failedQueue, queue[0]!.id, 300);
  const missing = markQueuedDraftEditing(failedQueue, "missing", 400);
  const restored = restoreQueuedDraftAfterEditing(editing, queue[0]!.id, 400);

  assert.equal(editing[0]!.state, "editing");
  assert.equal(editing[0]!.stateBeforeEditing, "error");
  assert.equal(editing[0]!.error, "network failed");
  assert.equal(editing[0]!.updatedAt, 300);
  assert.equal(firstQueuedDraft(editing), null);
  assert.equal(missing, failedQueue);
  assert.equal(restored[0]!.state, "error");
  assert.equal(restored[0]!.error, "network failed");
  assert.equal(restored[0]!.clientMessageId, "msg-failed");
  assert.equal(firstQueuedDraft(restored), null);
});

test("queue model returns null when no draft is drain-eligible", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200);
  const sending = markQueuedDraftSending(queue, queue[0]!.id);
  const updated = updateQueuedDraft(sending, queue[1]!.id, draft("two edited"), 300);
  const editing = markQueuedDraftEditing(updated, queue[1]!.id, 400);

  assert.equal(editing[1]!.updatedAt, 400);
  assert.equal(firstQueuedDraft(editing), null);
});
