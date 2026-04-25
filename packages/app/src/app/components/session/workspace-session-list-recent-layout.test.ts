import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("recent rows reserve right space for timestamp/menu to avoid title overlap", () => {
  assert.match(
    source,
    /class=\{`w-full [^`]*flex items-center rounded-xl px-3 py-1 pr-12 text-left transition-colors [^`]*\$\{/,
    "recent rows should reserve a right column so timestamp and menu never overlap labels",
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
    /class=\{`w-full [^`]*flex items-center gap-2 rounded-xl px-3 py-1 pr-12 text-left transition-colors [^`]*\$\{/,
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
    /title=\{formatSessionTimestampTooltip\(displayTimestamp\(session\(\)\), currentLocale\(\)\)\}/,
    "by-project row timestamp should expose exact datetime in tooltip",
  );

  assert.doesNotMatch(source, /class=\{`w-full flex items-center gap-2 rounded-xl px-3 py-1\.5 text-left transition-colors \$\{/);
});

test("session hover action uses archive icon instead of three dots", () => {
  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, session\(\)\.id\)\}/,
    "recent rows should wire hover action to the archive confirmation flow",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, row\.session\.id\)\}/,
    "by-project rows should wire hover action to the archive confirmation flow",
  );

  assert.match(
    source,
    /aria-label=\{archiveConfirmationPending\(\)\s*\?\s*tr\("sidebar\.archive_confirm"\)\s*:\s*isSessionArchived\(session\(\)\.id\)\s*\?\s*tr\("sidebar\.unarchive_session"\)\s*:\s*tr\("sidebar\.archive_session"\)\}/,
    "recent row action should expose localized confirm/archive/unarchive accessibility labels",
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
