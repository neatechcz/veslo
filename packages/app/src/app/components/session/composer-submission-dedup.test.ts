import assert from "node:assert/strict";
import test from "node:test";

import { createComposerSubmissionDeduplication } from "./composer-submission-dedup";

const draft = (text: string) => ({
  mode: "prompt" as const,
  parts: [{ type: "text" as const, text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("unchanged draft can only acquire one in-flight submission", () => {
  const deduplication = createComposerSubmissionDeduplication();
  const first = deduplication.acquire(draft("same input"));

  assert.ok(first);
  assert.equal(deduplication.acquire(draft("same input")), null);
  const changed = deduplication.acquire(draft("changed input"));
  assert.ok(changed);

  // Typing a change and reverting it must not reopen the first accepted
  // draft while its handoff is still pending.
  assert.equal(deduplication.acquire(draft("same input")), null);

  // Releasing an older handoff cannot reopen the newer visible draft.
  deduplication.release(first);
  assert.equal(deduplication.acquire(draft("changed input")), null);
  assert.ok(deduplication.acquire(draft("same input")));
});

test("accepted drafts remain protected until their owner confirms a clear", () => {
  const deduplication = createComposerSubmissionDeduplication();
  const accepted = deduplication.acquire(draft("same input"));

  assert.ok(accepted);
  // A completed request alone is not sufficient: the Composer can still be
  // showing the same draft while ownership is transferred to the session.
  assert.equal(deduplication.acquire(draft("same input")), null);

  deduplication.release(accepted);
  assert.ok(deduplication.acquire(draft("same input")));
});

test("large pasted content does not become a large retained admission key", () => {
  const deduplication = createComposerSubmissionDeduplication();
  const pastedText = "x".repeat(2 * 1024 * 1024);
  const fingerprint = deduplication.acquire({
    ...draft(""),
    parts: [{ type: "paste", id: "paste-1", label: "large paste", text: pastedText, lines: 1 }],
  });

  assert.ok(fingerprint);
  assert.ok(fingerprint.length < 512);
  assert.equal(deduplication.acquire({
    ...draft(""),
    parts: [{ type: "paste", id: "paste-1", label: "large paste", text: pastedText, lines: 1 }],
  }), null);
});
