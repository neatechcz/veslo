import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("composer uses a compact control rail below the editor", () => {
  assert.match(
    composerSource,
    /class="mt-3 flex flex-wrap items-center gap-2 pt-2"/,
    "composer should group post-editor controls into one compact rail without an extra divider line",
  );

  assert.doesNotMatch(
    composerSource,
    /class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-6\/70 pt-2"/,
    "composer should not render a separator line between editor and controls",
  );

  assert.match(
    composerSource,
    /class="inline-flex items-center rounded-lg border border-gray-6\/80 bg-gray-2 p-0\.5"/,
    "mode switch should use a compact segmented control",
  );

  assert.match(
    composerSource,
    /class="block text-\[11px\] leading-4 text-gray-9 truncate pr-4"/,
    "composer disclaimer should render as a block with extra right padding so last words stay clear of send/stop controls",
  );

  assert.match(
    composerSource,
    /class="inline-flex items-center rounded-lg border border-gray-6\/80 bg-gray-2 p-0\.5"[\s\S]*translate\("session\.choose_folder"\)[\s\S]*translate\("session\.composer_disclaimer"\)/,
    "folder controls should sit between mode selection and disclaimer in the compact rail",
  );

  assert.doesNotMatch(
    composerSource,
    /class="relative min-h-\[120px\]"/,
    "composer should not force a tall min-height block that creates an empty row below controls",
  );
});
