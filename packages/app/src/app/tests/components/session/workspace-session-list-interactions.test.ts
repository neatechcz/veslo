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

test("project header click activates workspace while collapse stays on the folder icon", () => {
  assert.match(
    source,
    /const handleProjectOpenClick = \(projectKey: string, workspaceId: string\) => \{[\s\S]*void Promise\.resolve\(props\.onActivateWorkspace\(workspaceId, \{ origin: "workspace-session-list:project-open" \}\)\);[\s\S]*\};/,
    "project header should route clicks through workspace activation",
  );

  assert.match(
    source,
    /onClick=\{\(\) => handleProjectOpenClick\(project\.key, workspace\(\)\.id\)\}/,
    "project header button should activate its workspace",
  );

  assert.match(
    source,
    /<Folder[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*toggleProjectCollapse\(project\.key\);[\s\S]*\}\}/,
    "folder icon should remain the explicit collapse/expand target",
  );

  assert.doesNotMatch(
    source,
    /aria-label=\{project\.projectLabel \? `\$\{tr\("sidebar\.open_project"\)\} \$\{project\.projectLabel\}` : tr\("sidebar\.open_project"\)\}[\s\S]*onClick=\{\(\) => toggleProjectCollapse\(project\.key\)\}/,
    "open-project button must not be wired to collapse-only behavior",
  );
});

test("recent mode interactions stay wired to recentRowsVisible instead of chatProjectGroup", () => {
  const recentBranch = recentRenderBranch();

  assert.match(
    recentBranch,
    /renderSessionTreeRows\(\s*\(\) => recentRowsVisible\(\),\s*recentHasChildren,/s,
    "recent mode should render the recent row stream through the animated tree renderer",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionRowPress\(event, row, hasChildren\)\}/,
    "recent rows should keep the shared row-click behavior",
  );

  assert.doesNotMatch(
    recentBranch,
    /chatProjectGroup\(\)|data-sidebar-chat-section/,
    "recent mode should not reuse the by-project Chaty section for row interactions",
  );
});

test("Chaty owns quick-chat creation and resize/collapse interactions", () => {
  assert.match(
    source,
    /const startQuickChat = \(\) => \{[\s\S]*props\.onQuickNewSession\?\.\(\);[\s\S]*\};/,
    "Chaty should call the quick new-session action through a shared handler",
  );

  assert.match(
    source,
    /const handleChatSidebarResizeStart = \(event: PointerEvent\) => \{/,
    "Chaty should define a pointer-based resize start handler",
  );

  assert.match(
    source,
    /CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX/,
    "Chaty should use the collapse threshold as the drag baseline when expanding from a collapsed state",
  );

  assert.match(
    source,
    /wasCollapsed: boolean/,
    "Chaty resize state should remember whether the drag started from the collapsed row",
  );

  assert.match(
    source,
    /restoreHeight: number/,
    "Chaty resize state should keep the previous useful height for collapsed drag restore",
  );

  assert.match(
    source,
    /startHeight: wasCollapsed \? CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX : restoreHeight/,
    "collapsed Chaty drags should start from the collapsed threshold instead of jumping to the restored height",
  );

  assert.match(
    source,
    /data-sidebar-chat-collapsed-resize-handle="true"[\s\S]*onPointerDown=\{handleChatSidebarResizeStart\}/,
    "the collapsed Chaty row should also be wired as a drag handle",
  );

  assert.match(
    source,
    /resolveChatSidebarResize\(/,
    "Chaty resize should use the shared clamp/collapse helper",
  );

  assert.match(
    source,
    /window\.addEventListener\("pointermove", onPointerMove\);/,
    "Chaty resize should track pointer movement outside the handle",
  );

  assert.match(
    source,
    /writeChatSidebarHeight\(/,
    "Chaty should persist resized height",
  );

  assert.match(
    source,
    /writeChatSidebarCollapsed\(/,
    "Chaty should persist collapsed state",
  );
});

test("sidebar session list no longer persists archived visibility locally", () => {
  assert.doesNotMatch(
    source,
    /readShowArchivedSessions|writeShowArchivedSessions|SIDEBAR_SHOW_ARCHIVED_KEY/,
    "sidebar should no longer read or write archived visibility local-storage helpers",
  );

  assert.doesNotMatch(
    source,
    /showArchivedSessions\(\)|toggleShowArchived/,
    "sidebar should no longer expose show-archived signal or toggle helpers",
  );

  assert.match(
    source,
    /const shouldShowSessionRow = \(row: FlatSessionRow\) =>\s*!isSessionArchived\(row\.session\.id\);/,
    "sidebar rows should always hide archived sessions instead of toggling them inline",
  );
});

test("by-project mode wires project-group drag and drop reorder handlers", () => {
  assert.match(
    source,
    /const \[projectOrder, setProjectOrder\] = createSignal<string\[]>\(readProjectOrder\(\)\);/,
    "by-project mode should hydrate persisted project order into component state",
  );

  assert.match(
    source,
    /const orderedProjectGroups = createMemo\(\(\) => applyProjectOrder\((visibleProjectGroups|projectGroups)\(\), projectOrder\(\)\)\);/,
    "by-project mode should render from persisted project ordering",
  );

  assert.match(
    source,
    /const \[projectDropIndicator, setProjectDropIndicator\] = createSignal<ProjectDropIndicator \| null>\(null\);/,
    "by-project mode should track insertion-line state for precise drop feedback",
  );

  assert.match(
    source,
    /const handleProjectDragStart = \(event: DragEvent, projectKey: string\) => \{/,
    "project list should define a drag start handler",
  );

  assert.match(
    source,
    /const handleProjectDrop = \(event: DragEvent, targetKey: string\) => \{/,
    "project list should define a drop handler",
  );

  assert.match(
    source,
    /if \(sourceKey === normalizedTargetKey\) \{\s*clearProjectDragState\(\);\s*return;\s*\}/,
    "self-drop should be ignored before reordering state is mutated",
  );

  assert.match(
    source,
    /position = event\.clientY < rect\.top \+ rect\.height \/ 2 \? "before" : "after";/,
    "drag-over should compute whether insertion is before or after the hovered project row",
  );

  assert.match(
    source,
    /const reorderedVisibleKeys = reorderProjectKeys\(visibleKeys, sourceKey, targetKey, dropPosition\);/,
    "drop should pass explicit insertion position into project reorder logic",
  );
});

test("project rows expose drag lifecycle bindings without dedicated grip handle", () => {
  assert.doesNotMatch(
    source,
    /GripVertical/,
    "project rows should not render a dedicated six-dot grip icon",
  );

  assert.match(
    source,
    /<For each=\{normalProjectGroups\(\)\}>/,
    "by-project render should iterate through the normal project group list",
  );

  assert.match(
    source,
    /data-project-drag-preview[\s\S]*draggable/,
    "project drag preview wrapper should opt into native drag-and-drop",
  );

  assert.match(
    source,
    /data-project-drag-preview[\s\S]*onDragStart=\{\(event\) => handleProjectDragStart\(event, project\.key\)\}/,
    "project drag preview wrapper should start reordering with the project key",
  );

  assert.match(
    source,
    /onDragOver=\{\(event\) => handleProjectDragOver\(event, project\.key\)\}/,
    "project group container should register drag-over state per target key",
  );

  assert.match(
    source,
    /onDrop=\{\(event\) => handleProjectDrop\(event, project\.key\)\}/,
    "project group container should drop reordered project keys onto the current project",
  );

  assert.match(
    source,
    /onDragEnd=\{handleProjectDragEnd\}/,
    "project drag container should clear transient drag state at the end of the gesture",
  );

  assert.match(
    source,
    /onPointerDown=\{\(event\) => handleProjectPointerDown\(event, project\.key, projectDragLabel\(\)\)\}/,
    "project header should include pointer-based fallback drag start for webview environments with unreliable native drag",
  );

  assert.match(
    source,
    /const indicator = resolveProjectDropIndicatorFromPoint\(event\.clientX, event\.clientY, drag\.sourceKey\) \?\?\s*projectDropIndicator\(\);/,
    "pointer drag finish should resolve the drop target at pointerup so reorder still works if final move event is missed",
  );

  assert.match(
    source,
    /event\.dataTransfer\.setDragImage\(preview, offsetX, offsetY\);/,
    "drag start should provide a custom drag preview so users get immediate visual feedback",
  );

  assert.match(
    source,
    /data-project-drag-preview/,
    "project row should expose a dedicated preview source for drag image cloning",
  );

  assert.match(
    source,
    /data-project-drag-preview[\s\S]*<button[\s\S]*onPointerDown=\{\(event\) => handleProjectPointerDown\(event, project\.key, projectDragLabel\(\)\)\}[\s\S]*onClick=\{\(\) => handleProjectOpenClick\(project\.key, workspace\(\)\.id\)\}/,
    "project open button should stay clickable while drag behavior lives on the wrapper",
  );

  assert.match(
    source,
    /const suppressNextProjectClick = \(projectKey: string\) => \{[\s\S]*suppressedProjectClickKey = projectKey;[\s\S]*\};/,
    "pointer drag should suppress the next synthetic click so reorder does not also activate a workspace",
  );

  assert.match(
    source,
    /dropIndicatorPosition\(\) === "before"/,
    "project row should expose a top insertion divider when dropping before",
  );

  assert.match(
    source,
    /dropIndicatorPosition\(\) === "after"/,
    "project row should expose a bottom insertion divider when dropping after",
  );
});

test("clicking selected rows still opens session detail while selected parents toggle subagent expansion", () => {
  assert.match(
    source,
    /const action = resolveSessionRowClickAction\(\{\s*selectedSessionId: props\.selectedSessionId,\s*clickedSessionId: row\.session\.id,\s*hasChildren: hasChildren\(row\.session\.id\),\s*allowSelectedParentExpansion: props\.allowSelectedParentExpansion,\s*\}\);/s,
    "session row clicks should compute selected-row behavior through shared click action logic",
  );

  assert.match(
    source,
    /if \(action\.toggleExpandedParent\) \{\s*toggleExpandedParentSession\(row\.session\.id\);\s*\}/s,
    "selected parent rows should still toggle expansion when click action requests it",
  );

  assert.match(
    source,
    /if \(action\.openSession\) \{\s*props\.onOpenSession\(row\.workspace\.id, row\.session\.id\);\s*\}/s,
    "session rows should still open the clicked session whenever click action marks it as openable",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionRowPress\(event, row, hasChildren\)\}/,
    "session rows should route click behavior through the selected-row-aware handler",
  );
});

test("parent sessions keep row-click expansion without a dedicated branch toggle button", () => {
  assert.doesNotMatch(
    source,
    /import \{[\s\S]*ChevronDown,[\s\S]*ChevronRight,[\s\S]*\} from "lucide-solid";/,
    "session list should not import chevron icons for a removed branch toggle",
  );

  assert.doesNotMatch(
    source,
    /const handleSessionExpandToggle = \(event: MouseEvent, sessionId: string\) => \{/,
    "session list should not define a dedicated branch-toggle handler once the button is removed",
  );

  assert.doesNotMatch(
    source,
    /const sessionBranchToggleLabel = \(sessionId: string\) =>\s*isParentExpanded\(sessionId\) \? tr\("sidebar\.collapse_session_branch"\) : tr\("sidebar\.expand_session_branch"\);/,
    "session list should not keep toggle-only accessibility labels after removing the control",
  );

  assert.doesNotMatch(
    source,
    /const sessionBranchToggle = \(sessionId: string, hasChildren: boolean\) =>/,
    "session list should not define a shared branch toggle renderer",
  );

  const toggleCallBindings = source.match(/sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)/g) ?? [];
  assert.equal(toggleCallBindings.length, 0, "session rows should not invoke a removed branch toggle renderer");
});

test("workspace-session-list.tsx no longer derives branch expansion from selectedSessionId", () => {
  assert.doesNotMatch(
    source,
    /createEffect\(\(\) => \{[\s\S]*props\.selectedSessionId[\s\S]*deriveExpandedParentSessionIds/s,
    "implementation should not auto-derive expanded parents from selectedSessionId",
  );

  assert.doesNotMatch(
    source,
    /setExpandedParentSessionIds\(\(current\) => deriveExpandedParentSessionIds\(/,
    "explicit mini-toggle is the only allowed branch expansion path",
  );
});

test("expanded parent session persistence reads at startup and writes only from row toggles", () => {
  assert.match(
    source,
    /readExpandedParentSessionIds,\s*readProjectOrder,/,
    "session branch expansion state should be initialized from sidebar preferences",
  );

  assert.match(
    source,
    /const \[expandedParentSessionIds, setExpandedParentSessionIds\] = createSignal<Set<string>>\(\s*readExpandedParentSessionIds\(\),\s*\);/s,
    "expanded parent sessions should survive app restart",
  );

  assert.match(
    source,
    /const toggleExpandedParentSession = \(sessionId: string\) =>\s*setExpandedParentSessionIds\(\(current\) => \{[\s\S]*writeExpandedParentSessionIds\(next\);[\s\S]*return next;\s*\}\);/s,
    "expanded parent session state should persist when a user toggles a session branch",
  );

  const effectBlocks = Array.from(source.matchAll(/createEffect\(\(\) => \{[\s\S]*?\n  \}\);/g)).map(
    (match) => match[0],
  );
  assert.equal(
    effectBlocks.some((block) => /writeExpandedParentSessionIds\(/.test(block)),
    false,
    "startup/effect paths must not overwrite persisted session branch preferences",
  );
});

test("session label span exposes full title tooltip and renders colored subagent prefix with session description", () => {
  assert.match(
    source,
    /title=\{sessionLabelTitle\(row\)\}/,
    "session title tooltip should expose full name/label on hover",
  );

  assert.match(
    source,
    /sessionSidebarTitle\(row, tr\("session\.chat_label"\)\)/,
    "session labels should use chat fallback titles for private rows before splitting subagent decoration",
  );

  assert.doesNotMatch(
    source,
    /splitSessionDisplayLabel\(row\.session\.title, decorated\)/,
    "session labels should not read raw session titles directly because private chat rows need a Chat fallback",
  );

  assert.match(
    source,
    /style=\{labelColor\(\) \? \{ color: labelColor\(\) \} : undefined\}/,
    "decorated subagent prefix should apply persisted color styling",
  );

  assert.match(
    source,
    /` · \$\{description\(\)\}`/,
    "decorated rows should continue with the original sub-session description",
  );
});

test("session and subagent branches render through animated branch containers", () => {
  assert.match(source, /const AnimatedSessionBranch = \(props: AnimatedSessionBranchProps\) =>/);
  assert.match(source, /data-sidebar-collapse-region=\{props\.region\}/);
  assert.match(source, /rows: Accessor<FlatSessionRow\[]>;/);
  assert.match(source, /descendantRowsForParent\(props\.rows\(\), row\.session\.id\)/);
  assert.match(source, /directChildRowsForParent\(props\.rows\(\), props\.parentSessionId\)/);
  assert.match(source, /setRenderedRows\(rows\);/);
});

test("recent and by-project session lists use accessor-backed animated session tree rendering", () => {
  assert.match(source, /renderSessionTreeRows\(\s*\(\) => recentRowsVisible\(\),/s);
  assert.match(source, /renderSessionTreeRows\(\s*\(\) => visibleRows\(\),/s);
  assert.match(source, /renderSessionTreeRows\(\s*\(\) => chatRows\(\),/s);
  assert.doesNotMatch(
    source,
    /renderSessionTreeRows\(\s*(?:recentRowsVisible|visibleRows|chatRows)\(\),/s,
    "session tree renderers should receive row accessors so closing branches keep their previous content",
  );
});

test("by-project project contents use the animated project collapse region", () => {
  assert.match(
    source,
    /<AnimatedCollapse\s+open=\{!collapsed\(\)\}\s+region="project"[\s\S]*innerClass="pl-5 pt-0\.5 space-y-0"/,
  );

  assert.doesNotMatch(
    source,
    /<Show when=\{!collapsed\(\)\}>\s*<div class="pl-5 pt-0\.5 space-y-0">/,
    "project collapse should not instantly unmount project rows",
  );
});

test("animated session branch rendering keeps parent row click behavior and archive wiring shared", () => {
  assert.match(
    source,
    /renderSingleSessionRow\(row, hasChildren, options\)/,
    "tree renderer should render parent rows through the shared row component",
  );

  assert.match(
    source,
    /open=\{expandedParentSessionIds\(\)\.has\(row\.session\.id\)\}/,
    "animated branches should still read explicit persisted parent expansion state",
  );

  assert.doesNotMatch(
    source,
    /const handleSessionExpandToggle = \(event: MouseEvent, sessionId: string\) => \{/,
    "animated branch wiring must not reintroduce a dedicated session branch toggle",
  );
});

test("collapsed project persistence writes only from explicit user toggles", () => {
  assert.match(
    source,
    /const toggleProjectCollapse = \(projectKey: string\) =>\s*setCollapsedProjects\(\(previous\) => \{\s*const next = toggleProjectCollapsed\(previous, projectKey\);\s*writeCollapsedProjectMap\(next\);\s*return next;\s*\}\);/s,
    "collapsed project state should persist when user toggles a project header",
  );

  const effectBlocks = Array.from(source.matchAll(/createEffect\(\(\) => \{[\s\S]*?\n  \}\);/g)).map(
    (match) => match[0],
  );
  assert.equal(
    effectBlocks.some((block) => /writeCollapsedProjectMap\(/.test(block)),
    false,
    "startup/effect paths must not overwrite persisted collapse preferences",
  );
});

test("session rows use archive action and open submenu on right-click", () => {
  assert.match(
    source,
    /const handleSessionRowContextMenu = \(\s*event: MouseEvent,\s*workspaceId: string,\s*anchorKey: string,\s*\) => \{/,
    "session list should define a dedicated right-click handler for session rows",
  );

  assert.match(
    source,
    /setWorkspaceMenuTarget\(\{\s*workspaceId,\s*anchorKey,\s*source: ["']session["'],\s*x: event\.clientX,\s*y: event\.clientY,?\s*\}\);/,
    "right-clicking a session row should mark the workspace menu as session-originated",
  );

  assert.match(
    source,
    /onContextMenu=\{\(event\) => handleSessionRowContextMenu\(event, workspace\(\)\.id, anchorKey\)\}/,
    "recent session rows should open submenu from right-click",
  );

  assert.match(
    source,
    /onContextMenu=\{\(event\) => \{\s*if \(!showWorkspaceMenu\) return;\s*handleSessionRowContextMenu\(event, row\.workspace\.id, options\.anchorKey\);\s*\}\}/s,
    "by-project session rows should open submenu from right-click through the shared row renderer",
  );

  assert.match(
    source,
    /archivedSessionIds\?: string\[\];/,
    "session list should accept archived session ids from callers instead of local persistence",
  );

  assert.match(
    source,
    /onArchiveSession\?: \(workspaceId: string, sessionId: string\) => Promise<void> \| void;/,
    "session list should accept an archive callback from callers",
  );

  assert.match(
    source,
    /onUnarchiveSession\?: \(workspaceId: string, sessionId: string\) => Promise<void> \| void;/,
    "session list should accept an unarchive callback from callers",
  );

  assert.match(
    source,
    /<Show when=\{target\(\)\.source !== ["']session["']\}>[\s\S]*tr\(["']sidebar\.remove_workspace["']\)[\s\S]*<\/Show>/,
    "session-originated menus should not render the destructive remove-workspace action",
  );

  assert.match(
    source,
    /const \[pendingArchiveConfirmationSessionId, setPendingArchiveConfirmationSessionId\] = createSignal<string \| null>\(/,
    "session list should still track pending archive confirmation per session id",
  );

  assert.doesNotMatch(
    source,
    /readArchivedSessionIds\(/,
    "session list should no longer read archived ids from local storage",
  );

  assert.doesNotMatch(
    source,
    /writeArchivedSessionIds\(/,
    "session list should no longer write archived ids to local storage",
  );

  assert.match(
    source,
    /const archivedSessionIds = \(\) => props\.archivedSessionIds\s*\?\? \[\];/,
    "archived session ids should come from caller props",
  );

  assert.match(
    source,
    /const handleSessionArchiveAction = async \(event: MouseEvent, sessionId: string\) => \{/,
    "archive actions should be async so they can call caller-provided handlers",
  );

  assert.match(
    source,
    /if \(archived\) \{\s*await Promise\.resolve\(props\.onUnarchiveSession\?\.\(workspaceId, id\)\);\s*return;\s*\}/s,
    "archived sessions should route unarchive through the caller callback",
  );

  assert.match(
    source,
    /await Promise\.resolve\(props\.onArchiveSession\?\.\(workspaceId, id\)\);/,
    "archive confirmation should call the caller archive callback",
  );

  assert.match(
    source,
    /const workspaceId = group\.workspace\.id;/,
    "archive actions should preserve the workspace id when invoking caller callbacks",
  );

  assert.match(
    source,
    /if \(archived\) \{\s*await Promise\.resolve\(props\.onUnarchiveSession\?\.\(workspaceId, id\)\);\s*return;\s*\}[\s\S]*if \(!isArchiveConfirmationPending\(id\)\) \{[\s\S]*setPendingArchiveConfirmationSessionId\(id\);\s*return;\s*\}/s,
    "first click on a non-archived session should only arm inline confirmation, while archived sessions unarchive immediately",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, session\(\)\.id\)\}/,
    "recent session rows should route hover action through two-step archive confirmation and caller callbacks",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, row\.session\.id\)\}/,
    "by-project session rows should route hover action through two-step archive confirmation and caller callbacks",
  );

  assert.match(
    source,
    /useOutsideClick\(\s*\(\) => Boolean\(pendingArchiveConfirmationSessionId\(\)\),\s*\(\) => pendingArchiveConfirmButtonRef,\s*\(\) => setPendingArchiveConfirmationSessionId\(null\),\s*\);/s,
    "pending archive confirmation should cancel when clicking outside the inline confirm button",
  );

  assert.match(
    source,
    /tr\("sidebar\.archive_confirm"\)/,
    "inline archive confirmation should use localized confirm label",
  );
});

test("workspace context menu is fixed and viewport clamped so scroll containers cannot clip it", () => {
  assert.match(
    source,
    /type WorkspaceMenuTarget = \{[\s\S]*x: number;[\s\S]*y: number;[\s\S]*\};/,
    "workspace menu state should store viewport click coordinates instead of relying on row-relative placement",
  );

  assert.match(
    source,
    /setWorkspaceMenuTarget\(\{\s*workspaceId,\s*anchorKey,\s*source: ["']session["'],\s*x: event\.clientX,\s*y: event\.clientY,?\s*\}\);/,
    "right-clicked session rows should open the menu at the pointer coordinates",
  );

  assert.match(
    source,
    /const workspaceMenuStyle = createMemo\(\(\) => \{[\s\S]*Math\.min\(Math\.max\(VIEWPORT_PADDING, target\.x\), maxX\)[\s\S]*Math\.min\(Math\.max\(VIEWPORT_PADDING, target\.y\), maxY\)/,
    "workspace menu should clamp both axes inside the viewport",
  );

  assert.match(
    source,
    /data-testid=["']session-workspace-context-menu["'][\s\S]*class=["']fixed z-\[100\]/,
    "workspace menu should render as a fixed top-priority layer",
  );

  assert.doesNotMatch(
    source,
    /class=["']absolute right-0 top-\[calc\(100%\+4px\)\] z-20/,
    "workspace menu must not be row-absolute inside the scrollable sidebar",
  );
});

test("archive action stores clicked button as pending confirm target before arming confirmation", () => {
  assert.match(
    source,
    /if \(!isArchiveConfirmationPending\(id\)\) \{\s*if \(event\.currentTarget instanceof HTMLButtonElement\) \{\s*pendingArchiveConfirmButtonRef = event\.currentTarget;\s*\}\s*setPendingArchiveConfirmationSessionId\(id\);\s*return;\s*\}/s,
    "first archive click should capture button target before pending mode, so outside-click cancellation does not clear confirm click",
  );
});
