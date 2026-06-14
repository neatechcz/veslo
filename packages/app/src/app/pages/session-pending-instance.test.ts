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

test("temporary new-private pending draft keys are isolated by active workspace", () => {
  assert.match(
    source,
    /if \(pendingDraftKey === "__pending-draft__:new-private"\) \{\s*return `pending-draft:\$\{pendingDraftKey\}:\$\{props\.activeWorkspaceId \|\| "default"\}`;\s*\}/,
    "the temporary global new-private draft key must not share optimistic send state across private chat workspaces",
  );
});

test("session view stores run UI state by session key", () => {
  assert.match(
    source,
    /type RunUiState = \{[\s\S]*startedAt: number \| null;[\s\S]*hasBegun: boolean;[\s\S]*tick: number;[\s\S]*lastProgressAt: number \| null;[\s\S]*baseline: RunBaseline;[\s\S]*\};/,
    "run UI state should be represented as one keyed state object",
  );

  assert.match(
    source,
    /const \[runStateBySessionKey, setRunStateBySessionKey\] = createSignal<Record<string, RunUiState>>\(\{\}\);/,
    "session view should store run UI state by session key",
  );

  assert.match(
    source,
    /const runUiStateEqual = \(left: RunUiState, right: RunUiState\) =>[\s\S]*left\.baseline\.partCount === right\.baseline\.partCount;/,
    "run UI updates should detect no-op writes so status effects cannot recurse forever",
  );
  assert.match(
    source,
    /const next = update\(previous\);\s*if \(runUiStateEqual\(previous, next\)\) return current;/,
    "run UI state writes should preserve signal identity when the computed state is unchanged",
  );

  assert.match(
    source,
    /const activeRunState = createMemo\(\(\) => runStateBySessionKey\(\)\[currentSessionQueueKey\(\)\] \?\? EMPTY_RUN_STATE\);/,
    "run UI reads should derive from the currently active session key",
  );

  assert.doesNotMatch(
    source,
    /const \[runStartedAt, setRunStartedAt\] = createSignal<number \| null>\(null\);/,
    "runStartedAt should not be one global signal",
  );
  assert.doesNotMatch(
    source,
    /const \[runHasBegun, setRunHasBegun\] = createSignal\(false\);/,
    "runHasBegun should not be one global signal",
  );
  assert.doesNotMatch(
    source,
    /const \[runTick, setRunTick\] = createSignal\(Date\.now\(\)\);/,
    "runTick should not be one global signal",
  );
  assert.doesNotMatch(
    source,
    /const \[runLastProgressAt, setRunLastProgressAt\] = createSignal<number \| null>\(null\);/,
    "runLastProgressAt should not be one global signal",
  );
  assert.doesNotMatch(
    source,
    /const \[runBaseline, setRunBaseline\] = createSignal/,
    "runBaseline should not be one global signal",
  );
});

test("sendPromptImmediate starts run UI state by captured key and resets failures by handoff key", () => {
  const sendImmediateStart = source.indexOf("  const sendPromptImmediate = async (");
  const sendImmediateEnd = source.indexOf("  const drainNextQueuedDraft = async (", sendImmediateStart);
  assert.notEqual(sendImmediateStart, -1, "sendPromptImmediate should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const sendImmediateSource = source.slice(sendImmediateStart, sendImmediateEnd);

  assert.match(
    source,
    /const startRun = \(sessionKey = currentSessionQueueKey\(\)\) => \{[\s\S]*if \(untrack\(runStateBySessionKey\)\[key\]\?\.startedAt\) return;/,
    "startRun should default to the active key, allow a captured send key, and avoid tracking run-state reads",
  );
  assert.match(
    source,
    /const resetRunState = \(sessionKey = currentSessionQueueKey\(\)\) => \{/,
    "resetRunState should default to the active key but allow a captured send key",
  );
  assert.match(
    sendImmediateSource,
    /startRun\(sessionKey\);/,
    "optimistic and accepted sends should start run UI state under the captured send key",
  );
  assert.match(
    sendImmediateSource,
    /let materializedSessionIdForRunStateReset: string \| null = null;/,
    "sendPromptImmediate should track where a pending handoff's run UI state was materialized",
  );
  assert.match(
    sendImmediateSource,
    /const runStateSessionKeyForHandoffFailure = \(\) => \{[\s\S]*const materializedSessionId = materializedSessionIdForRunStateReset \?\? materializedSessionIdFromHandoff;[\s\S]*return materializedSessionId \? sessionQueueKeyForSessionId\(materializedSessionId\) : sessionKey;[\s\S]*\};/,
    "failed sends should reset the key where the handoff run UI state currently lives",
  );
  assert.match(
    sendImmediateSource,
    /materializedSessionIdForRunStateReset = materializedSessionId;/,
    "callback materialization should record the real session id for later failure reset",
  );
  assert.match(
    sendImmediateSource,
    /if \(current\.sessionId\) \{\s*materializedSessionIdForRunStateReset = current\.sessionId;\s*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);\s*\}/,
    "failure marking should record the real session id when the matching draft was already materialized",
  );
  assert.match(
    sendImmediateSource,
    /resetRunState\(runStateSessionKeyForHandoffFailure\(\)\);/,
    "failed sends should reset by the handoff-aware run-state key",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /resetRunState\(sessionKey\);/,
    "failed sends should not always reset the original pending send key",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /resetRunState\(\);/,
    "sendPromptImmediate should not reset whichever session is active after async handoff",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /startRun\(\);/,
    "sendPromptImmediate should not start whichever session is active after async handoff",
  );
});

test("failed first-send run reset uses the handoff-aware key in every failure branch", () => {
  const aiAccessStart = source.indexOf("if (props.aiAccessBlockedReason) {");
  const tryStart = source.indexOf("try {", aiAccessStart);
  assert.notEqual(aiAccessStart, -1, "AI access failure branch should exist");
  assert.notEqual(tryStart, -1, "send try block should follow AI access branch");
  const aiAccessFailure = source.slice(aiAccessStart, tryStart);
  assert.match(
    aiAccessFailure,
    /markMatchingPendingSubmitFailed\(props\.aiAccessBlockedReason\);[\s\S]*resetRunState\(runStateSessionKeyForHandoffFailure\(\)\);/,
    "AI-access failures should reset the pending or materialized handoff run key",
  );

  const rejectedStart = source.indexOf("if (!accepted) {", tryStart);
  const acceptedStart = source.indexOf("if (accepted && pendingSessionKeyBeforeHandoff)", rejectedStart);
  assert.notEqual(rejectedStart, -1, "rejected send branch should exist");
  assert.notEqual(acceptedStart, -1, "accepted handoff branch should follow rejected send branch");
  const rejectedFailure = source.slice(rejectedStart, acceptedStart);
  assert.match(
    rejectedFailure,
    /markMatchingPendingSubmitFailed\(errorMessage\);[\s\S]*resetRunState\(runStateSessionKeyForHandoffFailure\(\)\);/,
    "rejected sends should reset the pending or materialized handoff run key",
  );

  const thrownStart = source.indexOf("} catch (e) {", acceptedStart);
  const sendImmediateEnd = source.indexOf("const drainNextQueuedDraft", thrownStart);
  assert.notEqual(thrownStart, -1, "thrown send branch should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const thrownFailure = source.slice(thrownStart, sendImmediateEnd);
  assert.match(
    thrownFailure,
    /markMatchingPendingSubmitFailed\(errorMessage\);[\s\S]*resetRunState\(runStateSessionKeyForHandoffFailure\(\)\);/,
    "thrown sends should reset the pending or materialized handoff run key",
  );
  assert.doesNotMatch(
    `${aiAccessFailure}\n${rejectedFailure}\n${thrownFailure}`,
    /resetRunState\(sessionKey\);/,
    "failure branches should not leave materialized real-session run state behind by resetting only the original key",
  );
});

test("pending session materialization remaps only that pending run UI state", () => {
  assert.match(
    source,
    /const remapPendingRunStateToSession = \(pendingKey: string, sessionId: string\) => \{[\s\S]*const pendingRun = current\[pendingKey\];[\s\S]*const \{ \[pendingKey\]: _removedPendingRunState, \.\.\.rest \} = current;[\s\S]*return \{[\s\S]*\.\.\.rest,[\s\S]*\[sessionKey\]: pendingRun,[\s\S]*\};[\s\S]*\};/,
    "materializing a pending session should move only its run UI state to the real session key",
  );
  assert.match(
    source,
    /const remapPendingQueueToSession = \(pendingKey: string, sessionId: string\) => \{[\s\S]*remapPendingRunStateToSession\(pendingKey, sessionId\);/,
    "pending-to-real handoff should remap run UI state with the queue and submitted draft",
  );
});

test("session switching resets only keyed run UI state", () => {
  assert.match(
    source,
    /const previousSessionKey = previousSessionId \? sessionQueueKeyForSessionId\(previousSessionId\) : null;[\s\S]*if \(!pendingKey && previousSessionKey\) \{\s*resetRunState\(previousSessionKey\);\s*\}/,
    "session switching should reset only the previous keyed run state when no pending remap is in flight",
  );
  assert.doesNotMatch(
    source,
    /if \(!pendingKey\) \{\s*resetRunState\(\);\s*\}/,
    "session switching should not reset whatever run state is globally active",
  );
});

test("pending sidebar selection does not materialize another pending draft into it", () => {
  const selectedEffectStart = source.indexOf("      () => props.selectedSessionId,");
  const selectedEffectEnd = source.indexOf("  createEffect(", selectedEffectStart + 1);
  assert.notEqual(selectedEffectStart, -1, "selected-session effect should exist");
  assert.notEqual(selectedEffectEnd, -1, "selected-session effect should have a bounded source slice");
  const selectedEffectSource = source.slice(selectedEffectStart, selectedEffectEnd);

  assert.match(
    selectedEffectSource,
    /if \(pendingKey && !isPendingSessionInstanceId\(sessionId\)\) \{\s*remapPendingQueueToSession\(pendingKey, sessionId\);\s*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingBaseKey, pendingKey\);\s*\}/,
    "selecting a pending sidebar row must not remap a different pending send into that pending row",
  );
  assert.doesNotMatch(
    selectedEffectSource,
    /if \(pendingKey\) \{\s*remapPendingQueueToSession\(pendingKey, sessionId\);/,
    "pending handoff remapping should only run after a real session id is selected",
  );
});

test("opening another project pending draft clears only the visible base mapping", () => {
  assert.match(
    source,
    /const openPendingDirectoryDraftFromList = \(workspaceId: string\) => \{[\s\S]*const pendingBaseKey = pendingSessionQueueKey\(\);[\s\S]*const pendingKey = pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[pendingBaseKey\] \?\? null;[\s\S]*if \(pendingKey\) \{[\s\S]*clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingBaseKey, pendingKey\);[\s\S]*\}[\s\S]*props\.openPendingDirectoryDraftInWorkspace\(workspaceId\);[\s\S]*\};/s,
    "project plus should clear the displayed pending-instance mapping so same-project sends can start a fresh pending row",
  );
  assert.match(
    source,
    /onOpenPendingDirectoryDraftInWorkspace=\{openPendingDirectoryDraftFromList\}/,
    "sidebar project plus should use the wrapper that clears the visible pending base mapping",
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
    /if \(pendingSessionKeyBeforeHandoff\) \{\s*materializedSessionIdToRestore = current\.sessionId;[\s\S]*if \(!materializedSessionIdToRestore && materializedSessionIdFromHandoff\) \{\s*materializedSessionIdToRestore = materializedSessionIdFromHandoff;\s*\}[\s\S]*if \(current\.sessionId\) \{\s*materializedSessionIdForRunStateReset = current\.sessionId;\s*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);\s*\}/,
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
    /sendPromptAsync: \(\s*draft: ComposerDraft,\s*options: SessionSendOptionsBase & \{[\s\S]*targetSessionId\?: string \| null;[\s\S]*onMaterializedSessionId\?: \(sessionId: string\) => void;[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\},\s*\) => Promise<boolean>;/,
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

test("pending first sends pass captured sidebar placeholder metadata to app prompt send", () => {
  assert.match(
    source,
    /import type \{[\s\S]*PendingSidebarSessionMetadata[\s\S]*\} from "\.\.\/types";/,
    "session view should use the shared pending sidebar metadata type in prompt send options",
  );

  const sendImmediateStart = source.indexOf("  const sendPromptImmediate = async (");
  const sendImmediateEnd = source.indexOf("  const drainNextQueuedDraft = async (", sendImmediateStart);
  assert.notEqual(sendImmediateStart, -1, "sendPromptImmediate should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const sendImmediateSource = source.slice(sendImmediateStart, sendImmediateEnd);

  assert.match(
    sendImmediateSource,
    /const pendingSidebarSessionCreatedAt = Date\.now\(\);/,
    "pending sidebar placeholder metadata should use a captured creation time",
  );
  assert.match(
    sendImmediateSource,
    /const pendingSidebarWorkspaceId = createPendingSidebarSessionWorkspaceId\(\);[\s\S]*const pendingSidebarWorkspaceRoot = createPendingSidebarSessionWorkspaceRoot\(pendingSidebarWorkspaceId\);[\s\S]*const pendingSidebarSession: PendingSidebarSessionMetadata \| null = pendingSessionKeyBeforeHandoff\s*\? \{[\s\S]*id: pendingSessionKeyBeforeHandoff,[\s\S]*workspaceId: pendingSidebarWorkspaceId,[\s\S]*workspaceRoot: pendingSidebarWorkspaceRoot,[\s\S]*title: draft\.text\.trim\(\),[\s\S]*createdAt: pendingSidebarSessionCreatedAt,[\s\S]*\}[\s\S]*: null;/,
    "pending first sends should capture the pending id, target workspace id/root, title, and creation time",
  );
  assert.match(
    sendImmediateSource,
    /const promptSendOptions: \{[\s\S]*clientMessageId: string;[\s\S]*origin: SessionSendOrigin;[\s\S]*targetSessionId\?: string \| null;[\s\S]*sendTraceId\?: string \| null;[\s\S]*onMaterializedSessionId\?: \(sessionId: string\) => void;[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\} =/,
    "prompt send options should allow pending sidebar metadata",
  );
  assert.match(
    sendImmediateSource,
    /\? \{ onMaterializedSessionId: handleMaterializedSessionId, pendingSession: pendingSidebarSession \}|\.\.\.\(pendingSessionKeyBeforeHandoff[\s\S]*onMaterializedSessionId: handleMaterializedSessionId, pendingSession: pendingSidebarSession/,
    "pending first sends should pass the captured metadata with the materialization callback",
  );
});

test("clicking a pending sidebar row opens the local pending session without transcript selection", () => {
  const openStart = source.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string) => {");
  const openEnd = source.indexOf("  const resolveVesloWorkspaceId = (workspaceId: string) => {", openStart);
  assert.notEqual(openStart, -1, "openSessionFromList should exist");
  assert.notEqual(openEnd, -1, "openSessionFromList should end before resolveVesloWorkspaceId");
  const openSource = source.slice(openStart, openEnd);

  assert.match(
    openSource,
    /if \(isPendingSessionInstanceId\(sessionId\)\) \{[\s\S]*const openPendingSidebarSession = \(nextSessionId: string\) => \{[\s\S]*props\.setSessionBrowseScope\(\{[\s\S]*sessionId: nextSessionId,[\s\S]*workspaceId,[\s\S]*workspaceRoot,[\s\S]*directory: session\?\.directory \?\? workspaceRoot,[\s\S]*conversationId: null,[\s\S]*opencodeSessionId: null,[\s\S]*\}\);[\s\S]*props\.setView\("session", nextSessionId\);[\s\S]*\};[\s\S]*openPendingSidebarSession\(sessionId\);[\s\S]*void openSessionWithWorkspaceActivation\(\{[\s\S]*activateWorkspaceBeforeOpen: true,[\s\S]*openSession: openPendingSidebarSession,[\s\S]*\}\)/,
    "pending sidebar rows should bind and route to the local pending id before any async workspace activation",
  );
  assert.doesNotMatch(
    openSource,
    /if \(isPendingSessionInstanceId\(sessionId\)\) \{[\s\S]*void openSessionWithWorkspaceActivation\(\{[\s\S]*openSession: \(nextSessionId\) => \{/,
    "pending sidebar rows should not wait for activation before opening the local pending id",
  );
  assert.match(
    openSource,
    /void openSessionWithWorkspaceActivation/,
    "real sidebar rows should continue through the existing workspace/session navigation path",
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
    /options: AppSendPromptOptions,/,
    "app sendPrompt options should accept a per-send materialized session callback",
  );

  const createNeededMatch = /if \(!sessionID\) \{\s*recordSendTrace\("sendPrompt:create-session-needed"/.exec(sendPromptSource);
  const createNeededStart = createNeededMatch?.index ?? -1;
  const createNeededEnd = sendPromptSource.indexOf("    if (!sessionID) {", createNeededStart + 1);
  assert.notEqual(createNeededStart, -1, "first-send create-session branch should exist");
  assert.notEqual(createNeededEnd, -1, "first-send branch should end before blocked-no-session branch");
  const createNeededSource = sendPromptSource.slice(createNeededStart, createNeededEnd);

  assert.match(
    createNeededSource,
    /const createdSessionId = await sendTraceStep\([\s\S]*"sendPrompt:create-session-and-open",[\s\S]*\(\) => createSessionAndOpen\(initialSessionTitle, \{[\s\S]*blockAppDuringCreate: blockAppDuringPromptSend,[\s\S]*managedAiRuntimeAlreadyPrepared: true,[\s\S]*pendingSession: pendingSidebarSession,[\s\S]*\}\),/,
    "first sends should capture the session id returned by their own createSessionAndOpen call",
  );
  assert.match(
    createNeededSource,
    /const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{\s*sessionID = materializedSessionId;\s*options\.onMaterializedSessionId\?\.\(materializedSessionId\);[\s\S]*\} else \{\s*const selectedAfterCreate = selectedSessionId\(\);[\s\S]*sessionID = isPendingSessionInstanceId\(selectedAfterCreate\) \? null : selectedAfterCreate;\s*\}/,
    "sendPrompt should call the callback only with the created session id for this handoff",
  );
  assert.doesNotMatch(
    createNeededSource,
    /onMaterializedSessionId\?\.\(selectedSessionId/,
    "the materialized callback should not be fed from current selected session state",
  );
});

test("materializing an active pending first send does not immediately drain the queue", () => {
  const effectMatch = /createEffect\(\s*on\(\s*\(\) => props\.selectedSessionId,/.exec(source);
  const effectStart = effectMatch?.index ?? -1;
  assert.notEqual(effectStart, -1, "selected session effect should exist");
  const effectSource = source.slice(effectStart, effectStart + 2500);

  assert.match(
    effectSource,
    /const materializedPendingSubmit =\s*pendingKey \? pendingSubmittedDraftBySessionKey\(\)\[pendingKey\]\?\.state === "sending" : false;/,
    "selected-session materialization should detect an in-flight pending first send before remapping",
  );
  assert.match(
    effectSource,
    /if \(\s*!materializedPendingSubmit &&\s*props\.sessionStatusById\[sessionId\] === "idle" &&\s*!queuePausedForSessionKey\(sessionKey\)\s*\) \{\s*void drainNextQueuedDraft\("queue-drain", sessionKey\);/s,
    "selected-session materialization should not drain a just-materialized sending first draft",
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
