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

test("workspace session sidebar keeps the control rail ordered and compact-safe", () => {
  assert.match(
    source,
    /<div class="mb-3 flex flex-wrap items-center gap-2" ref=\{\(el\) => \(sidebarControlsRef = el\)\}>/,
    "sidebar controls should wrap instead of colliding at narrow widths",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.by_project"\)\}[\s\S]*aria-label=\{tr\("sidebar\.recent"\)\}[\s\S]*aria-label=\{tr\("sidebar\.new_session"\)\}[\s\S]*aria-label=\{tr\("session\.command_palette_search_sessions"\)\}[\s\S]*aria-label=\{tr\("sidebar\.add_directory_session"\)\}/,
    "control row should keep folder, recents, new, search, and add-directory actions in order",
  );

  assert.match(
    source,
    /<div class="ml-auto flex shrink-0 items-center gap-2">/,
    "search and add-directory actions should stay in a right-aligned action cluster",
  );

  assert.doesNotMatch(
    source,
    /<div class="relative mb-3" ref=\{\(el\) => \(addWorkspaceMenuRef = el\)\}>[\s\S]*class="w-full flex items-center justify-center gap-2 px-3 py-2\.5 rounded-lg text-\[13px\] font-medium text-gray-11 border border-gray-6 bg-gray-1 hover:bg-gray-2 shadow-sm transition-colors"/,
    "old standalone full-width new-session block should no longer be present",
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
