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
    /data-tooltip=\{tr\("sidebar\.new_session"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.more_actions"\)\}/,
    "control row should keep new, add-directory-or-project, and overflow actions in order",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.more_actions"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.more_actions"\)\}<\/span>/,
    "overflow control should expose a tooltip and accessible label",
  );

  assert.match(
    source,
    /<div class="relative shrink-0" ref=\{\(el\) => \(addWorkspaceMenuRef = el\)\}>[\s\S]*data-tooltip=\{tr\("sidebar\.new_session"\)\}/,
    "new-session wrapper should shrink to content width instead of stretching across the rail",
  );

  assert.match(
    source,
    /const naturalTopRailButtonClass =[\s\S]*h-8[\s\S]*rounded-full[\s\S]*px-2/,
    "new-session should use a dedicated content-width button class",
  );

  assert.match(
    source,
    /<div[\s\S]*class="relative shrink-0"[\s\S]*data-tooltip=\{tr\("sidebar\.more_actions"\)\}/,
    "overflow control wrapper should shrink to its compact circular size instead of taking a third of the rail",
  );

  assert.match(
    source,
    /const compactTopRailButtonClass =[\s\S]*h-8 w-8[\s\S]*rounded-full/,
    "overflow control should use a dedicated compact circular button class",
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
    /<div class="flex min-w-0 flex-1">[\s\S]*data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*<FolderPlus size=\{18\} \/>/,
    "add-directory CTA should stay as the expanding middle control and use a larger folder icon",
  );

  assert.match(
    source,
    /<Plus size=\{12\} \/>[\s\S]*<FolderPlus size=\{18\} \/>/,
    "add-directory icon should be visibly larger than the new-session plus icon",
  );

  assert.match(
    source,
    /MoreHorizontal/,
    "workspace session list should import and render the overflow icon",
  );

  assert.match(
    source,
    /onAddDirectorySession/,
    "workspace session list should expose a dedicated callback for picker-driven directory sessions",
  );

  assert.doesNotMatch(
    source,
    /data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*disabled=\{!props\.onAddDirectorySession \|\| props\.newTaskDisabled\}/,
    "add-directory-or-project should stay clickable during browsing-mode boot when no client exists",
  );

  assert.doesNotMatch(
    source,
    /data-tooltip=\{tr\("sidebar\.show_archived"\)\}/,
    "show archived should no longer be a top-level control",
  );
});

test("by-project rows keep the title wrapper without a branch toggle button", () => {
  assert.match(
    source,
    /<span class="relative min-w-0 flex-1">/,
    "by-project rows should keep the title/content wrapper around the label",
  );

  assert.match(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-12 truncate"/,
    "by-project rows should keep the title line structure after removing the dedicated toggle",
  );

  assert.doesNotMatch(
    source,
    /sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)/,
    "by-project rows should not render a shared branch toggle helper",
  );

  assert.doesNotMatch(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-11 truncate font-medium"/,
    "by-project row titles should no longer force a medium font weight",
  );

  assert.doesNotMatch(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-11 truncate"/,
    "by-project row titles should no longer use the muted gray-11 text tone",
  );

  assert.doesNotMatch(
    source,
    /class="pointer-events-none absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2"[\s\S]*class="pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded-\[4px\] text-gray-9 transition-colors hover:bg-gray-4\/70 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "by-project rows should not render the under-title square toggle button",
  );

  assert.doesNotMatch(
    source,
    /class="absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "by-project rows should not keep the circular overlay toggle that steals pointer input from the title",
  );
});
