import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session sidebar keeps controls pinned while only session rows scroll", () => {
  assert.match(
    source,
    /<div class="flex h-full min-h-0 flex-col">/,
    "workspace session list should be a full-height flex column so headers and list can be split",
  );

  assert.match(
    source,
    /<div class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3"[^>]*>[\s\S]*<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">/,
    "session rows container should own vertical scroll and shift scrollbar toward the sidebar edge",
  );

  assert.doesNotMatch(
    source,
    /<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">[\s\S]*<div class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3">/,
    "session rows should not wrap the scroll container that contains them",
  );
});

test("workspace session sidebar keeps the control rail compact-safe and ordered", () => {
  assert.match(
    source,
    /<div class="mb-3 flex flex-wrap items-center gap-2">/,
    "sidebar controls should wrap instead of colliding at narrow widths",
  );

  assert.doesNotMatch(
    source,
    /<div class="mb-3 flex items-center gap-2">/,
    "sidebar controls should not regress to a single non-wrapping row",
  );

  assert.match(
    source,
    /<div class="inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-6 bg-gray-1 p-1 shadow-sm">[\s\S]*<div class="relative flex min-w-\[9rem\] flex-1"/,
    "the new session control should sit between the left toggle cluster and the right action cluster",
  );

  assert.match(
    source,
    /tr\("sidebar\.new_session"\)/,
    "the compact control row should keep the primary new-session action visible",
  );

  assert.match(
    source,
    /<div class="ml-auto flex shrink-0 items-center gap-2">/,
    "search and add-directory actions should stay in a right-aligned action cluster",
  );
});
