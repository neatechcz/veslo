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

test("workspace session sidebar keeps the action icons in a right-aligned cluster", () => {
  assert.match(
    source,
    /<div class="mb-3 flex items-center gap-2">[\s\S]*<div class="ml-auto flex items-center gap-2">/,
    "view toggle row should reserve a right-aligned action cluster for search and add-directory actions",
  );

  assert.match(
    source,
    /FolderPlus/,
    "workspace session list should import and render the add-directory icon",
  );

  assert.match(
    source,
    /onAddDirectorySession/,
    "workspace session list should expose a dedicated callback for picker-driven directory sessions",
  );
});
