import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

test("session view accepts active pending draft key for pending queue identity", () => {
  assert.match(
    source,
    /activePendingDraftKey: string \| null;/,
    "SessionView props should include the active pending draft key",
  );

  assert.match(
    source,
    /const pendingDraftKey = props\.activePendingDraftKey\?\.trim\(\);[\s\S]*return `pending-draft:\$\{pendingDraftKey\}`;/,
    "pending sessions should key queues by pending draft identity when available",
  );

  assert.match(
    source,
    /return `pending-workspace:\$\{props\.activeWorkspaceId \|\| "default"\}`;/,
    "pending queue identity should fall back to workspace only when no pending draft key exists",
  );
});

test("session send flow starts optimistic run UI before prompt handoff resolves", () => {
  const handlerStart = source.indexOf("const sendPromptImmediate = async (");
  const optimisticSet = source.indexOf("createPendingSubmittedDraft({", handlerStart);
  const startRun = source.indexOf("startRun(sessionKey);", optimisticSet);
  const sendCall = source.indexOf("props.sendPromptAsync(draft, promptSendOptions)", startRun);
  const rejectedBranch = source.indexOf("if (!accepted) {", sendCall);
  const markFailed = source.indexOf("markMatchingPendingSubmitFailed(errorMessage);", rejectedBranch);
  const resetRun = source.indexOf("resetRunState(runStateSessionKeyForHandoffFailure());", rejectedBranch);
  const failedBranchEnd = source.indexOf("setToastMessage(props.error ?? tr(\"session.connect_server_to_attach\"));", rejectedBranch);
  const failedBranch = source.slice(rejectedBranch, failedBranchEnd);

  assert.notEqual(handlerStart, -1, "session send handler should exist");
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
    source,
    /const markMatchingPendingSubmitFailed = \(errorMessage: string\) => \{[\s\S]*Object\.entries\(draftsBySessionKey\)\.find\(\(\[, draft\]\) => draft\.id === pendingSubmitId\)[\s\S]*const failed = markPendingSubmittedFailed\(current, errorMessage\);[\s\S]*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);[\s\S]*\};/,
    "failed handoff should mark the optimistic submitted draft by id so remapped session keys still fail visibly",
  );

  assert.doesNotMatch(
    source,
    /markPendingSubmittedFailed[\s\S]{0,120}current\.sessionKey === sessionKey|current\.sessionKey === sessionKey[\s\S]{0,120}markPendingSubmittedFailed/,
    "failed handoff should not require the original session key after a pending submit remap",
  );
});

test("failed pending handoff restores the pending submit to its original pending draft key after remap", () => {
  assert.match(
    source,
    /const failed = markPendingSubmittedFailed\(current, errorMessage\);[\s\S]*if \(pendingSessionKeyBeforeHandoff\) \{[\s\S]*return setPendingSubmittedDraftForKey\(draftsBySessionKey, pendingSessionKeyBeforeHandoff, \{[\s\S]*\.\.\.failed,[\s\S]*sessionKey: pendingSessionKeyBeforeHandoff,[\s\S]*sessionId: null,[\s\S]*\}\);[\s\S]*\}[\s\S]*return setPendingSubmittedDraftForKey\(draftsBySessionKey, matchingSessionKey, failed\);/s,
    "failed pending handoff should be visible on the restored pending draft route even if session materialization remapped it first",
  );
});

test("session renders a temporary submitted user message while footer indicator owns responding state", () => {
  const optimisticIndex = source.indexOf("const optimisticSubmittedMessage = createMemo<MessageWithParts | null>(() => {");
  const renderedIndex = source.indexOf("const renderedMessages = createMemo(() => {");

  assert.ok(
    optimisticIndex >= 0 && optimisticIndex < renderedIndex,
    "the optimistic submitted user memo must be defined before renderedMessages reads it",
  );

  assert.match(
    source,
    /pendingSubmittedDraftToMessage\(submitted, props\.activeWorkspaceRoot\)/,
    "session should derive a synthetic user message from the pending submitted draft model",
  );

  assert.doesNotMatch(
    source,
    /pendingSubmittedDraftToAssistantPlaceholderMessage/,
    "session should not render Responding/Odpovídám as synthetic assistant response text",
  );

  assert.match(
    source,
    /const optimisticMessage = optimisticSubmittedMessage\(\);\s*const sourceMessages = optimisticMessage \? \[\.\.\.props\.messages, optimisticMessage\] : props\.messages;/,
    "rendered messages should append only the optimistic user message",
  );

  assert.match(
    source,
    /if \(!submittedDraftHasMessageInTranscript\(submitted\)\) return;[\s\S]*removePendingSubmittedDraftForKey\(current, submitted\.sessionKey, submitted\.id\)/,
    "accepted handoff should clear the matching optimistic placeholder once the server transcript owns display",
  );
});

test("session passes pending submit status to the rendered message list", () => {
  assert.match(
    source,
    /const pendingMessageStateById = createMemo<Record<string, PendingMessageState>>\(\(\) => \{\s*const submitted = optimisticSubmittedDraft\(\);[\s\S]*if \(submitted\.state !== "error"\) return \{\};[\s\S]*return \{\s*\[submitted\.id\]: \{ state: submitted\.state, error: submitted\.error \},\s*\};\s*\}\);/s,
    "session view should expose pending submit state only for failed handoffs, not while the assistant is responding",
  );

  assert.match(
    source,
    /<MessageList[\s\S]*pendingMessageStateById=\{pendingMessageStateById\(\)\}[\s\S]*editableUserMessage=\{editableUserMessage\(\)\}/,
    "message list should receive pending submit state alongside editability",
  );
});

test("failed pending submitted messages become editable only through explicit action", () => {
  assert.match(
    source,
    /pendingSubmittedDraftToEditable\(submitted\)/,
    "failed pending submitted messages should contribute an editable draft through the model",
  );

  assert.match(
    source,
    /handleEditUserMessage[\s\S]*removePendingSubmittedDraftForKey\(current, currentSessionQueueKey\(\), pendingEditable\.messageId\)[\s\S]*props\.setComposerDraft\(pendingEditable\.draft\);/,
    "explicit edit should clear the pending timeline message and load that exact draft into Composer",
  );
});

test("accepted handoff does not clear unrelated failed pending submitted messages", () => {
  const handlerStart = source.indexOf("const sendPromptImmediate = async (");
  const acceptedBranchStart = source.indexOf(
    "if (options.expectedSessionKey && currentSessionQueueKey() !== options.expectedSessionKey)",
    handlerStart,
  );
  const acceptedBranchEnd = source.indexOf("setStickToBottom(true);", acceptedBranchStart);
  const acceptedBranch = source.slice(acceptedBranchStart, acceptedBranchEnd);

  assert.ok(acceptedBranchStart > handlerStart, "send handler should guard accepted stale-navigation handoff");
  assert.ok(acceptedBranchEnd > acceptedBranchStart, "accepted handoff branch should lead into run UI update");

  assert.match(
    source,
    /const clearMatchingPendingSubmit = \(\) => \{[\s\S]*Object\.entries\(current\)\.find\(\(\[, draft\]\) => draft\.id === pendingSubmitId\);[\s\S]*removePendingSubmittedDraftForKey\(current, matchingSessionKey, pendingSubmitId\);[\s\S]*\};/,
    "session should clear pending submit state by immutable pending submit id so remapped session keys still clean up",
  );

  assert.match(
    acceptedBranch,
    /if \(showOptimisticSubmit\) \{\s*clearMatchingPendingSubmit\(\);\s*\}\s*return accepted;/,
    "accepted stale-navigation handoff should only clear this send's pending submit",
  );

  assert.doesNotMatch(
    acceptedBranch,
    /setOptimisticSubmittedDraft\(null\);/,
    "accepted replacement or queue-drain sends must not clear an unrelated failed pending submit",
  );
});

test("message growth keeps bottom pin active when user is already near the latest content", () => {
  assert.match(
    source,
    /if \(mLen > prevM \|\| tLen > prevT \|\| pCount > prevP\) \{\s*if \(!initialAnchorPending\(\) && stickToBottom\(\)\) \{\s*scheduleScrollToLatest\("auto"\);/s,
    "newly appended content should continue auto-scroll while the user is already near bottom",
  );
});

test("throttled auto-scroll keeps a trailing bottom anchor while pinned", () => {
  assert.match(
    source,
    /let trailingAutoScrollTimer: number \| undefined;/,
    "session should track a deferred auto-scroll retry",
  );

  assert.match(
    source,
    /const remainingMs = STREAM_SCROLL_MIN_INTERVAL_MS - \(now - lastAutoScrollAt\);\s*if \(nextBehavior === "auto" && remainingMs > 0\) \{\s*if \(trailingAutoScrollTimer === undefined\) \{\s*trailingAutoScrollTimer = window\.setTimeout\(\(\) => \{\s*trailingAutoScrollTimer = undefined;\s*if \(!stickToBottom\(\)\) return;\s*scheduleScrollToLatest\("auto"\);\s*\}, remainingMs\);\s*\}\s*return;\s*\}/s,
    "throttled auto-scroll should schedule one trailing scroll while bottom pinning is still active",
  );

  assert.match(
    source,
    /if \(trailingAutoScrollTimer !== undefined\) \{\s*window\.clearTimeout\(trailingAutoScrollTimer\);\s*trailingAutoScrollTimer = undefined;\s*\}/s,
    "session cleanup should cancel deferred auto-scroll retries",
  );
});

test("near-bottom detection follows message sentinel visibility instead of raw scroll height", () => {
  assert.match(
    source,
    /const isAtLatest = \(container: HTMLElement, sentinel: HTMLElement\) => \{\s*const containerRect = container\.getBoundingClientRect\(\);\s*const sentinelRect = sentinel\.getBoundingClientRect\(\);\s*return sentinelRect\.bottom <= containerRect\.bottom \+ 1;\s*\};/s,
    "near-bottom should be based on whether the latest-message sentinel is inside the visible viewport",
  );

  assert.match(
    source,
    /const atLatest = isAtLatest\(container, sentinel\);\s*setNearBottom\(atLatest\);\s*setStickToBottom\(atLatest\);/s,
    "scroll-driven bottom updates should derive both visible bottom state and sticky pin intent from the sentinel",
  );
});

test("auto-scroll keeps a sticky bottom intent so streaming growth does not immediately disable pinning", () => {
  assert.match(
    source,
    /const \[stickToBottom, setStickToBottom\] = createSignal\(true\);/,
    "session should track whether bottom pinning is intentionally active",
  );

  assert.match(
    source,
    /const atLatest = Boolean\(entry\?\.isIntersecting\) \|\| isAtLatest\(container, sentinel\);\s*if \(atLatest\) \{\s*setNearBottom\(true\);\s*setStickToBottom\(true\);\s*return;\s*\}\s*if \(!stickToBottom\(\)\) \{\s*setNearBottom\(false\);\s*\}/s,
    "observer updates should avoid dropping near-bottom state while sticky pin is still active",
  );

  assert.match(
    source,
    /if \(initialAnchorPending\(\)\) return;\s*if \(!stickToBottom\(\)\) return;\s*scheduleScrollToLatest\("auto"\);/s,
    "continuous run updates should auto-scroll based on sticky pin intent",
  );

  assert.match(
    source,
    /if \(mLen > prevM \|\| tLen > prevT \|\| pCount > prevP\) \{\s*if \(!initialAnchorPending\(\) && stickToBottom\(\)\) \{\s*scheduleScrollToLatest\("auto"\);/s,
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
    /class="[^"]*h-7 w-7 rounded-full p-0[^"]*"/,
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
    source,
    /<main class="flex-1 flex flex-col overflow-hidden bg-gray-1 pt-12">/,
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
