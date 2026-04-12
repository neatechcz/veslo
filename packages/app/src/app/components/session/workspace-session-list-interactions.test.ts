import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("project header click toggles collapse and does not activate workspace", () => {
  assert.match(
    source,
    /onClick=\{\(\) => toggleProjectCollapse\(project\.key\)\}/,
    "project header should toggle collapse/expand on click",
  );

  assert.doesNotMatch(
    source,
    /void Promise\.resolve\(props\.onActivateWorkspace\(workspace\(\)\.id\)\);/,
    "project header interaction must not trigger workspace activation",
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
    /<For each=\{renderProjectGroups\(\)\}>/,
    "by-project render should iterate through the renderable project group list",
  );

  assert.match(
    source,
    /draggable/,
    "project header should opt into native drag-and-drop",
  );

  assert.match(
    source,
    /onDragStart=\{\(event\) => handleProjectDragStart\(event, project\.key\)\}/,
    "project header should start reordering with the project key",
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
    "project header should clear transient drag state at the end of the gesture",
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
    /const action = resolveSessionRowClickAction\(\{\s*selectedSessionId: props\.selectedSessionId,\s*clickedSessionId: row\.session\.id,\s*hasChildren: hasChildren\(row\.session\.id\),\s*\}\);/s,
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
    /onClick=\{\(\) => handleSessionRowClick\(row, hasChildren\)\}/,
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

test("session label span exposes full title tooltip and renders colored subagent prefix with session description", () => {
  assert.match(
    source,
    /title=\{sessionLabelTitle\(row\)\}/,
    "session title tooltip should expose full name/label on hover",
  );

  assert.match(
    source,
    /splitSessionDisplayLabel\(row\.session\.title, decorated\)/,
    "session labels should split subagent name from raw session description",
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

test("collapsed project persistence writes only from explicit user toggles", () => {
  assert.match(
    source,
    /const toggleProjectCollapse = \(projectKey: string\) =>\s*setCollapsedProjects\(\(previous\) => \{\s*const next = toggleProjectCollapsed\(previous, projectKey\);\s*writeCollapsedProjectMap\(next\);\s*return next;\s*\}\);/s,
    "collapsed project state should persist when user toggles a project header",
  );

  assert.doesNotMatch(
    source,
    /createEffect\(\(\) => \{[\s\S]*writeCollapsedProjectMap\(/,
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
    /onContextMenu=\{\(event\) => handleSessionRowContextMenu\(event, workspace\(\)\.id, anchorKey\)\}/,
    "recent session rows should open submenu from right-click",
  );

  assert.match(
    source,
    /onContextMenu=\{\(event\) => handleSessionRowContextMenu\(event, row\.workspace\.id, rowAnchorKey\)\}/,
    "by-project session rows should open submenu from right-click",
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
    /pendingArchiveConfirmButtonRef\.contains\(target\)[\s\S]*window\.addEventListener\("pointerdown", cancelPendingArchive\);/,
    "pending archive confirmation should cancel when clicking outside the inline confirm button",
  );

  assert.match(
    source,
    /tr\("sidebar\.archive_confirm"\)/,
    "inline archive confirmation should use localized confirm label",
  );
});

test("archive action stores clicked button as pending confirm target before arming confirmation", () => {
  assert.match(
    source,
    /if \(!isArchiveConfirmationPending\(id\)\) \{\s*if \(event\.currentTarget instanceof HTMLButtonElement\) \{\s*pendingArchiveConfirmButtonRef = event\.currentTarget;\s*\}\s*setPendingArchiveConfirmationSessionId\(id\);\s*return;\s*\}/s,
    "first archive click should capture button target before pending mode, so outside-click cancellation does not clear confirm click",
  );
});
