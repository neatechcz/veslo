import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("recent rows avoid oversized right padding that squeezes labels", () => {
  assert.match(
    source,
    /class=\{`w-full flex items-center rounded-xl px-3 py-1\.5 text-left transition-colors \$\{/,
    "recent rows should not reserve right-side width so text can use the full menu width by default",
  );
});

test("recent rows keep timestamp on the right and replace it with menu trigger on hover", () => {
  assert.match(
    source,
    /class="pointer-events-none absolute right-2 top-\[60%\] -translate-y-1\/2 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0"/,
    "timestamp should be absolutely positioned on the far right and disappear on row hover/focus",
  );

  assert.match(
    source,
    /class="absolute right-2 top-\[60%\] -translate-y-1\/2 opacity-0 group-hover\/session-row:opacity-100 group-focus-within\/session-row:opacity-100 transition-opacity"/,
    "row should expose a menu trigger exactly where timestamp disappears on hover",
  );

  assert.doesNotMatch(
    source,
    /<span class="mt-1 block max-w-full truncate text-\[11px\] text-gray-9">/,
    "timestamp should not be rendered on its own line in recent rows",
  );

  assert.doesNotMatch(
    source,
    /class=\{`w-full flex items-center rounded-xl px-3 py-1\.5 text-left transition-colors pr-10 \$\{/,
    "recent row button should not reserve right padding in idle state",
  );
});

test("left sidebar session list uses tighter vertical spacing", () => {
  assert.match(
    source,
    /<div class="space-y-1\.5 mb-2">/,
    "top-level session rows should be closer together",
  );

  assert.match(
    source,
    /<div class="pl-5 pt-0\.5 space-y-0\.5">/,
    "project session rows should also use tighter spacing",
  );
});
