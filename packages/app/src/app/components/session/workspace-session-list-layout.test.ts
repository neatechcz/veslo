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
    /<div[\s\S]*class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3"[^>]*>[\s\S]*<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">/,
    "session rows container should own vertical scroll and shift scrollbar toward the sidebar edge",
  );

  assert.doesNotMatch(
    source,
    /<div class="space-y-(?:2\.5|1\.5) mb-(?:3|2)">[\s\S]*<div[\s\S]*class="min-h-0 flex-1 overflow-y-auto -mr-3 pr-3"/,
    "session rows should not wrap the scroll container that contains them",
  );
});

test("workspace session sidebar keeps the control rail ordered and compact-safe", () => {
  assert.match(
    source,
    /<div class="mb-3 flex flex-nowrap items-center gap-1" ref=\{\(el\) => \(sidebarControlsRef = el\)\}>/,
    "sidebar controls should stay in a single row, even at minimum sidebar width",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.new_session"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.by_project"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.recent"\)\}[\s\S]*data-tooltip=\{tr\("session\.command_palette_search_sessions"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.add_directory_session"\)\}/,
    "control row should keep new, folder, recents, search, and add-directory actions in order",
  );

  assert.match(
    source,
    /<div class="ml-auto flex shrink-0 items-center gap-1">/,
    "search and add-directory actions should stay in a right-aligned action cluster",
  );

  assert.match(
    source,
    /inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-6 bg-gray-1 p-0\.5 shadow-sm/,
    "the by-project/recent segmented control should use compact padding so its outer height matches neighboring h-8 controls",
  );

  assert.doesNotMatch(
    source,
    /inline-flex shrink-0 items-center gap-1 rounded-full border border-gray-6 bg-gray-1 p-1 shadow-sm/,
    "the segmented control should not regress to p-1 because that makes the first two top controls taller than the rest",
  );

  assert.doesNotMatch(
    source,
    /min-w-\[9rem\]/,
    "new-session control should not force a large minimum width that can push the control row to a second line",
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

test("by-project rows keep the branch toggle inline before the title without overlay chrome", () => {
  assert.match(
    source,
    /sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)/,
    "by-project rows should reuse the shared branch toggle renderer",
  );

  assert.match(
    source,
    /<div class="relative min-w-0 flex-1">/,
    "by-project rows should keep the title/content wrapper around the inline toggle and label",
  );

  assert.match(
    source,
    /<div class="flex items-center gap-1\.5 min-w-0">[\s\S]*sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-11 truncate font-medium"/,
    "by-project rows should render the toggle inline before the session title so it never overlaps the label",
  );

  assert.doesNotMatch(
    source,
    /class="absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "by-project rows should not keep the circular overlay toggle that steals pointer input from the title",
  );
});
