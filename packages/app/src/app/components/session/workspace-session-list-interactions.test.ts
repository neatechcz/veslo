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
    /<For each=\{orderedProjectGroups\(\)\}>/,
    "by-project render should iterate through the ordered project group list",
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

test("parent sessions expose a mini under-title branch toggle that only expands/collapses", () => {
  assert.match(
    source,
    /import \{[\s\S]*ChevronDown,[\s\S]*ChevronRight,[\s\S]*\} from "lucide-solid";/,
    "session list should import chevron icons for the branch toggle",
  );

  assert.match(
    source,
    /const handleSessionExpandToggle = \(event: MouseEvent, sessionId: string\) => \{/,
    "session list should define a dedicated branch-toggle handler",
  );

  assert.match(
    source,
    /event\.stopPropagation\(\);\s*const normalizedId = sessionId\.trim\(\);[\s\S]*toggleExpandedParentSession\(normalizedId\);/s,
    "branch toggle handler should stop row click bubbling and only toggle expansion",
  );

  assert.match(
    source,
    /const sessionBranchToggleLabel = \(sessionId: string\) =>\s*isParentExpanded\(sessionId\) \? tr\("sidebar\.collapse_session_branch"\) : tr\("sidebar\.expand_session_branch"\);/,
    "toggle control should expose localized expand/collapse labels",
  );

  assert.match(
    source,
    /const sessionBranchToggle = \(sessionId: string, hasChildren: boolean\) =>/,
    "session list should define a shared branch toggle renderer",
  );

  assert.match(
    source,
    /<Show when=\{isParentExpanded\(sessionId\)\} fallback=\{<ChevronRight size=\{12\} \/>}>[\s\S]*<ChevronDown size=\{12\} \/>[\s\S]*<\/Show>/s,
    "toggle control should swap chevrons based on branch expansion state",
  );

  assert.match(
    source,
    /class="pointer-events-none absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2"[\s\S]*class="pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded-\[4px\] text-gray-9 transition-colors hover:bg-gray-4\/70 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "toggle control should stay under the title but limit pointer input to a compact square hitbox",
  );

  assert.doesNotMatch(
    source,
    /class="absolute left-1\/2 top-\[1\.375rem\] -translate-x-1\/2 -translate-y-1\/2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"/,
    "toggle icon should no longer render as the large centered overlay button",
  );

  const toggleCallBindings = source.match(/sessionBranchToggle\(session\(\)\.id, hasChildren\(session\(\)\.id\)\)/g) ?? [];
  assert.equal(
    toggleCallBindings.length,
    2,
    "both recent and by-project rows should invoke the shared branch toggle renderer",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionExpandToggle\(event, sessionId\)\}/,
    "toggle helper should still stop propagation and toggle expansion only",
  );
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
    /const \[pendingArchiveConfirmationSessionId, setPendingArchiveConfirmationSessionId\] = createSignal<string \| null>\(/,
    "session list should track pending archive confirmation per session id",
  );

  assert.match(
    source,
    /if \(!archived && !isArchiveConfirmationPending\(id\)\) \{[\s\S]*setPendingArchiveConfirmationSessionId\(id\);\s*return;\s*\}/s,
    "first click on a non-archived session should only arm inline confirmation",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, session\(\)\.id\)\}/,
    "recent session rows should route hover action through two-step archive confirmation",
  );

  assert.match(
    source,
    /onClick=\{\(event\) => handleSessionArchiveAction\(event, row\.session\.id\)\}/,
    "by-project session rows should route hover action through two-step archive confirmation",
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
    /if \(!archived && !isArchiveConfirmationPending\(id\)\) \{\s*if \(event\.currentTarget instanceof HTMLButtonElement\) \{\s*pendingArchiveConfirmButtonRef = event\.currentTarget;\s*\}\s*setPendingArchiveConfirmationSessionId\(id\);\s*return;\s*\}/s,
    "first archive click should capture button target before pending mode, so outside-click cancellation does not clear confirm click",
  );
});
