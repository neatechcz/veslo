import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../types";
import {
  appendQueuedDraft,
  firstQueuedDraft,
  markQueuedDraftEditing,
  markQueuedDraftError,
  markQueuedDraftQueued,
  markQueuedDraftSending,
  moveQueuedDraft,
  removeQueuedDraft,
  updateQueuedDraft,
} from "./session-queue-model.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("queue model appends and returns the first drain-eligible item", () => {
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

test("queue model reorders only drain-eligible items", () => {
  const queue = appendQueuedDraft(
    appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200),
    draft("three"),
    300,
  );
  const withSending = markQueuedDraftSending(queue, queue[1]!.id);
  const moved = moveQueuedDraft(withSending, queue[2]!.id, 0);

  assert.deepEqual(
    moved.map((item) => item.draft.text),
    ["three", "two", "one"],
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

test("queue model marks drafts sending and excludes them from draining", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200);
  const sending = markQueuedDraftSending(queue, queue[0]!.id, 300);
  const missing = markQueuedDraftSending(queue, "missing", 400);

  assert.equal(sending[0]!.state, "sending");
  assert.equal(sending[0]!.error, undefined);
  assert.equal(sending[0]!.updatedAt, 300);
  assert.equal(firstQueuedDraft(sending)?.draft.text, "two");
  assert.equal(missing, queue);
});

test("queue model marks drafts failed and keeps them drain-eligible", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const failed = markQueuedDraftError(queue, queue[0]!.id, "network failed", 200);
  const missing = markQueuedDraftError(queue, "missing", "ignored", 300);

  assert.equal(failed[0]!.state, "error");
  assert.equal(failed[0]!.error, "network failed");
  assert.equal(failed[0]!.updatedAt, 200);
  assert.equal(firstQueuedDraft(failed)?.draft.text, "one");
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

test("queue model marks drafts editing and excludes them from draining", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const failed = markQueuedDraftError(queue, queue[0]!.id, "network failed", 200);
  const editing = markQueuedDraftEditing(failed, queue[0]!.id, 300);
  const missing = markQueuedDraftEditing(queue, "missing", 400);

  assert.equal(editing[0]!.state, "editing");
  assert.equal(editing[0]!.error, undefined);
  assert.equal(editing[0]!.updatedAt, 300);
  assert.equal(firstQueuedDraft(editing), null);
  assert.equal(missing, queue);
});

test("queue model returns null when no draft is drain-eligible", () => {
  const queue = appendQueuedDraft(appendQueuedDraft([], draft("one"), 100), draft("two"), 200);
  const sending = markQueuedDraftSending(queue, queue[0]!.id);
  const updated = updateQueuedDraft(sending, queue[1]!.id, draft("two edited"), 300);
  const editing = markQueuedDraftEditing(updated, queue[1]!.id, 400);

  assert.equal(editing[1]!.updatedAt, 400);
  assert.equal(firstQueuedDraft(editing), null);
});
