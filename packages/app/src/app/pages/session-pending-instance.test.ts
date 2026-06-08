import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session view stores optimistic submitted drafts by session key", () => {
  assert.match(
    source,
    /const \[pendingSubmittedDraftBySessionKey, setPendingSubmittedDraftBySessionKey\] =\s*createSignal<PendingSubmittedDraftBySessionKey>\(\{\}\);/,
    "session view should keep optimistic submitted drafts keyed by session key",
  );

  assert.doesNotMatch(
    source,
    /const \[optimisticSubmittedDraft, setOptimisticSubmittedDraft\] = createSignal<PendingSubmittedDraft \| null>\(null\);/,
    "session view should not use one global optimistic submitted draft signal",
  );
});

test("active first-send pending views select the captured pending instance key", () => {
  assert.match(
    source,
    /const currentSessionQueueKey = createMemo\(\(\) => \{\s*const selectedSessionKey = props\.selectedSessionId\?\.trim\(\);\s*if \(selectedSessionKey\) return sessionQueueKeyForSessionId\(selectedSessionKey\);\s*return pendingQueueKeyAwaitingSessionId\(\) \|\| pendingSessionQueueKey\(\);\s*\}\);/,
    "the active pending view should read the optimistic draft stored under the pending session instance key",
  );
});

test("first sends create unique pending session instance keys before handoff", () => {
  assert.match(
    source,
    /createPendingSessionInstanceId\(/,
    "first-send handoff should allocate a unique pending session instance key",
  );
  assert.match(
    source,
    /pendingSessionKeyBeforeHandoff/,
    "first-send handoff should keep the captured pending instance key",
  );
});

test("pending session instance queue keys are treated as not-yet-real sessions", () => {
  assert.match(
    source,
    /isPendingSessionInstanceId\(sessionKey\)/,
    "pending session instance keys should not resolve to real session ids",
  );
});
