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

test("failed first-send optimistic drafts keep the captured pending instance selected", () => {
  assert.match(
    source,
    /const finishPendingSessionHandoffFailure = \(\) => \{\s*if \(!pendingSessionKeyBeforeHandoff\) return;\s*if \(showOptimisticSubmit && !props\.selectedSessionId\?\.trim\(\)\) \{\s*setPendingQueueKeyAwaitingSessionId\(pendingSessionKeyBeforeHandoff\);\s*return;\s*\}\s*setPendingQueueKeyAwaitingSessionId\(null\);\s*\};/,
    "failure cleanup should keep the captured pending instance selected when no real session exists yet",
  );

  const aiAccessStart = source.indexOf("if (props.aiAccessBlockedReason) {");
  const tryStart = source.indexOf("try {", aiAccessStart);
  assert.notEqual(aiAccessStart, -1, "AI access failure branch should exist");
  assert.notEqual(tryStart, -1, "send try block should follow AI access branch");
  const aiAccessFailure = source.slice(aiAccessStart, tryStart);
  assert.match(aiAccessFailure, /markMatchingPendingSubmitFailed\(props\.aiAccessBlockedReason\);/);
  assert.match(aiAccessFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(aiAccessFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);

  const rejectedStart = source.indexOf("if (!accepted) {", tryStart);
  const acceptedStart = source.indexOf("if (accepted && pendingSessionKeyBeforeHandoff)", rejectedStart);
  assert.notEqual(rejectedStart, -1, "rejected send branch should exist");
  assert.notEqual(acceptedStart, -1, "accepted handoff branch should follow rejected send branch");
  const rejectedFailure = source.slice(rejectedStart, acceptedStart);
  assert.match(rejectedFailure, /markMatchingPendingSubmitFailed\(errorMessage\);/);
  assert.match(rejectedFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(rejectedFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);

  const thrownStart = source.indexOf("} catch (e) {", acceptedStart);
  const sendImmediateEnd = source.indexOf("const drainNextQueuedDraft", thrownStart);
  assert.notEqual(thrownStart, -1, "thrown send branch should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const thrownFailure = source.slice(thrownStart, sendImmediateEnd);
  assert.match(thrownFailure, /markMatchingPendingSubmitFailed\(errorMessage\);/);
  assert.match(thrownFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(thrownFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);
});

test("materialized first-send failures keep the failed draft on the active real session key", () => {
  assert.match(
    source,
    /if \(pendingSessionKeyBeforeHandoff\) \{\s*materializedSessionIdToRestore = current\.sessionId;\s*if \(current\.sessionId\) \{\s*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);\s*\}/,
    "a materialized first-send failure should leave the failed optimistic draft under the active real session key",
  );

  const restoreStart = source.indexOf(
    "const restoreMaterializedQueueToPending = (pendingKey: string, sessionId: string | null | undefined) => {",
  );
  const appendStart = source.indexOf("const appendDraftToCurrentQueue", restoreStart);
  assert.notEqual(restoreStart, -1, "restoreMaterializedQueueToPending should exist");
  assert.notEqual(appendStart, -1, "restoreMaterializedQueueToPending should end before appendDraftToCurrentQueue");
  const restoreSource = source.slice(restoreStart, appendStart);

  assert.match(
    restoreSource,
    /setQueuedDraftsBySessionKey/,
    "materialized queue restoration should continue to move queued follow-up drafts where needed",
  );
  assert.doesNotMatch(
    restoreSource,
    /setPendingSubmittedDraftBySessionKey/,
    "materialized queue restoration should not move a failed optimistic submitted draft away from the active real session",
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
