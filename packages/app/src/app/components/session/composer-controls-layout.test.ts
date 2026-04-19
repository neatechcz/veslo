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
    /class=\{`font-product type-ui-sm inline-flex items-center gap-1\.5 rounded-lg border px-2\.5 py-1 font-medium transition-colors \$\{/,
    '"Jen se ptám" mode switch should keep the compact single-button control with product typography tokens',
  );

  assert.match(
    composerSource,
    /onClick=\{\(\) => props\.onSelectAgent\(isReadonly\(\) \? "veslo" : "plan"\)\}/,
    '"Jen se ptám" control should toggle readonly mode directly',
  );

  assert.doesNotMatch(
    composerSource,
    /class="inline-flex items-center rounded-lg border border-gray-6\/80 bg-gray-2 p-0\.5"/,
    "composer should no longer render the old segmented Build\/Plan\/Task control",
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

test("composer editor keeps compact typography without horizontal scrollbar", () => {
  assert.match(
    composerSource,
    /class="font-reading type-reading-md absolute left-0 top-0 text-gray-9 pointer-events-none"/,
    "placeholder text should use the shared reading typography tokens",
  );

  assert.match(
    composerSource,
    /class="font-reading type-reading-md bg-transparent border-none p-0 pb-2 pr-2 text-gray-12 focus:ring-0 whitespace-pre-wrap break-words resize-none min-h-\[24px\] max-h-40 overflow-y-auto overflow-x-hidden outline-none"/,
    "editor should wrap long content, avoid horizontal scrollbars, and keep the shared reading typography tokens",
  );
});
