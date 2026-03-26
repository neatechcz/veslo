import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("recent rows avoid oversized right padding that squeezes labels", () => {
  assert.doesNotMatch(
    source,
    /class=\{`w-full flex items-center min-h-11 px-3 rounded-xl text-left transition-colors pr-20 \$\{/,
    "recent rows should not reserve an oversized right column that compresses title and metadata",
  );

  assert.match(
    source,
    /class=\{`w-full flex min-h-11 rounded-xl px-3 py-2 pr-14 text-left transition-colors \$\{/,
    "recent rows should keep compact action padding while allowing labels to use most of the row width",
  );
});

test("recent rows render timestamp as a full-width metadata line", () => {
  assert.match(
    source,
    /<span class="mt-1 block max-w-full truncate text-\[11px\] text-gray-9">[\s\S]*formatRelativeTime\(displayTimestamp\(session\(\)\)\)/,
    "timestamp should be rendered as its own line so it cannot cover row description text",
  );

  assert.doesNotMatch(
    source,
    /<span class="ml-2 text-\[11px\] text-gray-9 whitespace-nowrap">/,
    "legacy right-aligned timestamp column should be removed from recent rows",
  );
});
