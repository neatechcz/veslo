import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const sessionNavigationSource = readFileSync(new URL("./session-navigation.ts", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(new URL("./session-conversation-flow.ts", import.meta.url), "utf8");
const queueDrainControllerSource = readFileSync(
  new URL("../context/session-queue-drain-controller.ts", import.meta.url),
  "utf8",
);
const source = `${sessionSource}\n${conversationFlowSource}`;
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSendWorkflowSource = readFileSync(new URL("./session-send-workflow.ts", import.meta.url), "utf8");
const sessionCreationWorkflowSource = readFileSync(new URL("./session-creation-workflow.ts", import.meta.url), "utf8");
const flowSendImmediateStart = conversationFlowSource.indexOf("sendPromptImmediate: async (");
const flowSendImmediateEnd = conversationFlowSource.indexOf("export type RunBaseline", flowSendImmediateStart);
const flowSendImmediateSource = conversationFlowSource.slice(flowSendImmediateStart, flowSendImmediateEnd);

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
    conversationFlowSource,
    /export const resolveCurrentSessionQueueKey = \(\{[\s\S]*const selectedSessionKey = selectedSessionId\?\.trim\(\);[\s\S]*if \(selectedSessionKey\) return resolveSessionQueueKeyForSessionId\(context, selectedSessionKey\);[\s\S]*const basePendingKey = resolvePendingSessionQueueKey\(context\);[\s\S]*return pendingQueueKeyAwaitingSessionIdByBaseKey\[basePendingKey\] \?\? basePendingKey;/,
    "pending views should select a pending instance only for their own base pending key",
  );

  assert.match(
    sessionSource,
    /const currentSessionQueueKey = createMemo\(\(\) => \{\s*return resolveCurrentSessionQueueKey\(\{[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*pendingQueueKeyAwaitingSessionIdByBaseKey: pendingQueueKeyAwaitingSessionIdByBaseKey\(\),[\s\S]*\}\);\s*\}\);/,
    "pending views should select a pending instance only for their own base pending key",
  );
});

test("temporary new-private pending draft keys are isolated by active workspace", () => {
  assert.match(
    conversationFlowSource,
    /export const resolvePendingDraftWorkspaceId = \(context: SessionQueueKeyContext\) => \{[\s\S]*meta\.kind === "new-private"[\s\S]*\?\s*\(meta\.privateWorkspaceId \?\? meta\.workspaceId\)\.trim\(\)[\s\S]*return workspaceId \|\| resolveActiveUiConversationWorkspaceId\(context\);[\s\S]*\};/,
    "the temporary global new-private draft key must not share optimistic send state across private chat workspaces",
  );
  assert.match(
    conversationFlowSource,
    /export const resolvePendingSessionQueueKey = \(context: SessionQueueKeyContext\) => \{[\s\S]*const pendingDraftKey = context\.activePendingDraftKey\?\.trim\(\);[\s\S]*return createUiConversationKey\(\{[\s\S]*workspaceId,[\s\S]*kind: "pending-draft",[\s\S]*id: pendingDraftKey,[\s\S]*\}\);/,
    "pending draft queue keys should include the resolved workspace scope",
  );
  assert.match(
    sessionSource,
    /const pendingDraftWorkspaceId = \(\) => resolvePendingDraftWorkspaceId\(queueKeyContext\(\)\);[\s\S]*const pendingSessionQueueKey = \(\) => resolvePendingSessionQueueKey\(queueKeyContext\(\)\);/,
    "session view should wire pending draft queue keys through the conversation-flow helper",
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
  assert.notEqual(flowSendImmediateStart, -1, "sendPromptImmediate should exist in the conversation-flow controller");
  assert.notEqual(flowSendImmediateEnd, -1, "sendPromptImmediate should end before run-state helpers");
  const sendImmediateSource = flowSendImmediateSource;

  assert.match(
    source,
    /const startRun = \(sessionKey = currentSessionQueueKey\(\)\) => \{[\s\S]*if \(untrack\(runStateBySessionKey\)\[key\]\?\.startedAt\) return;/,
    "startRun should default to the active key, allow a captured send key, and avoid tracking run-state reads",
  );
  assert.match(
    source,
    /const resetRunState = \(sessionKey = currentSessionQueueKey\(\), reason = "unspecified-reset"\) => \{/,
    "resetRunState should default to the active key but allow a captured send key",
  );
  assert.match(
    sendImmediateSource,
    /deps\.runState\.startRun\(sessionKey\);/,
    "optimistic and accepted sends should start run UI state under the captured send key",
  );
  assert.match(
    sendImmediateSource,
    /let materializedSessionIdForRunStateReset: string \| null = null;/,
    "sendPromptImmediate should track where a pending handoff's run UI state was materialized",
  );
  assert.match(
    sendImmediateSource,
    /const runStateSessionKeyForHandoffFailure = \(\) => \{[\s\S]*const materializedSessionId =[\s\S]*materializedSessionIdForRunStateReset \?\? materializedSessionIdFromHandoff;[\s\S]*deps\.sessionKeys\.sessionQueueKeyForSessionId\(materializedSessionId\)[\s\S]*: sessionKey;[\s\S]*\};/,
    "failed sends should reset the key where the handoff run UI state currently lives",
  );
  assert.match(
    sendImmediateSource,
    /materializedSessionIdForRunStateReset = materializedSessionId;/,
    "callback materialization should record the real session id for later failure reset",
  );
  assert.match(
    conversationFlowSource,
    /if \(current\.sessionId\) \{[\s\S]*materializedSessionIdForRunStateReset: current\.sessionId,[\s\S]*\}/,
    "failure marking should record the real session id when the matching draft was already materialized",
  );
  assert.match(
    sendImmediateSource,
    /if \(result\.materializedSessionIdForRunStateReset\) \{\s*materializedSessionIdForRunStateReset = result\.materializedSessionIdForRunStateReset;\s*\}/,
    "sendPromptImmediate should apply the real reset id returned by the pending-submit failure helper",
  );
  assert.match(
    sendImmediateSource,
    /deps\.runState\.resetRunState\(runStateSessionKeyForHandoffFailure\(\), "[^"]+"\);/,
    "failed sends should reset by the handoff-aware run-state key",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /deps\.runState\.resetRunState\(sessionKey\);/,
    "failed sends should not always reset the original pending send key",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /deps\.runState\.resetRunState\(\);/,
    "sendPromptImmediate should not reset whichever session is active after async handoff",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /deps\.runState\.startRun\(\);/,
    "sendPromptImmediate should not start whichever session is active after async handoff",
  );
});

test("failed first-send run reset uses the handoff-aware key in every failure branch", () => {
  const aiAccessStart = flowSendImmediateSource.indexOf("if (aiAccessSubmitBlockedReason) {");
  const tryStart = flowSendImmediateSource.indexOf("try {", aiAccessStart);
  assert.notEqual(aiAccessStart, -1, "AI access failure branch should exist");
  assert.notEqual(tryStart, -1, "send try block should follow AI access branch");
  const aiAccessFailure = flowSendImmediateSource.slice(aiAccessStart, tryStart);
  assert.match(
    aiAccessFailure,
    /markMatchingPendingSubmitFailed\(aiAccessSubmitBlockedReason\);[\s\S]*deps\.runState\.resetRunState\(runStateSessionKeyForHandoffFailure\(\), "ai-access-blocked"\);/,
    "AI-access failures should reset the pending or materialized handoff run key",
  );

  const rejectedStart = flowSendImmediateSource.indexOf("if (!submitResult.accepted) {", tryStart);
  const acceptedStart = flowSendImmediateSource.indexOf(
    "materializedPendingSessionTarget.current",
    rejectedStart,
  );
  assert.notEqual(rejectedStart, -1, "rejected send branch should exist");
  assert.notEqual(acceptedStart, -1, "accepted handoff branch should follow rejected send branch");
  const rejectedFailure = flowSendImmediateSource.slice(rejectedStart, acceptedStart);
  assert.match(
    rejectedFailure,
    /markMatchingPendingSubmitFailed\(errorMessage\);[\s\S]*deps\.runState\.resetRunState\(runStateSessionKeyForHandoffFailure\(\), "send-rejected"\);/,
    "rejected sends should reset the pending or materialized handoff run key",
  );

  const thrownStart = flowSendImmediateSource.indexOf("} catch (error) {", acceptedStart);
  const sendImmediateEnd = flowSendImmediateSource.length;
  assert.notEqual(thrownStart, -1, "thrown send branch should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const thrownFailure = flowSendImmediateSource.slice(thrownStart, sendImmediateEnd);
  assert.match(
    thrownFailure,
    /markMatchingPendingSubmitFailed\(errorMessage\);[\s\S]*deps\.runState\.resetRunState\(runStateSessionKeyForHandoffFailure\(\), "send-exception"\);/,
    "thrown sends should reset the pending or materialized handoff run key",
  );
  assert.doesNotMatch(
    `${aiAccessFailure}\n${rejectedFailure}\n${thrownFailure}`,
    /deps\.runState\.resetRunState\(sessionKey\);/,
    "failure branches should not leave materialized real-session run state behind by resetting only the original key",
  );
});

test("pending session materialization remaps only that pending run UI state", () => {
  assert.match(
    conversationFlowSource,
    /export const remapPendingRunStateToSession = \([\s\S]*const pendingRun = current\[pending\];[\s\S]*const \{ \[pending\]: _removedPendingRunState, \.\.\.rest \} = current;[\s\S]*return \{[\s\S]*\.\.\.rest,[\s\S]*\[real\]: pendingRun,[\s\S]*\};[\s\S]*\};/,
    "materializing a pending session should move only its run UI state to the real session key",
  );
  assert.match(
    sessionSource,
    /setRunStateBySessionKey\(\(current\) =>\s*remapPendingRunStateToSessionRecord\(current, pendingKey, sessionKey\),\s*\);/,
    "session view should wire pending run-state remaps through the conversation-flow helper",
  );
  assert.match(
    sessionSource,
    /const remapPendingQueueToSession = \(\s*pendingKey: string,\s*sessionId: string,\s*sessionKeyOverride\?: string \| null,[\s\S]*remapPendingRunStateToSession\(pendingKey, sessionId, sessionKey\);/,
    "pending-to-real handoff should remap run UI state with the queue and submitted draft",
  );
});

test("session switching preserves keyed run UI state until runtime idle", () => {
  assert.match(
    queueDrainControllerSource,
    /preserveRunStateOnSessionSwitch: \(sessionKey: string\) => void;[\s\S]*const previousSessionKey = previousSessionId\s*\? options\.sessionQueueKeyForSessionId\(previousSessionId\)\s*: null;[\s\S]*if \(!pendingKey && previousSessionKey\) \{\s*options\.preserveRunStateOnSessionSwitch\(previousSessionKey\);\s*\}/,
    "session switching should preserve the previous keyed run state when no pending remap is in flight",
  );
  assert.doesNotMatch(
    source,
    /if \(!pendingKey && previousSessionKey\) \{\s*resetRunState\(previousSessionKey\);/,
    "session switching should not reset the previous run UI state; scoped idle status owns cleanup",
  );
  assert.match(
    source,
    /for \(const \[sessionKey, runState\] of Object\.entries\(untrack\(runStateBySessionKey\)\)\) \{[\s\S]*const previousStatus = statusForQueueKey\(sessionKey, previousStatuses\);[\s\S]*const status = statusForQueueKey\(sessionKey, statuses\);[\s\S]*if \(!isActiveRunStatus\(previousStatus\) \|\| isActiveRunStatus\(status\)\) continue;[\s\S]*if \(lifecycleKeepsRunPresentationActive\(runDiagnosticForQueueKey\(sessionKey\)\)\) continue;[\s\S]*resetRunState\(sessionKey, "session-status-idle"\);[\s\S]*\}/,
    "background scoped session status should defer a preserved run reset while durable lifecycle truth remains active",
  );
});

test("accepted first-send cleanup clears the materialized session composer draft", () => {
  const handleSendPromptStart = sessionSource.indexOf("const handleSendPrompt = async");
  const handleSendPromptEnd = sessionSource.indexOf("const sendImplicitSkillAsPrompt", handleSendPromptStart);
  assert.notEqual(handleSendPromptStart, -1, "session send handler should exist");
  assert.notEqual(handleSendPromptEnd, -1, "session send handler should end before implicit skill handling");
  const handleSendPromptSource = sessionSource.slice(handleSendPromptStart, handleSendPromptEnd);

  assert.match(
    handleSendPromptSource,
    /const result = await sessionFlowFacade\.handleSendPrompt\(draft,[\s\S]*if \(result\.draftDisposition === "clear"\) \{[\s\S]*props\.setComposerDraft\(\{[\s\S]*mode: draft\.mode,[\s\S]*parts: \[\],[\s\S]*attachments: \[\],[\s\S]*text: "",[\s\S]*resolvedText: "",[\s\S]*\}\);/,
    "the session owner should clear the draft after a first-send handoff mounts the active composer",
  );
});

test("pending sidebar selection does not materialize another pending draft into it", () => {
  const selectedEffectStart = queueDrainControllerSource.indexOf("          options.selectedSessionId,");
  const selectedEffectEnd = queueDrainControllerSource.indexOf("      createEffect(", selectedEffectStart + 1);
  assert.notEqual(selectedEffectStart, -1, "selected-session effect should exist");
  assert.notEqual(selectedEffectEnd, -1, "selected-session effect should have a bounded source slice");
  const selectedEffectSource = queueDrainControllerSource.slice(selectedEffectStart, selectedEffectEnd);

  assert.match(
    selectedEffectSource,
    /options\.handleSelectedSessionChanged\(\{[\s\S]*sessionId,[\s\S]*previousSessionId,[\s\S]*pendingBaseKey,[\s\S]*pendingKey,[\s\S]*sessionStatusById: options\.sessionStatusById\(\),[\s\S]*\}\);/s,
    "selected-session effect should delegate materialization flow to the conversation-flow controller",
  );
  assert.match(
    conversationFlowSource,
    /if \([\s\S]*pendingKey[\s\S]*!isPendingSessionInstanceKey\(selectedSessionId\)[\s\S]*queueKeysShareWorkspace\(deps\.sessionKeys\.workspaceIdForQueueKey, pendingKey, sessionKey\)[\s\S]*deps\.pendingHandoff\.remapPendingQueueToSession\(pendingKey, selectedSessionId\);[\s\S]*deps\.pendingHandoff\.clearPendingQueueKeyAwaitingSessionIdForBaseKey\(pendingBaseKey, pendingKey\);[\s\S]*blocked-workspace-mismatch/s,
    "selecting a pending sidebar row must not remap a different workspace send into that row",
  );
  assert.doesNotMatch(
    conversationFlowSource,
    /if \(pendingKey\) \{\s*deps\.pendingHandoff\.remapPendingQueueToSession\(pendingKey, selectedSessionId\);/,
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
    /onOpenPendingDirectoryDraftInWorkspace:\s*openPendingDirectoryDraftFromList/,
    "sidebar project plus should use the wrapper that clears the visible pending base mapping",
  );
});

test("first-send handoff stores and clears the pending instance by base key", () => {
  assert.match(
    conversationFlowSource,
    /const pendingSessionBaseKeyBeforeHandoff =[\s\S]*!targetSessionId && !resolveSessionIdForQueueKey\(baseKey\)[\s\S]*\? isPendingSessionInstanceKey\(baseKey\)[\s\S]*\? pendingSessionQueueKey[\s\S]*: baseKey[\s\S]*: null;/,
    "first sends should capture the base pending key separately from the pending instance key",
  );

  assert.match(
    conversationFlowSource,
    /const needsPendingSessionInstance =[\s\S]*Boolean\(pendingSessionBaseKeyBeforeHandoff\) && !isPendingSessionInstanceKey\(baseKey\);/,
    "first sends should not create a new pending instance when already targeting a pending instance",
  );

  assert.match(
    conversationFlowSource,
    /const handoffScope = resolvePendingSessionHandoffScope\(\{[\s\S]*baseSessionKey,[\s\S]*targetSessionId,[\s\S]*pendingSessionQueueKey: deps\.sessionKeys\.pendingSessionQueueKey\(\),[\s\S]*createPendingSessionInstanceId: deps\.identity\.createPendingSessionInstanceId,[\s\S]*\}\);[\s\S]*pendingSessionBaseKeyBeforeHandoff,[\s\S]*sessionKey,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*= handoffScope;/,
    "conversation flow should derive first-send handoff scope through the helper",
  );

  assert.match(
    conversationFlowSource,
    /deps\.pendingHandoff\.setPendingQueueKeyAwaitingSessionIdForBaseKey\(\s*pendingSessionBaseKeyBeforeHandoff,\s*pendingSessionKeyBeforeHandoff,\s*\);/,
    "first sends should store the pending instance under the captured base key",
  );

  assert.match(
    conversationFlowSource,
    /kind: "clear-matching-pending-instance"[\s\S]*pendingSessionBaseKey: pendingSessionBaseKeyBeforeHandoff,[\s\S]*pendingSessionKey: pendingSessionKeyBeforeHandoff/,
    "accepted or materialized handoff should clear only the matching base-to-pending mapping",
  );
  assert.match(
    conversationFlowSource,
    /deps\.pendingHandoff\.clearPendingQueueKeyAwaitingSessionIdForBaseKey\(\s*action\.pendingSessionBaseKey,\s*action\.pendingSessionKey,\s*\);/,
    "conversation flow should apply the handoff cleanup action to the captured mapping keys",
  );
});

test("failed first-send optimistic drafts keep the captured pending instance selected", () => {
  assert.match(
    conversationFlowSource,
    /export const resolvePendingSessionHandoffFailureAction = \([\s\S]*if \(!pendingSessionBaseKeyBeforeHandoff \|\| !pendingSessionKeyBeforeHandoff\)[\s\S]*if \(materializedSessionIdFromHandoff\)[\s\S]*kind: "clear-base-mapping"[\s\S]*if \(showOptimisticSubmit && !selectedSessionId\?\.trim\(\)\)[\s\S]*kind: "keep-pending-instance"[\s\S]*kind: "clear-matching-pending-instance"/,
    "failure cleanup should keep the captured pending instance selected when no real session exists yet",
  );
  assert.match(
    conversationFlowSource,
    /const finishPendingSessionHandoffFailure = \(\) => \{[\s\S]*const action = resolvePendingSessionHandoffFailureAction\(\{[\s\S]*materializedSessionIdFromHandoff,[\s\S]*showOptimisticSubmit,[\s\S]*selectedSessionId: deps\.sessionKeys\.selectedSessionId\(\),[\s\S]*\}\);[\s\S]*if \(action\.kind === "keep-pending-instance"\) \{[\s\S]*deps\.pendingHandoff\.setPendingQueueKeyAwaitingSessionIdForBaseKey\([\s\S]*action\.pendingSessionBaseKey,[\s\S]*action\.pendingSessionKey,[\s\S]*\);[\s\S]*return;[\s\S]*\}[\s\S]*deps\.pendingHandoff\.clearPendingQueueKeyAwaitingSessionIdForBaseKey\(/,
    "conversation flow should wire handoff failure cleanup through the conversation-flow action",
  );

  const aiAccessStart = flowSendImmediateSource.indexOf("if (aiAccessSubmitBlockedReason) {");
  const tryStart = flowSendImmediateSource.indexOf("try {", aiAccessStart);
  assert.notEqual(aiAccessStart, -1, "AI access failure branch should exist");
  assert.notEqual(tryStart, -1, "send try block should follow AI access branch");
  const aiAccessFailure = flowSendImmediateSource.slice(aiAccessStart, tryStart);
  assert.match(aiAccessFailure, /markMatchingPendingSubmitFailed\(aiAccessSubmitBlockedReason\);/);
  assert.match(aiAccessFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(aiAccessFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);

  const rejectedStart = flowSendImmediateSource.indexOf("if (!submitResult.accepted) {", tryStart);
  const acceptedStart = flowSendImmediateSource.indexOf(
    "materializedPendingSessionTarget.current",
    rejectedStart,
  );
  assert.notEqual(rejectedStart, -1, "rejected send branch should exist");
  assert.notEqual(acceptedStart, -1, "accepted handoff branch should follow rejected send branch");
  const rejectedFailure = flowSendImmediateSource.slice(rejectedStart, acceptedStart);
  assert.match(rejectedFailure, /markMatchingPendingSubmitFailed\(errorMessage\);/);
  assert.match(rejectedFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(rejectedFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);

  const thrownStart = flowSendImmediateSource.indexOf("} catch (error) {", acceptedStart);
  const sendImmediateEnd = flowSendImmediateSource.length;
  assert.notEqual(thrownStart, -1, "thrown send branch should exist");
  assert.notEqual(sendImmediateEnd, -1, "sendPromptImmediate should end before queue draining");
  const thrownFailure = flowSendImmediateSource.slice(thrownStart, sendImmediateEnd);
  assert.match(thrownFailure, /markMatchingPendingSubmitFailed\(errorMessage\);/);
  assert.match(thrownFailure, /finishPendingSessionHandoffFailure\(\);/);
  assert.doesNotMatch(thrownFailure, /setPendingQueueKeyAwaitingSessionId\(null\);/);
});

test("materialized first-send failures keep the failed draft on the active real session key", () => {
  assert.match(
    conversationFlowSource,
    /const materializedSessionIdToRestore =[\s\S]*current\.sessionId \|\| materializedSessionIdFromHandoff \|\| null;[\s\S]*if \(current\.sessionId\) \{[\s\S]*setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\),[\s\S]*materializedSessionIdForRunStateReset: current\.sessionId,[\s\S]*\}/,
    "a materialized first-send failure should leave the failed optimistic draft under the active real session key",
  );

  const restoreStart = sessionSource.indexOf("const restoreMaterializedQueueToPending = (");
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
  const clearStart = flowSendImmediateSource.indexOf("const clearMatchingPendingSubmit = () => {");
  const markFailedStart = flowSendImmediateSource.indexOf("const markMatchingPendingSubmitFailed", clearStart);
  assert.notEqual(clearStart, -1, "clearMatchingPendingSubmit should exist");
  assert.notEqual(markFailedStart, -1, "clearMatchingPendingSubmit should end before markMatchingPendingSubmitFailed");
  const clearSource = flowSendImmediateSource.slice(clearStart, markFailedStart);

  assert.match(
    clearSource,
    /removePendingSubmittedDraftById\(current, pendingSubmitId\)/,
    "successful cleanup should locate the optimistic draft by pending submit id across all session keys",
  );
  assert.match(
    conversationFlowSource,
    /export const removePendingSubmittedDraftById = \([\s\S]*Object\.entries\(current\)\.find\(\(\[, draft\]\) => draft\.id === id\);[\s\S]*removePendingSubmittedDraftForKey\(current, matchingSessionKey, id\);/,
    "successful cleanup should remove the matching draft from the key where it currently lives",
  );
  assert.doesNotMatch(
    clearSource,
    /props\.selectedSessionId/,
    "successful cleanup should not rely on the currently selected session id",
  );
});

test("pending handoffs materialize from the app callback with captured keys", () => {
  assert.notEqual(flowSendImmediateStart, -1, "sendPromptImmediate should exist in the conversation-flow controller");
  assert.notEqual(flowSendImmediateEnd, -1, "sendPromptImmediate should end before run-state helpers");
  const sendImmediateSource = flowSendImmediateSource;

  assert.match(
    source,
    /sendPromptAsync: \(\s*draft: ComposerDraft,\s*options: SessionSendOptionsBase & \{[\s\S]*targetSessionId\?: string \| null;[\s\S]*onMaterializedSessionId\?: \(handoff: MaterializedSessionHandoff\) => void;[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\},\s*\) => Promise<SessionSubmitResult>;/,
    "session props should let app prompt sends report the scoped materialized session handoff",
  );
  assert.match(
    sendImmediateSource,
    /let materializedSessionIdFromHandoff: string \| null = null;/,
    "sendPromptImmediate should store the materialized id reported by the specific app handoff",
  );
  assert.match(
    conversationFlowSource,
    /export const resolvePendingSessionHandoffMaterialization = \(\{[\s\S]*const materializedPendingKey = handoff\?\.pendingSessionKey\?\.trim\(\) \|\| pendingSessionKey;[\s\S]*if \(materializedPendingKey !== pendingSessionKey\)[\s\S]*if \(handoffClientMessageId && handoffClientMessageId !== clientMessageId\)[\s\S]*const materializedSessionId = handoff\?\.sessionId\?\.trim\(\);[\s\S]*if \(!materializedSessionId\)[\s\S]*if \(isPendingSessionInstanceKey\(materializedSessionId\)\)[\s\S]*kind: "materialize"/,
    "materialization should require the captured pending key/client id and atomically remap to the real queue while keeping the visible base key pointed at it until selectedSessionId catches up",
  );
  assert.match(
    sendImmediateSource,
    /const materializePendingHandoffToSession = \([\s\S]*handoff: MaterializedSessionHandoff \| null \| undefined,[\s\S]*materializationClientMessageId = clientMessageId,[\s\S]*\) => \{[\s\S]*const materialization = resolvePendingSessionHandoffMaterialization\(\{[\s\S]*pendingSessionBaseKeyBeforeHandoff,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*clientMessageId: materializationClientMessageId,[\s\S]*handoff,[\s\S]*\}\);[\s\S]*if \(materialization\.kind === "skip"\) return null;[\s\S]*const materializedSessionKey = materializedSessionKeyFromHandoff\(handoff, materializedSessionId\);[\s\S]*deps\.effects\.batch\(\(\) => \{[\s\S]*deps\.pendingHandoff\.setPendingQueueKeyAwaitingSessionIdForBaseKey\(\s*pendingSessionBaseKey,[\s\S]*materializedSessionKey,[\s\S]*\);[\s\S]*deps\.pendingHandoff\.remapPendingQueueToSession\(\s*pendingSessionKey,\s*materializedSessionId,\s*materializedSessionKey,\s*\);[\s\S]*\}\);[\s\S]*return materializedPendingSessionTarget\.current;/,
    "session view should wire materialization validation through the conversation-flow helper before applying remap effects",
  );
  assert.match(
    sendImmediateSource,
    /onMaterializedSessionId: handleMaterializedSessionId/,
    "pending first sends should pass the captured materialization callback to app sendPrompt",
  );
  assert.match(
    sendImmediateSource,
    /if \([\s\S]*pendingSessionBaseKeyBeforeHandoff &&[\s\S]*pendingSessionKeyBeforeHandoff &&[\s\S]*materializedPendingSessionTarget\.current[\s\S]*const target = materializedPendingSessionTarget\.current;[\s\S]*materializedSessionId: target\.sessionId,/,
    "accepted first-send materialization should only use the materialized id reported by the app handoff",
  );
  assert.doesNotMatch(
    sendImmediateSource,
    /materializedSessionIdFromHandoff \?\? deps\.sessionKeys\.selectedSessionId\(\)\?\.trim\(\)/,
    "accepted fallback must not guess the materialized session from current selected session state",
  );
  assert.match(
    conversationFlowSource,
    /if \(materializedSessionIdFromHandoff\) \{[\s\S]*kind: "clear-base-mapping"[\s\S]*pendingSessionKey: null,[\s\S]*\}/,
    "failure cleanup should not restore a pending mapping after that handoff already materialized",
  );
  assert.match(
    sendImmediateSource,
    /resolvePendingSessionHandoffFailureAction\(\{[\s\S]*materializedSessionIdFromHandoff,[\s\S]*\}\)/,
    "send failure cleanup should pass the materialized handoff id into the cleanup resolver",
  );
});

test("pending first sends pass captured sidebar placeholder metadata to app prompt send", () => {
  assert.match(
    source,
    /import type \{[\s\S]*PendingSidebarSessionMetadata[\s\S]*\} from "\.\.\/types";/,
    "session view should use the shared pending sidebar metadata type in prompt send options",
  );

  assert.notEqual(flowSendImmediateStart, -1, "sendPromptImmediate should exist in the conversation-flow controller");
  assert.notEqual(flowSendImmediateEnd, -1, "sendPromptImmediate should end before run-state helpers");
  const sendImmediateSource = flowSendImmediateSource;

  assert.match(
    sendImmediateSource,
    /const pendingSidebarSessionCreatedAt = deps\.identity\.now\(\);/,
    "pending sidebar placeholder metadata should use a captured creation time",
  );
  assert.match(
    sendImmediateSource,
    /const pendingSidebarWorkspaceId = deps\.pendingHandoff\.createPendingSidebarSessionWorkspaceId\(\);[\s\S]*const pendingSidebarWorkspaceRoot =[\s\S]*deps\.pendingHandoff\.createPendingSidebarSessionWorkspaceRoot\(pendingSidebarWorkspaceId\);[\s\S]*const pendingSidebarSession: PendingSidebarSessionMetadata \| null = pendingSessionKeyBeforeHandoff\s*\? \{[\s\S]*id: pendingSessionKeyBeforeHandoff,[\s\S]*workspaceId: pendingSidebarWorkspaceId,[\s\S]*workspaceRoot: pendingSidebarWorkspaceRoot,[\s\S]*title: draft\.text\.trim\(\),[\s\S]*createdAt: pendingSidebarSessionCreatedAt,[\s\S]*\}[\s\S]*: null;/,
    "pending first sends should capture the pending id, target workspace id/root, title, and creation time",
  );
  assert.match(
    sendImmediateSource,
    /const promptSendOptions: SessionSendOptionsBase & \{[\s\S]*targetSessionId\?: string \| null;[\s\S]*onMaterializedSessionId\?: \(handoff: MaterializedSessionHandoff\) => void;[\s\S]*pendingSession\?: PendingSidebarSessionMetadata \| null;[\s\S]*\} =/,
    "prompt send options should allow pending sidebar metadata",
  );
  assert.match(
    sendImmediateSource,
    /\.\.\.\(pendingSessionKeyBeforeHandoff[\s\S]*onMaterializedSessionId: handleMaterializedSessionId,[\s\S]*pendingSession: pendingSidebarSession/,
    "pending first sends should pass the captured metadata with the materialization callback",
  );
});

test("clicking a pending sidebar row waits for workspace activation before opening the local pending session", () => {
  const openStart = sessionNavigationSource.indexOf("export function openSidebarSessionFromList");
  const openEnd = sessionNavigationSource.indexOf("export async function createSessionWithWorkspaceActivation", openStart);
  assert.notEqual(openStart, -1, "openSidebarSessionFromList should exist");
  assert.notEqual(openEnd, -1, "openSidebarSessionFromList should end before createSessionWithWorkspaceActivation");
  const openSource = sessionNavigationSource.slice(openStart, openEnd);

  assert.match(
    openSource,
    /const openPendingSession = \(nextSessionId: string\) => \{[\s\S]*input\.setSessionBrowseScope\(\{[\s\S]*sessionId: nextSessionId,[\s\S]*workspaceId: input\.workspaceId,[\s\S]*workspaceRoot: root,[\s\S]*directory: input\.target\?\.directory\?\.trim\(\) \|\| session\?\.directory\?\.trim\(\) \|\| root,[\s\S]*conversationId: null,[\s\S]*opencodeSessionId: null,[\s\S]*\}\);[\s\S]*input\.setView\("session", nextSessionId\);[\s\S]*\};[\s\S]*if \(isPendingSessionInstanceKey\(input\.sessionId\)\) \{[\s\S]*activateWorkspaceBeforeOpen: true,[\s\S]*openSession: openPendingSession,/,
    "pending sidebar rows should bind and route to the local pending id only through the guarded activation helper",
  );
  assert.doesNotMatch(
    openSource,
    /openPendingSession\(input\.sessionId\);[\s\S]*openSessionWithWorkspaceActivation\(\{[\s\S]*activateWorkspaceBeforeOpen: true/,
    "pending sidebar rows should not pre-open the local pending id before workspace activation",
  );
  assert.match(
    openSource,
    /return openSessionWithWorkspaceActivation\(\{[\s\S]*openSession: openRealSession,/,
    "real sidebar rows should continue through the existing workspace/session navigation path",
  );
});

test("clicking a pending dashboard sidebar row does not select it as a server session", () => {
  const openStart = dashboardSource.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => {");
  const openEnd = dashboardSource.indexOf("  const resolveVesloWorkspaceId = (workspaceId: string) => {", openStart);
  const helperStart = sessionNavigationSource.indexOf("export function openSidebarSessionFromList");
  const helperEnd = sessionNavigationSource.indexOf("export async function createSessionWithWorkspaceActivation", helperStart);
  assert.notEqual(openStart, -1, "dashboard openSessionFromList should exist");
  assert.notEqual(openEnd, -1, "dashboard openSessionFromList should end before resolveVesloWorkspaceId");
  assert.notEqual(helperStart, -1, "openSidebarSessionFromList should exist");
  assert.notEqual(helperEnd, -1, "openSidebarSessionFromList should end before createSessionWithWorkspaceActivation");
  const openSource = dashboardSource.slice(openStart, openEnd);
  const helperSource = sessionNavigationSource.slice(helperStart, helperEnd);
  const pendingStart = helperSource.indexOf("  if (isPendingSessionInstanceKey(input.sessionId)) {");
  const pendingReturnStart = helperSource.indexOf("    return openSessionWithWorkspaceActivation({", pendingStart);
  const pendingEnd = helperSource.indexOf(
    "  return openSessionWithWorkspaceActivation({",
    pendingReturnStart + "    return openSessionWithWorkspaceActivation({".length,
  );
  assert.notEqual(pendingStart, -1, "dashboard pending branch should exist");
  assert.notEqual(pendingReturnStart, -1, "dashboard pending branch should route through activation helper");
  assert.notEqual(pendingEnd, -1, "dashboard pending branch should return before real-session path");
  const pendingSource = helperSource.slice(pendingStart, pendingEnd);

  assert.match(
    pendingSource,
    /if \(isPendingSessionInstanceKey\(input\.sessionId\)\) \{[\s\S]*return openSessionWithWorkspaceActivation\(\{[\s\S]*activateWorkspaceBeforeOpen: true,[\s\S]*openSession: openPendingSession,[\s\S]*\}\)\.catch/,
    "dashboard pending sidebar rows should wait for workspace activation before routing",
  );
  assert.match(
    helperSource,
    /const openPendingSession = \(nextSessionId: string\) => \{[\s\S]*input\.setSessionBrowseScope\(\{[\s\S]*sessionId: nextSessionId,[\s\S]*conversationId: null,[\s\S]*opencodeSessionId: null,[\s\S]*\}\);[\s\S]*input\.setView\("session", nextSessionId\);[\s\S]*\};/,
    "dashboard pending sidebar rows should only bind local browse scope and route",
  );
  assert.doesNotMatch(
    pendingSource,
    /input\.selectSession/,
    "dashboard pending sidebar rows must not call selectSession with a pending alias",
  );
  assert.match(
    openSource,
    /void openSidebarSessionFromList\(\{[\s\S]*setSessionBrowseScope: props\.setSessionBrowseScope,[\s\S]*selectSession: props\.selectSession,/s,
    "dashboard sidebar rows should delegate through the guarded navigation helper",
  );
});

test("app sendPrompt wires scoped materialized handoff before selecting the created session", () => {
  assert.match(
    appSource,
    /const sessionSendWorkflow = createSessionSendWorkflow\(\{[\s\S]*createSessionAndOpen: \(initialTitle, options\) => createSessionAndOpen\(initialTitle, options\),[\s\S]*\}\);[\s\S]*const sessionFlowFacade = createSessionFlowFacade\(\{[\s\S]*createSessionAndOpen,[\s\S]*sendWorkflow: sessionSendWorkflow,[\s\S]*\}\);[\s\S]*const sendPrompt = sessionFlowFacade\.sendPrompt;/s,
    "app should expose sendPrompt through the session flow facade while preserving createSessionAndOpen wiring",
  );

  const sendPromptStart = sessionSendWorkflowSource.indexOf("  async function sendPrompt(");
  const sendPromptEnd = sessionSendWorkflowSource.indexOf("  async function abortSession(", sendPromptStart);
  assert.notEqual(sendPromptStart, -1, "session send workflow sendPrompt should exist");
  assert.notEqual(sendPromptEnd, -1, "session send workflow sendPrompt should end before abortSession");
  const sendPromptSource = sessionSendWorkflowSource.slice(sendPromptStart, sendPromptEnd);

  assert.match(
    sendPromptSource,
    /options: SessionSendWorkflowSendOptions,/,
    "app sendPrompt options should accept a per-send materialized session callback",
  );

  const createNeededMatch = /if \(!sessionID\) \{\s*deps\.recordSendTrace\("sendPrompt:create-session-needed"/.exec(sendPromptSource);
  const createNeededStart = createNeededMatch?.index ?? -1;
  const createNeededEnd = sendPromptSource.indexOf("    if (!sessionID) {", createNeededStart + 1);
  assert.notEqual(createNeededStart, -1, "first-send create-session branch should exist");
  assert.notEqual(createNeededEnd, -1, "first-send branch should end before blocked-no-session branch");
  const createNeededSource = sendPromptSource.slice(createNeededStart, createNeededEnd);

  assert.match(
    createNeededSource,
    /const createdSessionId = await deps\.sendTraceStep\([\s\S]*"sendPrompt:create-session-and-open",[\s\S]*\(\) => deps\.createSessionAndOpen\(initialSessionTitle, \{[\s\S]*blockAppDuringCreate: blockAppDuringPromptSend,[\s\S]*pendingSession: pendingSidebarSession,[\s\S]*clientMessageId: sendCorrelation\.clientMessageId,[\s\S]*onMaterializedSessionId: options\.onMaterializedSessionId,[\s\S]*preflight: sendPreflight,[\s\S]*\}\),/,
    "first sends should pass the captured client id and scoped handoff callback into createSessionAndOpen",
  );
  assert.doesNotMatch(
    createNeededSource,
    /managedAiRuntimeAlreadyPrepared: true,/,
    "first sends should rely on the prepared preflight instead of a parallel managed-AI readiness flag",
  );
  assert.match(
    createNeededSource,
    /const materializedSessionId = createdSessionId\?\.trim\(\);[\s\S]*if \(materializedSessionId\) \{\s*sessionID = materializedSessionId;\s*pendingSidebarRowRegistered = false;\s*\} else \{[\s\S]*cleanupPendingSidebarSession\(\);[\s\S]*sessionID = null;\s*\}/,
    "sendPrompt should use the created id for routing, keep the materialized row, and clean up only failed pending placeholders",
  );
  assert.doesNotMatch(
    createNeededSource,
    /onMaterializedSessionId\?\.\(/,
    "the materialized callback should not be fed from current selected session state",
  );

  const createSessionStart = sessionCreationWorkflowSource.indexOf("  const runCreateSessionFlow = async (");
  const createSessionEnd = sessionCreationWorkflowSource.indexOf("  const createSession = (", createSessionStart);
  assert.notEqual(createSessionStart, -1, "session creation workflow create flow should exist");
  assert.notEqual(createSessionEnd, -1, "create flow block should end before public wrappers");
  const createSessionSource = sessionCreationWorkflowSource.slice(createSessionStart, createSessionEnd);
  assert.match(
    createSessionSource,
    /const handoff: MaterializedSessionHandoff \| null = clientMessageId[\s\S]*workspaceId:[\s\S]*pendingSessionKey: pendingSidebarSession\?\.id \?\? null,[\s\S]*sessionId: createdSession\.id,[\s\S]*clientMessageId,[\s\S]*sendTraceId: sendTraceId \|\| null,[\s\S]*conversationId: createdSession\.conversationId \?\? null,[\s\S]*opencodeSessionId: createdSession\.opencodeSessionId \?\? createdSession\.id,[\s\S]*if \(applyEffects\) \{[\s\S]*deps\.applyCreatedSessionState\(creationResult, options\);[\s\S]*deps\.applyCreatedSessionTransition\(creationResult\)/,
    "createSessionAndOpen should build a scoped handoff before applying app state and selecting the real session",
  );
});

test("materializing an active pending first send does not immediately drain the queue", () => {
  const effectMatch = /createEffect\(\s*on\(\s*options\.selectedSessionId,/.exec(queueDrainControllerSource);
  const effectStart = effectMatch?.index ?? -1;
  assert.notEqual(effectStart, -1, "selected session effect should exist");
  const effectSource = queueDrainControllerSource.slice(effectStart, effectStart + 2500);

  assert.match(
    effectSource,
    /options\.handleSelectedSessionChanged\(\{[\s\S]*sessionId,[\s\S]*previousSessionId,[\s\S]*pendingBaseKey,[\s\S]*pendingKey,[\s\S]*sessionStatusById: options\.sessionStatusById\(\),[\s\S]*\}\);/s,
    "selected-session effect should delegate pending materialization flow to the conversation-flow controller",
  );
  assert.match(
    conversationFlowSource,
    /const materializedPendingSubmit = pendingKey\s*\? pendingSubmittedDrafts\(\)\[pendingKey\]\?\.state === "sending"\s*: false;[\s\S]*if \(\s*!materializedPendingSubmit &&\s*statusForSessionId\(selectedSessionId, sessionStatusById\) === "idle" &&\s*!deps\.queue\.queuePausedForSessionKey\(sessionKey\)\s*\) \{\s*void controller\.drainNextQueuedDraft\("queue-drain", sessionKey\);/s,
    "selected-session controller should not drain a just-materialized sending first draft",
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
    conversationFlowSource,
    /const isLegacyPendingSessionKey = \(value: string\) =>[\s\S]*isPendingSessionInstanceKey\(value\)[\s\S]*value\.startsWith\("pending:"\)/,
    "pending session instance keys should not resolve to real session ids",
  );
  assert.match(
    conversationFlowSource,
    /export const resolveSessionIdForQueueKey = \(sessionKey: string\) => \{[\s\S]*return isLegacyPendingSessionKey\(sessionKey\) \? null : sessionKey;/,
    "pending session instance queue keys should resolve to null target session ids",
  );
});
