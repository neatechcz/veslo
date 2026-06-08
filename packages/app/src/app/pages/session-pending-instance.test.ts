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
    /const \[pendingQueueKeyAwaitingSessionIdByBaseKey, setPendingQueueKeyAwaitingSessionIdByBaseKey\] =\s*createSignal<Record<string, string>>\(\{\}\);/,
    "pending first-send handoff state should be keyed by the base pending session key",
  );

  assert.doesNotMatch(
    source,
    /const \[pendingQueueKeyAwaitingSessionId, setPendingQueueKeyAwaitingSessionId\] = createSignal<string \| null>\(null\);/,
    "session view should not use one global pending handoff key",
  );

  assert.match(
    source,
    /const currentSessionQueueKey = createMemo\(\(\) => \{\s*const selectedSessionKey = props\.selectedSessionId\?\.trim\(\);\s*if \(selectedSessionKey\) return sessionQueueKeyForSessionId\(selectedSessionKey\);\s*const basePendingKey = pendingSessionQueueKey\(\);\s*return pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[basePendingKey\] \?\? basePendingKey;\s*\}\);/,
    "pending views should select a pending instance only for their own base pending key",
  );
});

test("first-send handoff stores and clears the pending instance by base key", () => {
  assert.match(
    source,
    /const pendingSessionBaseKeyBeforeHandoff = !targetSessionId && !sessionIdForQueueKey\(baseSessionKey\)\s*\? isPendingSessionInstanceId\(baseSessionKey\)\s*\? pendingSessionQueueKey\(\)\s*: baseSessionKey\s*: null;/,
    "first sends should capture the base pending key separately from the pending instance key",
  );

  assert.match(
    source,
    /const needsPendingSessionInstance = Boolean\(pendingSessionBaseKeyBeforeHandoff\) && !isPendingSessionInstanceId\(baseSessionKey\);/,
    "first sends should not create a new pending instance when already targeting a pending instance",
  );

  assert.match(
    source,
    /setPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);/,
    "first sends should store the pending instance under the captured base key",
  );

  assert.match(
    source,
    /clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);/,
    "accepted or materialized handoff should clear only the matching base-to-pending mapping",
  );
});

test("failed first-send optimistic drafts keep the captured pending instance selected", () => {
  assert.match(
    source,
    /const finishPendingSessionHandoffFailure = \(\) => \{\s*if \(!pendingSessionBaseKeyBeforeHandoff \|\| !pendingSessionKeyBeforeHandoff\) return;\s*if \(showOptimisticSubmit && !props\.selectedSessionId\?\.trim\(\)\) \{\s*setPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*return;\s*\}\s*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*\};/,
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

test("successful optimistic submit cleanup removes the draft by submit id wherever it was remapped", () => {
  const clearStart = source.indexOf("const clearMatchingPendingSubmit = () => {");
  const markFailedStart = source.indexOf("const markMatchingPendingSubmitFailed", clearStart);
  assert.notEqual(clearStart, -1, "clearMatchingPendingSubmit should exist");
  assert.notEqual(markFailedStart, -1, "clearMatchingPendingSubmit should end before markMatchingPendingSubmitFailed");
  const clearSource = source.slice(clearStart, markFailedStart);

  assert.match(
    clearSource,
    /Object\.entries\(current\)\.find\(\(\[, draft\]\) => draft\.id === pendingSubmitId\)/,
    "successful cleanup should locate the optimistic draft by pending submit id across all session keys",
  );
  assert.match(
    clearSource,
    /removePendingSubmittedDraftForKey\(current, matchingSessionKey, pendingSubmitId\)/,
    "successful cleanup should remove the matching draft from the key where it currently lives",
  );
  assert.doesNotMatch(
    clearSource,
    /props\.selectedSessionId/,
    "successful cleanup should not rely on the currently selected session id",
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
