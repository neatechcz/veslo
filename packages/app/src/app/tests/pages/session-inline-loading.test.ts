import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const sessionNavigationSource = readFileSync(new URL("../../pages/session-navigation.ts", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(
  new URL("../../pages/session-conversation-flow.ts", import.meta.url),
  "utf8",
);
const transcriptViewportSource = readFileSync(new URL("../../pages/session-transcript-viewport.ts", import.meta.url), "utf8");
const pendingDraftControllerSource = readFileSync(
  new URL("../../context/pending-session-draft-controller.ts", import.meta.url),
  "utf8",
);
const sessionQueueDrainControllerSource = readFileSync(
  new URL("../../context/session-queue-drain-controller.ts", import.meta.url),
  "utf8",
);

test("session loading stays route-owned without a pending preloader", () => {
  assert.match(
    sessionSource,
    /const showSessionLoadingState = createMemo\(\(\) =>[\s\S]*!activeSessionSwitchHandoffActive\(\) &&[\s\S]*shouldShowSessionLoadingState\(\{[\s\S]*selectedSessionId: transcriptDisplaySessionId\(\),[\s\S]*messageCount: displayedEffectiveMessages\(\)\.length,[\s\S]*loadingEarlierMessages: props\.loadingEarlierMessages,[\s\S]*\}\)[\s\S]*\);/,
    "session page should derive inline loading from the effectively rendered conversation, not raw backend messages only",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showSessionLoadingState\(\)\}>/,
    "session page should render a dedicated inline loading state in the center pane",
  );

  assert.doesNotMatch(
    sessionSource,
    /pendingSessionLoad|setPendingSessionLoad|hasPendingSessionLoad/,
    "SessionView should not carry a separate pending-session preloader state",
  );

  assert.doesNotMatch(
    appSource,
    /pendingSessionLoad|setPendingSessionLoad/,
    "app shell should not own a separate pending-session preloader state",
  );
});

test("workspace setup empty state waits for hydrated workspace metadata", () => {
  assert.match(
    sessionSource,
    /const showWorkspaceSetupEmptyState = createMemo\(\s*\(\) =>\s*props\.workspacesHydrated === true &&\s*!hasWorkspaceConfigured\(\) &&\s*!props\.selectedSessionId &&\s*props\.messages\.length === 0,\s*\);/s,
    "the workspace setup empty state must not flash before bootstrap hydrates the workspace list",
  );
});

test("temporary runtime UI diagnostic is gated to developer mode or explicit mutation tracing", () => {
  assert.match(
    sessionSource,
    /const sessionUiDiagnosticEnabled = \(\) => props\.developerMode \|\| sessionUiMutationTraceEnabled\(\);/,
    "one guard should define the only modes where session UI diagnostics may write",
  );
  assert.match(
    sessionSource,
    /const markTempRuntimeUiRenderSource =[\s\S]*if \(!sessionUiDiagnosticEnabled\(\)\) return;[\s\S]*const snapshot = createTempRuntimeUiRenderSnapshot[\s\S]*setTempRuntimeUiRenderSource\(snapshot\)/s,
    "flow and direct markers should use the shared diagnostic guard",
  );
  assert.match(
    sessionSource,
    /createEffect\(\s*on\([\s\S]*if \(!sessionUiDiagnosticEnabled\(\)\) return;[\s\S]*setTempRuntimeUiRenderSource/s,
    "snapshot metadata effects should not write outside the shared diagnostic guard",
  );
  assert.match(
    sessionSource,
    /const tempRuntimeUiDiagnosticBadge =[\s\S]*<Show when=\{props\.developerMode\}>[\s\S]*TEMP UI marker/s,
    "the temporary runtime UI badge must be hidden outside developer mode",
  );
});

test("session switch records browse scope and routes immediately without arming a preloader", () => {
  const openSessionStart = sessionSource.indexOf("  const openSessionFromList = (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => {");
  const openSessionEnd = sessionSource.indexOf("\n  const ", openSessionStart + 4);
  const helperStart = sessionNavigationSource.indexOf("export function openSidebarSessionFromList");
  const helperEnd = sessionNavigationSource.indexOf("export async function createSessionWithWorkspaceActivation", helperStart);
  assert.notEqual(openSessionStart, -1, "openSessionFromList should exist");
  assert.notEqual(openSessionEnd, -1, "openSessionFromList block end should exist");
  assert.notEqual(helperStart, -1, "openSidebarSessionFromList should exist");
  assert.notEqual(helperEnd, -1, "openSidebarSessionFromList block end should exist");
  const openSessionSource = sessionSource.slice(openSessionStart, openSessionEnd);
  const helperSource = sessionNavigationSource.slice(helperStart, helperEnd);

  assert.doesNotMatch(
    `${openSessionSource}\n${helperSource}`,
    /setPendingSessionLoad|pendingSessionLoad/,
    "sidebar session clicks should not arm a pending-session preloader",
  );
  assert.match(
    helperSource,
    /input\.setSessionBrowseScope\(\{[\s\S]*workspaceId: input\.workspaceId,[\s\S]*conversationId: input\.target\?\.conversationId \?\? session\?\.conversationId \?\? null,[\s\S]*opencodeSessionId: input\.target\?\.opencodeSessionId \?\? session\?\.opencodeSessionId \?\? nextSessionId,[\s\S]*\}\);[\s\S]*input\.setView\("session", nextSessionId\);/s,
    "session click navigation should record browse scope before routing to the target session",
  );
});

test("dev runtime records bounded session DOM mutation batches alongside state changes", () => {
  assert.match(
    sessionSource,
    /const sessionUiMutationTraceEnabled =[\s\S]*import\.meta\.env\?\.DEV[\s\S]*VITE_VESLO_SESSION_UI_MUTATION_TRACE/s,
    "the observer must be compiled out of non-dev builds and explicitly enabled for the dev runtime",
  );
  assert.match(
    sessionSource,
    /new MutationObserver\([\s\S]*observer\.observe\(root, \{ attributes: true, childList: true, subtree: true \}\)/s,
    "the center pane observer should record structural and attribute DOM writes",
  );
  assert.match(
    sessionSource,
    /const isTempRuntimeUiDiagnosticNode =[\s\S]*data-temp-runtime-ui-render-source/s,
    "the observer should identify its own temporary diagnostic badge",
  );
  assert.match(
    sessionSource,
    /const isTempRuntimeUiDiagnosticMutation =[\s\S]*changedNodes\.every/s,
    "the observer should exclude mutations produced solely by its own temporary diagnostic badge",
  );
  assert.match(
    sessionSource,
    /if \(isTempRuntimeUiDiagnosticMutation\(record\)\)[\s\S]*ignoredDiagnosticRecordCount \+= 1;[\s\S]*continue;/s,
    "diagnostic-only mutation records should not be counted as product UI commits",
  );
  assert.match(
    sessionSource,
    /recordSendTrace\("session-ui:mutation-observer-ready", \{[\s\S]*diagnosticNodesExcluded: true,[\s\S]*root: "session-center-pane"/s,
    "the trace should state that self-observation is disabled for the center-pane observer",
  );
  assert.match(
    sessionSource,
    /frame = window\.requestAnimationFrame\(\(\) => flush\("animation-frame"\)\)/,
    "multiple records from one paint should become one trace record",
  );
  assert.match(
    sessionSource,
    /recordSendTrace\("session-ui:render-source-mark",[\s\S]*recordSendTrace\("session-ui:state-change",[\s\S]*recordSendTrace\("session-ui:dom-mutation-batch",/s,
    "the trace should correlate named render owners, reactive state changes, and DOM writes",
  );
  assert.match(
    sessionSource,
    /if \(previous && changedFields\.length === 0\) return;[\s\S]*recordSendTrace\("session-ui:state-change"/s,
    "state traces should suppress callback runs that did not change a sampled state field",
  );
  assert.match(
    sessionSource,
    /<MessageList[\s\S]*onMessageBlocksRecomputed=[\s\S]*MessageList\.messageBlocks[\s\S]*markerKind: "message-blocks"/s,
    "the direct MessageList recompute marker should remain distinct from flow markers",
  );
  assert.match(
    sessionSource,
    /latestUiMarker: renderSource\.source,[\s\S]*latestUiMarkerKind: renderSource\.markerKind,[\s\S]*latestUiMarkerAgeMs:/s,
    "DOM batches should describe their newest marker as temporal context rather than a causal render source",
  );
  assert.match(
    sessionSource,
    /ignoredDiagnosticRecordCount,[\s\S]*attributeNames:/s,
    "product mutation batches should disclose diagnostic records excluded during the same observation window",
  );
  assert.match(
    sessionSource,
    /data-testid="session-center-pane"[\s\S]*setSessionUiMutationRoot\(el\)/s,
    "only the center session surface should be observed, excluding sidebar churn",
  );
  assert.match(
    sessionSource,
    /collect\(observer\.takeRecords\(\)\);[\s\S]*observer\.disconnect\(\)/s,
    "observer cleanup should drain and disconnect the browser observer",
  );
});

test("active session switch handoff suppresses empty browse and loading surfaces", () => {
  assert.match(
    sessionSource,
    /const \[activeSessionSwitchHandoff, setActiveSessionSwitchHandoff\] =[\s\S]*createSignal<ActiveSessionSwitchHandoff \| null>\(null\);/,
    "SessionView should track an active-session handoff while the next transcript is cold",
  );
  assert.match(
    sessionSource,
    /const displayedEffectiveMessages = createMemo\(\(\) =>[\s\S]*activeSessionSwitchHandoffActive\(\)[\s\S]*activeSessionSwitchHandoff\(\)\?\.heldMessages[\s\S]*effectiveRenderedMessages\(\),/s,
    "session switches should keep rendering the last active transcript instead of an empty browse surface",
  );
  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>[\s\S]*displayedEffectiveMessages\(\)\.length === 0[\s\S]*!activeSessionSwitchHandoffActive\(\)[\s\S]*!showSessionLoadingState\(\),/s,
    "the centered composer entry should not appear during active-to-active session handoff",
  );
  assert.match(
    sessionSource,
    /const showFooterComposerArea = createMemo\(\(\) =>[\s\S]*!showSessionLoadingState\(\)[\s\S]*!activeSessionSwitchHandoffActive\(\),/s,
    "the footer composer should stay hidden while the opening loader or active-session handoff owns the pane",
  );
  assert.match(
    sessionSource,
    /<MessageList[\s\S]*messages=\{displayedEffectiveMessages\(\)\}/s,
    "MessageList should render the handoff transcript instead of the cold empty target transcript",
  );
});

test("pending draft write-back only runs while the bare pending draft route owns the composer bucket", () => {
  assert.match(
    pendingDraftControllerSource,
    /createEffect\(\(\) => \{[\s\S]*if \(!deps\.isTauriRuntime\(\)\) return;[\s\S]*if \(!activePendingDraftStorageReady\(\)\) return;[\s\S]*const pendingDraftKey = activePendingDraftKey\(\);[\s\S]*const pendingDraftMetaValue = activePendingDraftMeta\(\);[\s\S]*if \(!pendingDraftKey \|\| !pendingDraftMetaValue\) return;[\s\S]*if \(input\.selectedSessionId\(\)\) return;/s,
    "pending-draft persistence should stop once a real session is selected so a failed send cannot overwrite the pending draft with the real-session composer bucket",
  );
});

test("bare new-session screen centers the composer entry without quickstart templates", () => {
  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>[\s\S]*displayedEffectiveMessages\(\)\.length === 0[\s\S]*!showWorkspaceSetupEmptyState\(\)[\s\S]*!showSessionLoadingState\(\)[\s\S]*\);/s,
    "bare new sessions should derive a dedicated centered composer-entry state from the rendered conversation",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showComposerEntryState\(\)\}>[\s\S]*entryPlacement="center"[\s\S]*<\/Show>/s,
    "the centered composer-entry state should render the composer in center placement before the first send",
  );

  assert.doesNotMatch(
    sessionSource,
    /session\.quickstart_[a-z_]+|showQuickstartEmptyState/,
    "bare new sessions should not render the old quickstart heading or starter action cards",
  );
});

test("first submit dismisses the centered composer entry before backend handoff resolves", () => {
  assert.match(
    sessionSource,
    /const composerEntryDismissed = createMemo\(\(\) => \{[\s\S]*const dismissedBySessionKey = composerEntryDismissedBySessionKey\(\);[\s\S]*if \(dismissedBySessionKey\[currentSessionQueueKey\(\)\]\) return true;[\s\S]*if \(props\.selectedSessionId\) return false;[\s\S]*return Boolean\(dismissedBySessionKey\[pendingSessionQueueKey\(\)\]\);[\s\S]*\}\);/s,
    "the centered entry state should have a local per-session dismissal flag with a base pending-key fallback",
  );

  assert.match(
    sessionSource,
    /const showComposerEntryState = createMemo\(\(\) =>\s*displayedEffectiveMessages\(\)\.length === 0 &&\s*!composerEntryDismissed\(\) &&\s*!showWorkspaceSetupEmptyState\(\) &&\s*!activeSessionSwitchHandoffActive\(\) &&\s*!showSessionLoadingState\(\),\s*\);/s,
    "a submit attempt should hide the centered entry even before backend messages or optimistic handoff survive",
  );

  assert.match(
    sessionSource,
    /const handleSendPrompt = async \(draft: ComposerDraft, options: ComposerSendOptions = \{\}\): Promise<ComposerSendResult> => \{[\s\S]*const submissionSessionKey = currentSessionQueueKey\(\);[\s\S]*if \(showComposerEntryState\(\) \|\| showFooterComposerTargetContext\(\)\) \{[\s\S]*dismissComposerEntryForSessionKey\(submissionSessionKey\);[\s\S]*\}/s,
    "the send handler should dismiss the no-session target context immediately for the session scope captured before the async handoff",
  );
});

test("first submit hides the no-session target picker in the footer composer path", () => {
  assert.match(
    sessionSource,
    /const showFooterComposerTargetContext = createMemo\(\(\) =>\s*!props\.selectedSessionId &&\s*!composerEntryDismissed\(\),\s*\);/s,
    "the footer no-session target picker should be hidden as soon as the entry dismissal flag is set",
  );

  assert.match(
    sessionSource,
    /<Show when=\{showFooterComposerTargetContext\(\)\}>[\s\S]*<ComposerTargetPicker[\s\S]*data-testid="composer-entry-target-heading"[\s\S]*<\/Show>/s,
    "the footer target picker/heading should use the dismissal-aware guard instead of only checking selectedSessionId",
  );
});

test("materializing a pending submitted draft preserves the visible run indicator", () => {
  assert.match(
    sessionQueueDrainControllerSource,
    /const pendingBaseKey = options\.pendingSessionQueueKey\(\);[\s\S]*const pendingKey = !previousSessionId[\s\S]*options\.pendingQueueKeyAwaitingSessionIdByBaseKey\(\)\[pendingBaseKey\] \?\? null[\s\S]*const previousSessionKey = previousSessionId[\s\S]*\? options\.sessionQueueKeyForSessionId\(previousSessionId\)[\s\S]*: null;[\s\S]*if \(!pendingKey && previousSessionKey\) \{\s*options\.preserveRunStateOnSessionSwitch\(previousSessionKey\);[\s\S]*\}/s,
    "selecting the real session created for a pending submit should remap the optimistic draft without resetting the active run indicator",
  );

  assert.doesNotMatch(
    sessionSource,
    /<Show when=\{props\.selectedSessionId \?\? "__no-session"\} keyed>/,
    "the composer/runtime footer must not remount on pending-to-real session materialization",
  );

  assert.match(
    sessionSource,
    /createEffect\(\(\) => \{[\s\S]*const status = props\.sessionStatus;[\s\S]*const diagnostic = activeRunDiagnostic\(\);[\s\S]*if \(status === "running" \|\| status === "retry" \|\| diagnostic\?\.waitReason === "model_retry_no_output"\) \{[\s\S]*const sessionKey = currentSessionQueueKey\(\);[\s\S]*startRun\(sessionKey\);[\s\S]*setRunHasBegunForSessionKey\(sessionKey, true\);[\s\S]*\}[\s\S]*\}\);/s,
    "running, retry, or no-output model retry diagnostics should continue the visible run on the current session key",
  );
});

test("run begun trace is emitted only when the per-session state changes", () => {
  const start = sessionSource.indexOf("  const setRunHasBegunForSessionKey = ");
  const end = sessionSource.indexOf("  const setRunTickForSessionKey = ", start);
  assert.notEqual(start, -1, "setRunHasBegunForSessionKey should exist");
  assert.notEqual(end, -1, "setRunHasBegunForSessionKey block should end before setRunTickForSessionKey");
  const block = sessionSource.slice(start, end);

  assert.match(
    block,
    /const key = sessionKey\.trim\(\);[\s\S]*if \(!key\) return;[\s\S]*if \(untrack\(runStateBySessionKey\)\[key\]\?\.hasBegun === hasBegun\) return;[\s\S]*recordSendTrace\("run-state:has-begun"/,
    "repeated true->true run-state updates should not emit another native trace event",
  );
});

test("materializing a pending submitted draft does not hide the optimistic transcript for initial anchoring", () => {
  assert.match(
    conversationFlowSource,
    /const materializedPendingSubmit = pendingKey\s*\? pendingSubmittedDrafts\(\)\[pendingKey\]\?\.state === "sending"\s*: false;[\s\S]*if \([\s\S]*pendingKey[\s\S]*!isPendingSessionInstanceKey\(selectedSessionId\)[\s\S]*queueKeysShareWorkspace\(deps\.sessionKeys\.workspaceIdForQueueKey, pendingKey, sessionKey\)[\s\S]*deps\.pendingHandoff\.remapPendingQueueToSession\(pendingKey, selectedSessionId\);[\s\S]*return \{[\s\S]*materializedPendingSubmit,[\s\S]*shouldMarkInitialAnchor: !materializedPendingSubmit,/s,
    "pending-to-real session materialization should keep the optimistic message visible instead of arming the transcript invisible anchor state",
  );
  assert.match(
    sessionQueueDrainControllerSource,
    /if \(flowResult\.shouldMarkInitialAnchor && flowResult\.selectedSessionId\) \{\s*options\.markSelectedSessionForInitialAnchor\(flowResult\.selectedSessionId\);\s*\}/,
    "pending-to-real session materialization should keep the optimistic message visible instead of arming the transcript invisible anchor state",
  );
  assert.match(
    sessionSource,
    /markSelectedSessionForInitialAnchor: \(sessionId\) =>\s*transcriptViewport\.markSelectedSessionForInitialAnchor\(sessionId\),/,
    "pending-to-real session materialization should keep the optimistic message visible instead of arming the transcript invisible anchor state",
  );
});

test("materializing a pending submitted draft holds the transcript surface until server messages arrive", () => {
  assert.match(
    sessionSource,
    /const transcriptDisplaySessionId = createMemo\(\(\) =>[\s\S]*resolveTranscriptDisplaySessionId\(\{[\s\S]*selectedSessionId: props\.selectedSessionId,[\s\S]*heldMaterializedSessionId: heldMaterializedSubmitSessionId\(\),[\s\S]*hasSendingOptimisticSubmit: hasSendingOptimisticSubmit\(\),[\s\S]*transcriptMessageCount: props\.messages\.length,[\s\S]*\}\)[\s\S]*\);/s,
    "pending-to-real first-send materialization should not immediately switch the transcript viewport before server transcript messages arrive",
  );

  assert.match(
    sessionSource,
    /const transcriptViewport = createSessionTranscriptViewport\(\{[\s\S]*selectedSessionId: transcriptDisplaySessionId,[\s\S]*\}\);/s,
    "the transcript viewport should use the display session id instead of the raw route-selected session id",
  );

  assert.match(
    sessionSource,
    /const composerResetKey = createMemo\(\(\) =>\s*`\$\{props\.activeComposerTargetId \?\? "__no-target"\}:\$\{transcriptDisplaySessionId\(\) \?\? "__no-session"\}`\s*\);/s,
    "keyed composer entry boundaries should follow the display session id, not the raw route-selected session id",
  );
});

test("session page delegates optimistic run presentation to the pure projection", () => {
  assert.match(
    sessionSource,
    /const runPresentation = createMemo\(\(\) => deriveSessionRunPresentation\(\{[\s\S]*optimisticSending: optimisticSubmittedDraft\(\)\?\.state === "sending"/s,
    "the page should pass optimistic state to the pure run-presentation model",
  );
});

test("cold workspace pending sends use loading label until backend progress starts", () => {
  assert.match(
    sessionSource,
    /const workspaceSendWarmupActive = createMemo\(\(\) => \{[\s\S]*const submitted = optimisticSubmittedDraft\(\);[\s\S]*if \(!submitted \|\| submitted\.state !== "sending"\) return false;[\s\S]*if \(props\.engineReady !== false\) return false;[\s\S]*if \(runHasBegun\(\) \|\| responseStarted\(\)\) return false;[\s\S]*return true;[\s\S]*\}\);/s,
    "pending sends in browsing mode should be labeled as loading while the workspace/runtime is starting",
  );

  assert.match(
    sessionSource,
    /case "responding":\s*return workspaceSendWarmupActive\(\) \? tr\("session\.run_loading"\) : tr\("session\.run_responding"\);/s,
    "Responding/Odpovídám should change to Loading/Nahrávám only during workspace/runtime warmup",
  );
});

test("optimistic responding state survives idle workspace preflight while send handoff is pending", () => {
  assert.match(
    sessionSource,
    /if \(props\.sessionStatus !== "idle"\) return;\s*if \(optimisticSubmittedDraft\(\)\?\.state === "sending"\) return;\s*if \(runHasBegun\(\) \|\| responseStarted\(\)\) return;/s,
    "workspace/runtime startup can keep the session idle for more than the safety grace period, so the pending submitted draft must keep the run indicator visible until handoff resolves",
  );
});

test("pending send state renders an immediate local echo while the footer owns run progress", () => {
  assert.doesNotMatch(
    sessionSource,
    /pendingSubmittedDraftToAssistantPlaceholderMessage/,
    "session view should not turn the Responding/Odpovídám run label into a synthetic assistant text message",
  );

  assert.match(
    sessionSource,
    /const localSubmittedMessage = createMemo<MessageWithParts \| null>\(\(\) => \{[\s\S]*resolvePendingSubmittedRenderReplacement\([\s\S]*renderReplacement\.kind === "show-canonical"[\s\S]*const transcriptViewport = createSessionTranscriptViewport\(\{[\s\S]*messages: \(\) => props\.messages,[\s\S]*localSubmittedMessage,[\s\S]*\}\);[\s\S]*const renderedMessages = transcriptViewport\.renderedMessages;/s,
    "session view should render a local echo only until its canonical message can take its place",
  );

  assert.match(
    transcriptViewportSource,
    /export const resolveTranscriptSourceMessages = <T,>\(\{[\s\S]*localSubmittedMessage \? \[\.\.\.messages, localSubmittedMessage\] : messages as T\[\];/s,
    "rendered messages should append the local echo only while canonical transcript data is absent",
  );

  assert.match(
    sessionSource,
    /const recoveryNotice = createMemo\(\(\) => runPresentation\(\)\.recoveryNotice \?\? null\);[\s\S]*const showFooterRunIndicator = createMemo\(\(\) => showRunIndicator\(\) \|\| Boolean\(recoveryNotice\(\)\)\);[\s\S]*footer=\{\s*showFooterRunIndicator\(\) \?/s,
    "the footer should cover both the standard run indicator and a non-streaming recovery notice",
  );
});

test("model retry diagnostics remain a dedicated lifecycle footer label", () => {
  assert.match(
    sessionSource,
    /const activeRunDiagnostic = createMemo\(\(\) => runDiagnosticForQueueKey\(currentSessionQueueKey\(\)\)\);/,
    "session view should resolve lifecycle diagnostics for the active conversation",
  );
  assert.match(
    sessionSource,
    /const runPresentation = createMemo\(\(\) => deriveSessionRunPresentation\(/,
    "the lifecycle diagnostic phase should be owned by the shared presentation model",
  );
  assert.match(
    sessionSource,
    /runDiagnosticLabel\(\) \|\| thinkingStatus\(\) \|\| runLabel\(\)/,
    "explicit lifecycle diagnostics should take precedence over generic thinking labels",
  );
});
