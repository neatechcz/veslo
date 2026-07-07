import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/workspace-session-list.tsx", import.meta.url), "utf8");

const recentRenderBranch = () => {
  const fallbackIndex = source.indexOf('<Show when={sidebarMode() === "by-project"} fallback={');
  const byProjectBranchIndex = source.indexOf("<For each={normalProjectGroups()}>", fallbackIndex);

  assert.notEqual(fallbackIndex, -1, "recent-mode render branch should exist");
  assert.notEqual(byProjectBranchIndex, -1, "by-project render branch should exist after recent fallback");
  return source.slice(fallbackIndex, byProjectBranchIndex);
};

test("recent rows reserve right space for timestamp/menu to avoid title overlap", () => {
  assert.match(
    source,
    /class=\{sessionRowClass\(isSelected\(\), "pr-12"\)\}/,
    "recent rows should reserve a right column so timestamp and menu never overlap labels",
  );
});

test("recent mode renders from recentRowsVisible without using the chat project group", () => {
  const recentBranch = recentRenderBranch();

  assert.match(
    recentBranch,
    /renderSessionTreeRows\(\(\) => recentRowsVisible\(\), recentHasChildren, \{\s*variant: "recent",\s*\}\)/,
    "recent mode should continue rendering the single activity-sorted recent row stream",
  );

  assert.doesNotMatch(
    recentBranch,
    /chatProjectGroup\(\)|data-sidebar-chat-section/,
    "recent mode should not render through the by-project Chaty section path",
  );
});

test("recent mode falls back to visible empty local workspaces", () => {
  const recentBranch = recentRenderBranch();

  assert.match(
    source,
    /const recentFallbackProjectGroups = createMemo\(\(\) =>/,
    "recent mode should derive a fallback list from visible empty local workspace groups",
  );

  assert.match(
    source,
    /: recentRowsTreeVisible\(\)\.length > 0 \|\| recentFallbackProjectGroups\(\)\.length > 0/,
    "recent mode should treat visible empty local workspaces as sidebar content",
  );

  assert.match(
    recentBranch,
    /<Show when=\{recentRowsVisible\(\)\.length === 0\}>[\s\S]*<For each=\{recentFallbackProjectGroups\(\)\}>/,
    "recent mode should render empty local workspaces when no recent rows remain visible",
  );
});

test("recent show-less memo reads its baseline only after the helper is declared", () => {
  const showLessMemoIndex = source.indexOf("const recentCanShowLess = createMemo(() =>");
  const baselineHelperIndex = source.indexOf("const initialRecentVisibleCount = () =>");

  assert.notEqual(showLessMemoIndex, -1, "recent show-less memo should exist");
  assert.notEqual(baselineHelperIndex, -1, "recent visible baseline helper should exist");
  assert.ok(
    baselineHelperIndex < showLessMemoIndex,
    "recent show-less memo must not read initialRecentVisibleCount before its declaration",
  );
});

test("recent rows keep timestamp on the right and replace it with menu trigger on hover", () => {
  assert.match(
    source,
    /class=\{`pointer-events-none absolute right-2 bottom-1 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity \$\{[\s\S]*sessionHoverActionsSuspended\(\)[\s\S]*group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0/,
    "timestamp should be pinned to the metadata baseline (bottom) and disappear on row hover/focus",
  );

  assert.match(
    source,
    /class=\{`absolute right-2 bottom-1 transition-opacity \$\{/,
    "row should expose a menu trigger exactly where timestamp disappears on hover",
  );

  assert.match(
    source,
    /title=\{formatSessionTimestampTooltip\(displayTimestamp\(session\(\)\), __vesloCurrentLocale\(\)\)\}/,
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
    /fallback=\{\s*<>\s*<div class="space-y-0">[\s\S]*renderSessionTreeRows\(\(\) => recentRowsVisible\(\), recentHasChildren/,
    "recent-mode session rows should use a zero-gap stack",
  );

  assert.match(
    source,
    /innerClass="pl-5 pt-0\.5 space-y-0"/,
    "project session rows should use the same zero-gap stack",
  );
});

test("by-project session rows reserve right space and swap time for three-dot menu on hover", () => {
  assert.match(
    source,
    /class=\{sessionRowClass\(isSelected\(\), "gap-2 pr-12"\)\}/,
    "by-project rows should reserve a right column so timestamp and menu never overlap labels",
  );

  assert.match(
    source,
    /class=\{`pointer-events-none absolute right-2 top-1\/2 -translate-y-1\/2 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity \$\{[\s\S]*sessionHoverActionsSuspended\(\)[\s\S]*group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0/,
    "by-project rows should show right-aligned time that disappears on hover/focus",
  );

  assert.match(
    source,
    /class=\{`absolute right-2 top-1\/2 -translate-y-1\/2 transition-opacity \$\{/,
    "by-project rows should show a row action trigger in place of time on hover/focus",
  );

  assert.match(
    source,
    /title=\{formatSessionTimestampTooltip\(displayTimestamp\(session\(\)\), __vesloCurrentLocale\(\)\)\}/,
    "by-project row timestamp should expose exact datetime in tooltip",
  );

  assert.doesNotMatch(source, /class=\{`w-full flex items-center gap-2 rounded-xl px-3 py-1\.5 text-left transition-colors \$\{/);
});

test("session hover action uses archive icon instead of three dots", () => {
  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, workspace\(\)\.id, session\(\)\.id\)\}/,
    "recent rows should wire hover action to the archive confirmation flow",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, row\.workspace\.id, row\.session\.id\)\}/,
    "by-project rows should wire hover action to the archive confirmation flow",
  );

  assert.match(
    source,
    /aria-label=\{archiveConfirmationPending\(\)\s*\?\s*tr\("sidebar\.archive_confirm"\)\s*:\s*isSessionArchived\(workspace\(\)\.id, session\(\)\.id\)\s*\?\s*tr\("sidebar\.unarchive_session"\)\s*:\s*tr\("sidebar\.archive_session"\)\}/,
    "recent row action should expose localized confirm/archive/unarchive accessibility labels",
  );

  assert.match(
    source,
    /const archiveActionTestId = \(workspaceId: string, sessionId: string\) =>[\s\S]*"session-sidebar-archive-confirm-button"[\s\S]*"session-sidebar-unarchive-button"[\s\S]*"session-sidebar-archive-button"/,
    "archive action should expose stable test ids for archive, confirm, and unarchive states",
  );

  assert.match(
    source,
    /data-testid=\{archiveActionTestId\(workspace\(\)\.id, session\(\)\.id\)\}[\s\S]*data-session-id=\{session\(\)\.id\}[\s\S]*data-workspace-id=\{workspace\(\)\.id\}/,
    "recent row archive action should expose stable test selectors and scope attributes",
  );

  assert.match(
    source,
    /data-testid=\{archiveActionTestId\(row\.workspace\.id, row\.session\.id\)\}[\s\S]*data-session-id=\{row\.session\.id\}[\s\S]*data-workspace-id=\{row\.workspace\.id\}/,
    "by-project row archive action should expose stable test selectors and scope attributes",
  );

  assert.match(
    source,
    /<Show when=\{archiveConfirmationPending\(\)\} fallback=\{<Archive size=\{14\} \/>\}>\s*\{tr\("sidebar\.archive_confirm"\)\}/,
    "archive action should switch to localized inline confirm text before final archive",
  );

  assert.doesNotMatch(
    source,
    /readArchivedSessionIds\(/,
    "recent rows should not depend on local archived-id storage",
  );

  assert.doesNotMatch(
    source,
    /writeArchivedSessionIds\(/,
    "recent rows should not persist archived ids to local storage",
  );
});

test("session hover archive action stays hidden while another session is pending load", () => {
  assert.match(
    source,
    /const sessionHoverActionsSuspended = createMemo\(\(\) => Boolean\(props\.pendingSelectedSessionId\?\.trim\(\)\)\);/,
    "session list should derive a hover-action suspension flag from the pending selected session",
  );

  assert.match(
    source,
    /sessionHoverActionsSuspended\(\)\s*\?\s*""\s*:\s*"group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0"/,
    "timestamps should not disappear under a stationary cursor while session loading is pending",
  );

  assert.match(
    source,
    /sessionHoverActionsSuspended\(\)\s*\?\s*"pointer-events-none opacity-0"\s*:\s*"opacity-0 group-hover\/session-row:opacity-100 group-focus-within\/session-row:opacity-100"/,
    "archive hover actions should stay hidden and non-interactive while session loading is pending",
  );
});

test("recent rows keep metadata tucked closer to the title line without a branch toggle button", () => {
  assert.match(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-12 truncate"[\s\S]*<span class="mt-px flex items-center gap-1 text-\[11px\] text-gray-10 min-w-0">/s,
    "recent rows should keep the label and metadata stack tight even after removing the branch toggle button",
  );

  assert.doesNotMatch(
    source,
    /sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)/,
    "recent rows should not render a dedicated branch toggle helper",
  );

  assert.doesNotMatch(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-11 truncate font-medium"[\s\S]*<span class="mt-px flex items-center gap-1 text-\[11px\] text-gray-10 min-w-0">/s,
    "recent row titles should no longer force a medium font weight",
  );

  assert.doesNotMatch(
    source,
    /<span class="relative min-w-0 flex-1">[\s\S]*<span class="flex items-center gap-1\.5 min-w-0">[\s\S]*<span[\s\S]*class="text-\[13px\] text-gray-11 truncate"[\s\S]*<span class="mt-px flex items-center gap-1 text-\[11px\] text-gray-10 min-w-0">/s,
    "recent row titles should no longer use the muted gray-11 text tone",
  );

  assert.doesNotMatch(
    source,
    /class="pointer-events-none absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2"[\s\S]*class="pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded-\[4px\] text-gray-9 transition-colors hover:bg-gray-4\/70 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "recent rows should not keep the under-title square toggle button",
  );

  assert.match(
    source,
    /<span class="mt-px flex items-center gap-1 text-\[11px\] text-gray-10 min-w-0">/,
    "recent rows should keep the metadata line visually tighter to the title",
  );

  assert.match(
    source,
    /class=\{`pointer-events-none absolute right-2 bottom-1 text-\[11px\] text-gray-9 whitespace-nowrap transition-opacity \$\{[\s\S]*sessionHoverActionsSuspended\(\)[\s\S]*group-hover\/session-row:opacity-0 group-focus-within\/session-row:opacity-0/,
    "recent row timestamp should sit slightly tighter to the row bottom edge",
  );

  assert.match(
    source,
    /class=\{`absolute right-2 bottom-1 transition-opacity \$\{/,
    "recent row menu trigger should replace the timestamp in the tighter bottom position",
  );

  assert.doesNotMatch(
    source,
    /class="absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "recent rows should not keep the centered overlay toggle that blocks clicks on the title text",
  );
});
