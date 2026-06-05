import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session sidebar defines local collapse animation primitives", () => {
  assert.match(source, /const SIDEBAR_COLLAPSE_DURATION_MS = 160;/);
  assert.match(source, /const AnimatedCollapse = \(props: AnimatedCollapseProps\) =>/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /onTransitionEnd=\{handleTransitionEnd\}/);
});

test("workspace session sidebar uses a more visible project collapse profile", () => {
  assert.match(source, /const SIDEBAR_PROJECT_COLLAPSE_DURATION_MS = 240;/);
  assert.match(source, /const SIDEBAR_PROJECT_COLLAPSE_OFFSET_PX = 6;/);
  assert.match(
    source,
    /const sidebarCollapseDurationForRegion = \(region: AnimatedCollapseRegion\) =>\s*region === "project" \? SIDEBAR_PROJECT_COLLAPSE_DURATION_MS : SIDEBAR_COLLAPSE_DURATION_MS;/,
  );
  assert.match(
    source,
    /const sidebarCollapseClosedTransformForRegion = \(region: AnimatedCollapseRegion\) =>\s*`translateY\(-\$\{sidebarCollapseOffsetForRegion\(region\)\}px\)`;/,
  );
  assert.match(
    source,
    /sidebarCollapseDurationForRegion\(props\.region\) \+ 40/,
    "transition fallback should wait for the region-specific duration",
  );
});

test("workspace session sidebar collapse primitive guards lifecycle edge cases", () => {
  assert.match(source, /let previousOpen = props\.open;/);
  assert.match(source, /let hasMounted = false;/);
  assert.match(source, /if \(!hasMounted\) \{[\s\S]*hasMounted = true;[\s\S]*previousOpen = open;[\s\S]*return;/);
  assert.match(source, /if \(previousOpen === open\) return;/);
  assert.match(source, /const scheduleTransitionFallback = \(open: boolean\) =>/);
  assert.match(source, /sidebarCollapseDurationForRegion\(props\.region\) \+ 40/);
  assert.match(source, /if \(height <= 0\) \{[\s\S]*finishOpen\(\);[\s\S]*return;/);
  assert.match(source, /if \(height <= 0\) \{[\s\S]*finishClosed\(\);[\s\S]*return;/);
});

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
    /<div class="mb-3 flex flex-nowrap items-center gap-1">/,
    "sidebar controls should stay in a single row, even at minimum sidebar width",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.more_actions"\)\}/,
    "control row should keep add-directory-or-project before overflow actions",
  );

  assert.doesNotMatch(
    source,
    /<div class="mb-3 flex flex-nowrap items-center gap-1">[\s\S]*data-tooltip=\{tr\("sidebar\.new_chat"\)\}[\s\S]*data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}/,
    "top control row should not render a Chat button before add-directory-or-project",
  );

  assert.doesNotMatch(
    source,
    /const newSessionLabel = createMemo/,
    "new-session label helper should be removed with the top Chat button",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.more_actions"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.more_actions"\)\}<\/span>/,
    "overflow control should expose a tooltip and accessible label",
  );

  assert.doesNotMatch(
    source,
    /const naturalTopRailButtonClass =/,
    "dedicated top Chat button class should be removed with the control",
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

test("by-project sidebar renders private chats as a bottom section", () => {
  assert.match(source, /splitProjectGroupsForSidebar/);
  assert.match(source, /data-sidebar-chat-section="true"/);
  assert.match(source, /data-sidebar-chat-resize-handle="true"/);
  assert.match(source, /data-sidebar-chat-collapsed-resize-handle="true"/);
  assert.match(source, /cursor-ns-resize/);
  assert.match(source, /style=\{\{ cursor: "ns-resize" \}\}/);
  assert.match(source, /document\.documentElement\.style\.cursor = "ns-resize";/);
  assert.doesNotMatch(source, /cursor-row-resize/);
  assert.match(
    source,
    /data-sidebar-chat-collapsed="true"[\s\S]*class="mt-2 flex h-11 w-full shrink-0 items-center justify-between gap-2 border-t border-gray-6\/70 px-1\.5 pt-2"[\s\S]*class=\{`inline-flex h-8/,
    "collapsed Chats wrapper should reserve enough height for its h-8 controls",
  );
  assert.match(
    source,
    /data-sidebar-chat-collapsed="true"[\s\S]*data-tooltip=\{tr\("sidebar\.new_chat"\)\}[\s\S]*onClick=\{startQuickChatFromCollapsed\}[\s\S]*<Plus size=\{12\} \/>[\s\S]*<span>\{tr\("sidebar\.chat"\)\}<\/span>/,
    "collapsed Chats should expose a compact + Chat button",
  );
  assert.match(
    source,
    /data-sidebar-chat-expand-button="true"[\s\S]*data-sidebar-chat-collapsed-resize-handle="true"[\s\S]*onPointerDown=\{handleChatSidebarResizeStart\}[\s\S]*onClick=\{expandChatSidebar\}[\s\S]*<ChevronUp size=\{11\} \/>/,
    "collapsed Chats should keep a separate expand button on the right",
  );
  assert.doesNotMatch(
    source,
    /data-sidebar-chat-collapsed="true"[\s\S]*<span class="truncate">\{tr\("sidebar\.chats"\)\}<\/span>/,
    "collapsed Chats should not show the old Chats label in place of + Chat",
  );
  assert.match(
    source,
    /const startQuickChatFromCollapsed = \(\) => \{\s*applyResolvedChatSidebarResize\(compactChatSidebarHeight\(chatSidebarAvailableHeight\(\)\), false, true\);\s*startQuickChat\(\);\s*\};/,
    "collapsed + Chat should resize to compact height before creating a chat",
  );
  assert.match(source, /tr\("sidebar\.chats"\)/);
  assert.match(source, /tr\("sidebar\.new_chat"\)/);
  assert.match(source, /ChevronUp/);
  assert.match(source, /readChatSidebarHeight/);
  assert.match(source, /readChatSidebarCollapsed/);
  assert.match(source, /style=\{\{\s*height: `\$\{chatSidebarListHeight\(\)\}px`,\s*\}\}/);
  assert.match(source, /onClick=\{startQuickChat\}/);
  assert.doesNotMatch(
    source,
    /disabled=\{!props\.onQuickNewSession \|\| props\.newTaskDisabled\}/,
    "Chaty new-chat button should not be disabled by unrelated newTaskDisabled state",
  );
  assert.match(source, /const chatRows = \(\) => visibleProjectRowsForGroup\(chatGroup\(\)\);/);
  assert.match(source, /const canLoadMoreChatRows = \(\) => hasHiddenChatRows\(\) \|\| chatPaging\(\)\.hasMore;/);
  assert.match(source, /void loadMoreProjectRowsForGroup\(chatGroup\(\)\);/);
  assert.match(source, /resetProjectVisibleRowsForGroup\(chatGroup\(\)\)/);
  assert.match(source, /showWorkspaceMenu: false/);
});

test("project create-session actions use visible button chrome", () => {
  assert.match(
    source,
    /const projectCreateSessionButtonClass =[\s\S]*h-7 w-7[\s\S]*rounded-full[\s\S]*border border-gray-6[\s\S]*bg-gray-1[\s\S]*shadow-sm/,
    "project plus actions should use a shared button-like class",
  );
  assert.match(
    source,
    /class=\{projectCreateSessionButtonClass\}[\s\S]*aria-label=\{tr\("sidebar\.create_session_in_project"\)\}[\s\S]*<Plus size=\{14\} \/>/,
    "project plus actions should render as the shared button",
  );
  assert.equal(
    (source.match(/class=\{projectCreateSessionButtonClass\}/g) ?? []).length,
    2,
    "both project plus call sites should use the shared button class",
  );
  assert.doesNotMatch(
    source,
    /class="p-1 rounded-md text-gray-8 hover:text-gray-11 hover:bg-gray-3"[\s\S]*<Plus size=\{14\} \/>/,
    "project plus actions should not remain bare p-1 icon buttons",
  );
});
