import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const conversationFlowSource = readFileSync(new URL("../../pages/session-conversation-flow.ts", import.meta.url), "utf8");
const viewportSource = readFileSync(new URL("../../pages/session-transcript-viewport.ts", import.meta.url), "utf8");
const centerSource = readFileSync(new URL("../../pages/session-center.tsx", import.meta.url), "utf8");
const source = `${sessionSource}\n${conversationFlowSource}\n${viewportSource}\n${centerSource}`;
const appStyles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const flowSendImmediateStart = conversationFlowSource.indexOf("sendPromptImmediate: async (");
const flowSendImmediateEnd = conversationFlowSource.indexOf("export type RunBaseline", flowSendImmediateStart);
const flowSendImmediateSource = conversationFlowSource.slice(flowSendImmediateStart, flowSendImmediateEnd);

test("session view accepts active pending draft key for pending queue identity", () => {
  assert.match(
    source,
    /activePendingDraftKey: string \| null;/,
    "SessionView props should include the active pending draft key",
  );

  assert.match(
    conversationFlowSource,
    /const pendingDraftKey = context\.activePendingDraftKey\?\.trim\(\);[\s\S]*return createUiConversationKey\(\{[\s\S]*workspaceId,[\s\S]*kind: "pending-draft",[\s\S]*id: pendingDraftKey,[\s\S]*\}\);/s,
    "pending sessions should key queues by pending draft identity and workspace scope when available",
  );

  assert.match(
    conversationFlowSource,
    /return createUiConversationKey\(\{[\s\S]*workspaceId: resolveActiveUiConversationWorkspaceId\(context\),[\s\S]*kind: "pending-workspace",[\s\S]*id: "active",[\s\S]*\}\);/s,
    "pending queue identity should fall back to a workspace-scoped active key when no pending draft key exists",
  );

  assert.match(
    sessionSource,
    /const pendingSessionQueueKey = \(\) => resolvePendingSessionQueueKey\(queueKeyContext\(\)\);/,
    "session view should wire pending queue identity through the conversation-flow helper",
  );
});

test("session send flow starts optimistic run UI before prompt handoff resolves", () => {
  const handlerStart = 0;
  const optimisticSet = flowSendImmediateSource.indexOf("createPendingSubmittedDraft({");
  const startRun = flowSendImmediateSource.indexOf("deps.runState.startRun(sessionKey);", optimisticSet);
  const sendCall = flowSendImmediateSource.indexOf("deps.transport.sendPromptAsync(draft, promptSendOptions)", startRun);
  const rejectedBranch = flowSendImmediateSource.indexOf("if (!submitResult.accepted) {", sendCall);
  const markFailed = flowSendImmediateSource.indexOf("markMatchingPendingSubmitFailed(errorMessage);", rejectedBranch);
  const resetRun = flowSendImmediateSource.indexOf(
    'deps.runState.resetRunState(runStateSessionKeyForHandoffFailure(), "send-rejected");',
    rejectedBranch,
  );
  const failedBranchEnd = flowSendImmediateSource.indexOf("deps.feedback.setToastMessage(deps.runtime.error() ?? deps.feedback.tr(\"session.connect_server_to_attach\"));", rejectedBranch);
  const failedBranch = flowSendImmediateSource.slice(rejectedBranch, failedBranchEnd);

  assert.notEqual(flowSendImmediateStart, -1, "session send handler should exist");
  assert.ok(optimisticSet > handlerStart, "session should create a pending submitted draft during send");
  assert.ok(startRun > optimisticSet, "session should start visible run state after the optimistic message is captured");
  assert.ok(sendCall > startRun, "session should show optimistic waiting UI before prompt handoff resolves");
  assert.ok(rejectedBranch > sendCall, "session should check whether the prompt was accepted");
  assert.ok(failedBranchEnd > rejectedBranch, "session should toast after a failed prompt handoff");
  assert.ok(markFailed > rejectedBranch, "failed handoff should mark the pending timeline message as failed");
  assert.ok(resetRun > rejectedBranch, "failed handoff should reset visible run state");
  assert.doesNotMatch(
    failedBranch,
    /props\.setComposerDraft\(draft\);/,
    "failed handoff should not restore the draft into Composer automatically",
  );
});

test("failed handoff marks pending submitted message by immutable submit id", () => {
  assert.match(
    conversationFlowSource,
    /export const markMatchingPendingSubmittedDraftFailed = \(\{[\s\S]*Object\.entries\(draftsBySessionKey\)\.find\(\(\[, draft\]\) => draft\.id === submitId\)[\s\S]*const failed = markPendingSubmittedFailed\(current, errorMessage, errorCode\);[\s\S]*setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\)[\s\S]*\};/,
    "failed handoff should mark the optimistic submitted draft by id so remapped session keys still fail visibly",
  );
  assert.match(
    conversationFlowSource,
    /const result = markMatchingPendingSubmittedDraftFailed\(\{[\s\S]*pendingSubmitId,[\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*materializedSessionIdFromHandoff,[\s\S]*errorMessage,[\s\S]*\}\);/,
    "conversation flow should wire failed handoff marking through the helper",
  );

  assert.doesNotMatch(
    conversationFlowSource,
    /markPendingSubmittedFailed[\s\S]{0,120}current\.sessionKey === sessionKey|current\.sessionKey === sessionKey[\s\S]{0,120}markPendingSubmittedFailed/,
    "failed handoff should not require the original session key after a pending submit remap",
  );
});

test("failed pending handoff restores the pending submit to its original pending draft key after remap", () => {
  assert.match(
    conversationFlowSource,
    /const failed = markPendingSubmittedFailed\(current, errorMessage, errorCode\);[\s\S]*if \(!pendingSessionKeyBeforeHandoff\) \{[\s\S]*setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\)[\s\S]*\}[\s\S]*return \{[\s\S]*setPendingSubmittedDraftForKey\([\s\S]*pendingSessionKeyBeforeHandoff,[\s\S]*\{[\s\S]*\.\.\.failed,[\s\S]*sessionKey: pendingSessionKeyBeforeHandoff,[\s\S]*sessionId: null,[\s\S]*\}/s,
    "failed pending handoff should be visible on the restored pending draft route even if session materialization remapped it first",
  );
});

test("session renders an immediate local echo and synchronously defers to canonical transcript", () => {
  const localEchoIndex = source.indexOf("const localSubmittedMessage = createMemo<MessageWithParts | null>(() => {");
  const viewportControllerIndex = source.indexOf("const transcriptViewport = createSessionTranscriptViewport({");

  assert.ok(
    localEchoIndex >= 0 && localEchoIndex < viewportControllerIndex,
    "the local echo must be defined before the transcript viewport controller reads it",
  );

  assert.match(
    source,
    /const localSubmittedMessage = createMemo<MessageWithParts \| null>\(\(\) => \{[\s\S]*if \(!submitted\) return null;[\s\S]*const renderReplacement = resolvePendingSubmittedRenderReplacement\([\s\S]*if \(renderReplacement\.kind === "show-canonical"\) return null;[\s\S]*projectPendingSubmittedMessage\(submitted, props\.activeWorkspaceRoot\)/s,
    "the immediate local echo should disappear in the same render projection as a unique canonical message",
  );

  assert.doesNotMatch(
    source,
    /pendingSubmittedDraftToAssistantPlaceholderMessage/,
    "session should not render Responding/Odpovídám as synthetic assistant response text",
  );

  assert.match(
    viewportSource,
    /localSubmittedMessage \? \[\.\.\.messages, localSubmittedMessage\] : messages as T\[\]/,
    "rendered transcript messages should append the local submitted echo while canonical is absent",
  );

  assert.match(
    source,
    /const adoption = decidePendingSubmittedTranscriptAdoption\(\{[\s\S]*if \(adoption\.kind !== "adopt"\) return;[\s\S]*removePendingSubmittedDraftForKey\(current, submitted\.sessionKey, submitted\.id\)/,
    "only a deterministic canonical-adoption decision may clear hidden pending submission state",
  );
});

test("session passes failure and delivery-uncertain state to the rendered message list", () => {
  assert.match(
    source,
    /const pendingMessageStateById = createMemo<Record<string, PendingMessageState>>\(\(\) => \{[\s\S]*submitted\.state === "error"[\s\S]*\[submitted\.id\]: \{ state: "error", error: submitted\.error, errorCode: submitted\.errorCode \}[\s\S]*submitted\.state === "outcome-unknown"[\s\S]*state: "sync-warning"/s,
    "session view should distinguish pre-admission failures from delivery-uncertain submissions",
  );

  assert.match(
    source,
    /<MessageList[\s\S]*pendingMessageStateById=\{pendingMessageStateById\(\)\}[\s\S]*editableUserMessage=\{editableUserMessage\(\)\}/,
    "message list should receive typed local message state alongside independently derived editability",
  );
});

test("failed pending submitted messages become editable only through explicit action", () => {
  assert.match(
    source,
    /pendingSubmittedDraftToEditable\(submitted\)/,
    "failed pending submitted messages should contribute an editable draft through the model",
  );

  assert.match(
    conversationFlowSource,
    /pendingEditable\?\.messageId === editable\.messageId[\s\S]*removePendingSubmittedDraftForKey\(current, sessionKey, pendingEditable\.messageId\)[\s\S]*deps\.composer\.setComposerDraft\(pendingEditable\.draft\);/,
    "explicit edit should clear the pending timeline message and load that exact draft into Composer",
  );
});

test("accepted stale-navigation handoff retains pending submission state until canonical adoption", () => {
  const handlerStart = 0;
  const acceptedBranchStart = flowSendImmediateSource.indexOf(
    "options.expectedSessionKey &&",
  );
  const acceptedBranchEnd = flowSendImmediateSource.indexOf("deps.viewport.setStickToBottom(true);", acceptedBranchStart);
  const acceptedBranch = flowSendImmediateSource.slice(acceptedBranchStart, acceptedBranchEnd);

  assert.notEqual(flowSendImmediateStart, -1, "send handler should exist");
  assert.ok(acceptedBranchStart > handlerStart, "send handler should guard accepted stale-navigation handoff");
  assert.ok(acceptedBranchEnd > acceptedBranchStart, "accepted handoff branch should lead into run UI update");

  assert.match(
    conversationFlowSource,
    /export const removePendingSubmittedDraftById = \([\s\S]*Object\.entries\(current\)\.find\(\(\[, draft\]\) => draft\.id === id\);[\s\S]*removePendingSubmittedDraftForKey\(current, matchingSessionKey, id\);[\s\S]*\};/,
    "session should clear pending submit state by immutable pending submit id so remapped session keys still clean up",
  );
  assert.match(
    conversationFlowSource,
    /const clearMatchingPendingSubmit = \(\) => \{[\s\S]*removePendingSubmittedDraftById\(current, pendingSubmitId\),[\s\S]*\};/,
    "conversation flow should wire successful pending submit cleanup through the helper",
  );

  assert.doesNotMatch(
    acceptedBranch,
    /clearMatchingPendingSubmit\(\)/,
    "accepted stale-navigation handoff must not delete a row before its scoped canonical message is observed",
  );

  assert.doesNotMatch(
    acceptedBranch,
    /setOptimisticSubmittedDraft\(null\);/,
    "accepted replacement or queue-drain sends must not clear an unrelated failed pending submit",
  );
});

test("message growth keeps bottom pin active when user is already near the latest content", () => {
  assert.match(
    viewportSource,
    /export const shouldAutoScrollForTranscriptGrowth = \(\{[\s\S]*\}\) => hasTranscriptGrowth\(current, previous\) && !initialAnchorPending && stickToBottom;/,
    "newly appended content should continue auto-scroll while the viewport is pinned to the bottom",
  );

  assert.match(
    sessionSource,
    /shouldAutoScrollForTranscriptGrowth\(\{[\s\S]*initialAnchorPending: initialAnchorPending\(\),[\s\S]*stickToBottom: stickToBottom\(\),[\s\S]*\}\)[\s\S]*scheduleScrollToLatest\("auto"\);/s,
    "session should use the transcript viewport growth policy before scheduling bottom scroll",
  );
});

test("throttled auto-scroll keeps a trailing bottom anchor while pinned", () => {
  assert.match(
    viewportSource,
    /let trailingAutoScrollTimer: number \| undefined;/,
    "transcript viewport should track a deferred auto-scroll retry",
  );

  assert.match(
    viewportSource,
    /const now = deps\.now\(\);\s*const remainingMs = STREAM_SCROLL_MIN_INTERVAL_MS - \(now - lastAutoScrollAt\);\s*if \(nextBehavior === "auto" && remainingMs > 0\) \{\s*if \(trailingAutoScrollTimer === undefined\) \{\s*trailingAutoScrollTimer = window\.setTimeout\(\(\) => untrack\(\(\) => \{\s*trailingAutoScrollTimer = undefined;\s*if \(!stickToBottom\(\)\) return;\s*scheduleScrollToLatest\("auto"\);\s*\}\), remainingMs\);\s*\}\s*return;\s*\}/s,
    "throttled auto-scroll should schedule one trailing scroll while bottom pinning is still active",
  );

  assert.match(
    viewportSource,
    /if \(trailingAutoScrollTimer !== undefined\) \{\s*window\.clearTimeout\(trailingAutoScrollTimer\);\s*trailingAutoScrollTimer = undefined;\s*\}/s,
    "transcript viewport cleanup should cancel deferred auto-scroll retries",
  );
});

test("near-bottom detection follows message sentinel visibility instead of raw scroll height", () => {
  assert.match(
    viewportSource,
    /export const isAtLatest = \(container: HTMLElement, sentinel: HTMLElement\) => \{\s*const containerRect = container\.getBoundingClientRect\(\);\s*const sentinelRect = sentinel\.getBoundingClientRect\(\);\s*return sentinelRect\.bottom <= containerRect\.bottom \+ 1;\s*\};/s,
    "near-bottom should be based on whether the latest-message sentinel is inside the visible viewport",
  );

  assert.match(
    viewportSource,
    /const atLatest = isAtLatest\(container, sentinel\);\s*setNearBottom\(atLatest\);\s*setStickToBottom\(atLatest\);/s,
    "scroll-driven bottom updates should derive both visible bottom state and sticky pin intent from the sentinel",
  );
});

test("auto-scroll keeps a sticky bottom intent so streaming growth does not immediately disable pinning", () => {
  assert.match(
    viewportSource,
    /const \[stickToBottom, setStickToBottom\] = createSignal\(true\);/,
    "transcript viewport should track whether bottom pinning is intentionally active",
  );

  assert.match(
    viewportSource,
    /const atLatest = Boolean\(entry\?\.isIntersecting\) \|\| isAtLatest\(container, sentinel\);\s*if \(atLatest\) \{\s*setNearBottom\(true\);\s*setStickToBottom\(true\);\s*return;\s*\}\s*if \(!stickToBottom\(\)\) \{\s*setNearBottom\(false\);\s*\}/s,
    "observer updates should avoid dropping near-bottom state while sticky pin is still active",
  );

  assert.match(
    sessionSource,
    /shouldAutoScrollForRunProgress\(\{[\s\S]*showRunIndicator: showRunIndicator\(\),[\s\S]*initialAnchorPending: initialAnchorPending\(\),[\s\S]*stickToBottom: stickToBottom\(\),[\s\S]*\}\)[\s\S]*scheduleScrollToLatest\("auto"\);/s,
    "continuous run updates should auto-scroll based on sticky pin intent",
  );

  assert.match(
    sessionSource,
    /shouldAutoScrollForTranscriptGrowth\(\{[\s\S]*initialAnchorPending: initialAnchorPending\(\),[\s\S]*stickToBottom: stickToBottom\(\),[\s\S]*\}\)[\s\S]*scheduleScrollToLatest\("auto"\);/s,
    "message growth should keep auto-scrolling when sticky pin is active",
  );
});

test("chat container avoids oversized bottom padding that creates a large blank gap", () => {
  assert.doesNotMatch(
    source,
    /pt-0 pb-32/,
    "session chat container should not keep a bottom padding block that allows scrolling into blank space",
  );

  assert.match(
    source,
    /showWorkspaceSetupEmptyState\(\) \? "pt-8 pb-20" : "pt-0 pb-0"/,
    "regular chat flow should pin the latest sentinel at the true end of scroll content",
  );
});

test("chat container hides scrollbar when latest content is already in view", () => {
  assert.match(
    source,
    /\$\{nearBottom\(\) \? "chat-scrollbar-hidden" : ""\}/,
    "chat container should toggle a dedicated class that hides the scrollbar while pinned to latest",
  );

  assert.match(
    appStyles,
    /\.chat-scrollbar-hidden\s*\{\s*scrollbar-width:\s*none;\s*-ms-overflow-style:\s*none;\s*\}/s,
    "chat scrollbar hide class should suppress native scrollbar rendering in Firefox and legacy engines",
  );

  assert.match(
    appStyles,
    /\.chat-scrollbar-hidden::-webkit-scrollbar\s*\{\s*width:\s*0;\s*height:\s*0;\s*\}/s,
    "chat scrollbar hide class should suppress WebKit scrollbars",
  );
});

test("jump-to-latest control is anchored to bottom-right and rendered as small down-arrow icon button", () => {
  assert.match(
    source,
    /class="absolute bottom-4 right-4 z-20 pointer-events-none"/,
    "jump-to-latest wrapper should be anchored in the bottom-right corner",
  );

  assert.match(
    source,
    /class="[^"]*h-7 w-7[^"]*rounded-md p-0[^"]*"/,
    "jump-to-latest should be a compact icon-sized button",
  );

  assert.match(
    source,
    /aria-label=\{tr\("session.jump_to_latest"\)\}/,
    "icon button should keep a localized accessibility label",
  );

  assert.match(
    source,
    /<ChevronDown size=\{12\} \/>/,
    "jump-to-latest button should render a small down arrow icon",
  );
});

test("session main column reserves a top safe strip below titlebar toggles", () => {
  assert.match(
    centerSource,
    /<main class="flex-1 min-w-0 flex flex-col overflow-hidden bg-gray-1 pt-12">/,
    "session main column should keep the titlebar overlay area clear so streamed text does not render underneath the top menu",
  );
});

test("session reconnect notice maps to one-shot localized reconnect toasts", () => {
  assert.match(
    source,
    /const reconnectNotice = props\.reconnectNotice;\s*if \(!reconnectNotice\) return;\s*setToastMessage\(\s*reconnectNotice === "reconnecting"\s*\?\s*tr\("session\.reconnecting_toast"\)\s*:\s*tr\("session\.reconnected_toast"\),\s*\);\s*props\.clearReconnectNotice\(\);/s,
    "session view should map reconnect notices to localized reconnecting/reconnected toast messages and clear the notice",
  );
});

test("session reconnect state renders a persistent operational banner", () => {
  assert.match(
    sessionSource,
    /reconnectState: ReconnectState \| null;/,
    "SessionView props should include the persistent reconnect state",
  );
  assert.match(
    sessionSource,
    /data-testid="session-reconnect-state"/,
    "session view should render a visible reconnect state banner",
  );
  assert.match(
    sessionSource,
    /data-reconnect-status=\{state\(\)\.status\}/,
    "reconnect state banner should expose the current state for tests and diagnostics",
  );
});

test("session toast messages stay visible for at least four seconds", () => {
  assert.match(
    source,
    /const SESSION_TOAST_DISMISS_DELAY_MS = 4_000;/,
    "session toast dismiss delay should be defined as at least four seconds",
  );
  assert.match(
    source,
    /window\.setTimeout\(\(\) => setToastMessage\(null\), SESSION_TOAST_DISMISS_DELAY_MS\)/,
    "session toasts should use the four-second dismiss delay",
  );
  assert.equal(source.includes("setToastMessage(null), 2400"), false);
});
