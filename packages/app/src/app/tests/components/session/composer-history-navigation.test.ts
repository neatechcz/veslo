import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");

test("composer history navigation is direction-aware and does not hijack modified arrow keys", () => {
  assert.match(
    composerSource,
    /const canNavigateHistory = \(direction: "up" \| "down", event: KeyboardEvent\) => \{/,
    "history navigation guard should receive key direction and keyboard modifiers",
  );

  assert.match(
    composerSource,
    /if \(event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return false;/,
    "history navigation should not intercept Shift\/modifier-based native selection and cursor movement",
  );

  assert.match(
    composerSource,
    /return direction === "up" \? offsets\.start === 0 : offsets\.start === total;/,
    "history should only trigger at start for ArrowUp and at end for ArrowDown",
  );

  assert.match(
    composerSource,
    /if \(event\.key === "ArrowUp" && canNavigateHistory\("up", event\)\) \{[\s\S]*?navigateHistory\("up"\);/,
    "ArrowUp history navigation should be gated through the direction-aware guard",
  );

  assert.match(
    composerSource,
    /if \(event\.key === "ArrowDown" && canNavigateHistory\("down", event\)\) \{[\s\S]*?navigateHistory\("down"\);/,
    "ArrowDown history navigation should be gated through the direction-aware guard",
  );
});

test("composer history navigation does not replace a live typed draft", () => {
  assert.match(
    composerSource,
    /if \(historyIndex\(\)\[mode\(\)\] === -1 && hasDraftContent\(\)\) return false;/,
    "history navigation should not consume ArrowUp while the current non-history draft has text",
  );
});
