import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session send flow requests immediate scroll to latest", () => {
  assert.match(
    source,
    /const handleSendPrompt = \(draft: ComposerDraft\) => \{\s*scheduleScrollToLatest\("auto"\);\s*startRun\(\);[\s\S]*?sendPromptAsync/s,
    "sending a prompt should immediately pin the view to the latest content before run updates stream in",
  );
});

test("message growth keeps bottom pin active when user is already near the latest content", () => {
  assert.match(
    source,
    /if \(mLen > prevM \|\| tLen > prevT \|\| pCount > prevP\) \{\s*if \(!initialAnchorPending\(\) && nearBottom\(\)\) \{\s*scheduleScrollToLatest\("auto"\);/s,
    "newly appended content should continue auto-scroll while the user is already near bottom",
  );
});

test("near-bottom detection uses strict scroll position math for arrow visibility", () => {
  assert.match(
    source,
    /const isAtBottom = \(element: HTMLElement\) => \{\s*const distanceToBottom = element\.scrollHeight - \(element\.scrollTop \+ element\.clientHeight\);\s*return distanceToBottom <= 1;\s*\};/s,
    "near-bottom should be computed from scroll metrics with strict threshold",
  );

  assert.match(
    source,
    /container\.addEventListener\("scroll", updateNearBottom, \{ passive: true \}\);/s,
    "near-bottom should be refreshed on scroll events",
  );
});

test("chat container avoids oversized bottom padding that creates a large blank gap", () => {
  assert.doesNotMatch(
    source,
    /pt-12 pb-56/,
    "session chat container should not reserve an excessively tall bottom padding",
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
