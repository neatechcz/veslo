import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("composer uses a compact control rail below the editor", () => {
  assert.match(
    composerSource,
    /class="mt-3 flex items-center justify-between gap-3 pt-2"/,
    "composer should split post-editor controls into left and right action groups",
  );

  assert.doesNotMatch(
    composerSource,
    /class="mt-3 flex flex-wrap items-center gap-2 pt-2"/,
    "composer should no longer use the old compact single-rail layout",
  );

  assert.match(
    composerSource,
    /class="inline-flex items-center rounded-lg border border-gray-6\/80 bg-gray-2 p-0\.5"/,
    "mode switch should use a compact segmented control",
  );

  assert.match(
    composerSource,
    /class="flex shrink-0 items-center gap-2"/,
    "composer should keep send/stop aligned to the right edge of the control row",
  );

  assert.doesNotMatch(
    composerSource,
    /disclaimerText\(\)/,
    "composer should no longer own the disclaimer text",
  );

  assert.doesNotMatch(
    composerSource,
    /workspaceLabel\(\)\.label/,
    "composer should no longer own the current workspace label",
  );

  assert.doesNotMatch(
    composerSource,
    /class="block text-\[11px\] leading-4 text-gray-9 truncate whitespace-nowrap"/,
    "composer disclaimer should no longer render inside the input rail",
  );
});
