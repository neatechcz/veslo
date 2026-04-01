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
    /const orderedProjectGroups = createMemo\(\(\) => applyProjectOrder\(projectGroups\(\), projectOrder\(\)\)\);/,
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
    /const handleSessionRowClick = \(\s*row: FlatSessionRow,\s*hasChildren: \(sessionId: string\) => boolean,\s*\) => \{\s*if \(props\.selectedSessionId !== row\.session\.id\) \{\s*props\.onOpenSession\(row\.workspace\.id, row\.session\.id\);\s*return;\s*\}\s*if \(hasChildren\(row\.session\.id\)\) \{\s*toggleExpandedParentSession\(row\.session\.id\);\s*\}\s*props\.onOpenSession\(row\.workspace\.id, row\.session\.id\);\s*\};/s,
    "selected row click should still route to session detail, and selected parents should also toggle expansion",
  );

  assert.match(
    source,
    /onClick=\{\(\) => handleSessionRowClick\(row, hasChildren\)\}/,
    "session rows should route click behavior through the selected-row-aware handler",
  );
});

test("selected session auto-expands its branch in the sidebar", () => {
  assert.match(
    source,
    /setExpandedParentSessionIds\(\(current\) => deriveExpandedParentSessionIds\(/,
    "sidebar should expand the selected session branch so child subagents are visible immediately",
  );
});

test("session label span exposes full title tooltip and optional decoration styling", () => {
  assert.match(
    source,
    /title=\{sessionLabelTitle\(row\)\}/,
    "session title tooltip should expose full name/label on hover",
  );

  assert.match(
    source,
    /style=\{sessionLabelStyle\(row\)\}/,
    "decorated subagent rows should apply persisted color styling",
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
