import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const appStyles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

test("session send flow starts run UI only after the send is accepted", () => {
  const handlerStart = source.indexOf("const handleSendPrompt = async (draft: ComposerDraft) => {");
  const sendCall = source.indexOf("const accepted = await props.sendPromptAsync(draft);", handlerStart);
  const rejectedBranch = source.indexOf("if (!accepted) {", sendCall);
  const stickToBottom = source.indexOf("setStickToBottom(true);", rejectedBranch);
  const startRun = source.indexOf("startRun();", stickToBottom);

  assert.notEqual(handlerStart, -1, "session send handler should exist");
  assert.ok(sendCall > handlerStart, "session should await prompt enqueue before send UI starts");
  assert.ok(rejectedBranch > sendCall, "session should check whether the prompt was accepted");
  assert.ok(stickToBottom > rejectedBranch, "session should only pin to latest after accepted send");
  assert.ok(startRun > stickToBottom, "session should only enter sending state after the prompt enqueue succeeds");
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
