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
    /<div class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3">[\s\S]*<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">/,
    "session rows container should own vertical scroll and shift scrollbar toward the sidebar edge",
  );

  assert.doesNotMatch(
    source,
    /<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">[\s\S]*<div class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3">/,
    "session rows should not wrap the scroll container that contains them",
  );
});
