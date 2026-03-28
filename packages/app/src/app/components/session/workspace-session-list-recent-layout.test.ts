import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("recent rows reserve right space for timestamp/menu to avoid title overlap", () => {
  assert.match(
    source,
    /class=\{`w-full flex items-center rounded-xl px-3 py-1 pr-16 text-left transition-colors \$\{/,
    "recent rows should reserve a right column so timestamp and menu never overlap labels",
  );
});

test("recent rows keep timestamp on the right and replace it with menu trigger on hover", () => {
  assert.match(
    source,
    /class="pointer-events-none absolute right-2 bottom-1 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0"/,
    "timestamp should be pinned to the metadata baseline (bottom) and disappear on row hover/focus",
  );

  assert.match(
    source,
    /class="absolute right-2 bottom-1 opacity-0 group-hover\/session-row:opacity-100 group-focus-within\/session-row:opacity-100 transition-opacity"/,
    "row should expose a menu trigger exactly where timestamp disappears on hover",
  );

  assert.match(
    source,
    /title=\{formatSessionTimestampTooltip\(displayTimestamp\(session\(\)\), currentLocale\(\)\)\}/,
    "recent row timestamp should expose exact datetime in tooltip",
  );

  assert.doesNotMatch(
    source,
    /<span class="mt-1 block max-w-full truncate text-\[11px\] text-gray-9">/,
    "timestamp should not be rendered on its own line in recent rows",
  );

  assert.doesNotMatch(source, /class=\{`w-full flex items-center rounded-xl px-3 py-1\.5 text-left transition-colors \$\{/);
});

test("left sidebar session list uses tighter vertical spacing", () => {
  assert.match(
    source,
    /fallback=\{\s*<>\s*<div class="space-y-0">[\s\S]*<For each=\{recentRowsVisible\(\)\}>/,
    "recent-mode session rows should use a zero-gap stack",
  );

  assert.match(
    source,
    /<div class="pl-5 pt-0\.5 space-y-0">/,
    "project session rows should use the same zero-gap stack",
  );
});

test("by-project session rows reserve right space and swap time for three-dot menu on hover", () => {
  assert.match(
    source,
    /class=\{`w-full flex items-center gap-2 rounded-xl px-3 py-1 pr-16 text-left transition-colors \$\{/,
    "by-project rows should reserve a right column so timestamp and menu never overlap labels",
  );

  assert.match(
    source,
    /class="pointer-events-none absolute right-2 top-1\/2 -translate-y-1\/2 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0"/,
    "by-project rows should show right-aligned time that disappears on hover/focus",
  );

  assert.match(
    source,
    /class="absolute right-2 top-1\/2 -translate-y-1\/2 opacity-0 group-hover\/session-row:opacity-100 group-focus-within\/session-row:opacity-100 transition-opacity"/,
    "by-project rows should show a three-dot trigger in place of time on hover/focus",
  );

  assert.match(
    source,
    /title=\{formatSessionTimestampTooltip\(displayTimestamp\(session\(\)\), currentLocale\(\)\)\}/,
    "by-project row timestamp should expose exact datetime in tooltip",
  );

  assert.doesNotMatch(source, /class=\{`w-full flex items-center gap-2 rounded-xl px-3 py-1\.5 text-left transition-colors \$\{/);
});

test("recent rows keep metadata tucked closer to the title line", () => {
  assert.match(
    source,
    /<div class="mt-px flex items-center gap-1 text-\[11px\] text-gray-10 min-w-0">/,
    "recent rows should keep the metadata line visually tighter to the title",
  );

  assert.match(
    source,
    /class="pointer-events-none absolute right-2 bottom-1 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0"/,
    "recent row timestamp should sit slightly tighter to the row bottom edge",
  );

  assert.match(
    source,
    /class="absolute right-2 bottom-1 opacity-0 group-hover\/session-row:opacity-100 group-focus-within\/session-row:opacity-100 transition-opacity"/,
    "recent row menu trigger should replace the timestamp in the tighter bottom position",
  );
});
