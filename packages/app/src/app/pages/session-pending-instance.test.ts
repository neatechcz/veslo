import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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
    /const finishPendingSessionHandoffFailure = \(\) => \{\s*if \(!pendingSessionBaseKeyBeforeHandoff \|\| !pendingSessionKeyBeforeHandoff\) return;[\s\S]*if \(materializedSessionIdFromHandoff\) \{\s*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*return;\s*\}[\s\S]*if \(showOptimisticSubmit && !props\.selectedSessionId\?\.trim\(\)\) \{\s*setPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*return;\s*\}\s*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*\};/,
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
    /if \(pendingSessionKeyBeforeHandoff\) \{\s*materializedSessionIdToRestore = current\.sessionId;[\s\S]*if \(!materializedSessionIdToRestore && materializedSessionIdFromHandoff\) \{\s*materializedSessionIdToRestore = materializedSessionIdFromHandoff;\s*\}[\s\S]*if \(current\.sessionId\) \{\s*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);\s*\}/,
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

test("pending handoffs materialize from the app callback with captured keys", () => {
  const sendImmediateStart = source.indexOf("  const sendPromptImmediate = async (");
  const sendImmediateEnd = source.indexOf("  const drainNextQueuedDraft = async (", sendImmediateStart);
  assert.notEqual(sendImmediateStart, -1, "sendPromptImmediate should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const sendImmediateSource = source.slice(sendImmediateStart, sendImmediateEnd);

  assert.match(
    source,
    /sendPromptAsync: \(draft: ComposerDraft, options\?: \{ targetSessionId\?: string \| null; onMaterializedSessionId\?: \(sessionId: string\) => void \}\) => Promise<boolean>;/,
    "session props should let app prompt sends report the materialized session id for that handoff",
  );
  assert.match(
    sendImmediateSource,
    /let materializedSessionIdFromHandoff: string \| null = null;/,
    "sendPromptImmediate should store the materialized id reported by the specific app handoff",
  );
  assert.match(
    sendImmediateSource,
    /const materializePendingHandoffToSession = \(sessionId: string \| null \| undefined\) => \{[\s\S]*const materializedSessionId = sessionId\?\.trim\(\);[\s\S]*materializedSessionIdFromHandoff = materializedSessionId;[\s\S]*remapPendingQueueToSession\(pendingSessionKeyBeforeHandoff, materializedSessionId\);[\s\S]*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);[\s\S]*\};/,
    "materialization should remap and clear the captured base-to-pending mapping, not the current active pending draft",
  );
  assert.match(
    sendImmediateSource,
    /onMaterializedSessionId: handleMaterializedSessionId/,
    "pending first sends should pass the captured materialization callback to app sendPrompt",
  );
  assert.match(
    sendImmediateSource,
    /const materializedSessionId = materializedSessionIdFromHandoff \?\? props\.selectedSessionId\?\.trim\(\);/,
    "accepted fallback should prefer the materialized id reported by the app handoff over current selected session state",
  );
  assert.match(
    sendImmediateSource,
    /if \(materializedSessionIdFromHandoff\) \{\s*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingSessionBaseKeyBeforeHandoff, pendingSessionKeyBeforeHandoff\);\s*return;\s*\}/,
    "failure cleanup should not restore a pending mapping after that handoff already materialized",
  );
});

test("app sendPrompt reports the created first-session id to the handoff callback", () => {
  const sendPromptStart = appSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = appSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "app sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "app sendPrompt should end before abortSession");
  const sendPromptSource = appSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /options: \{\s*targetSessionId\?: string \| null;\s*onMaterializedSessionId\?: \(sessionId: string\) => void;\s*\} = \{\},/,
    "app sendPrompt options should accept a per-send materialized session callback",
  );

  const createNeededStart = sendPromptSource.indexOf('if (!sessionID) {\n      recordSendTrace("sendPrompt:create-session-needed");');
  const createNeededEnd = sendPromptSource.indexOf("    if (!sessionID) {", createNeededStart + 1);
  assert.notEqual(createNeededStart, -1, "first-send create-session branch should exist");
  assert.notEqual(createNeededEnd, -1, "first-send branch should end before blocked-no-session branch");
  const createNeededSource = sendPromptSource.slice(createNeededStart, createNeededEnd);

  assert.match(
    createNeededSource,
    /const createdSessionId = await createSessionAndOpen\(initialSessionTitle, \{[\s\S]*blockAppDuringCreate: blockAppDuringPromptSend,[\s\S]*managedAiRuntimeAlreadyPrepared: true,[\s\S]*\}\);/,
    "first sends should capture the session id returned by their own createSessionAndOpen call",
  );
  assert.match(
    createNeededSource,
    /const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{\s*sessionID = materializedSessionId;\s*options\.onMaterializedSessionId\?\.\(materializedSessionId\);[\s\S]*\} else \{\s*sessionID = selectedSessionId\(\);\s*\}/,
    "sendPrompt should call the callback only with the created session id for this handoff",
  );
  assert.doesNotMatch(
    createNeededSource,
    /onMaterializedSessionId\?\.\(selectedSessionId/,
    "the materialized callback should not be fed from current selected session state",
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
