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
    /if \(sourceKey === targetKey\) return;/,
    "self-drop should be ignored before reordering state is mutated",
  );
});

test("project rows expose grip handle and drag lifecycle bindings", () => {
  assert.match(
    source,
    /GripVertical/,
    "project rows should render a grip handle for drag affordance",
  );

  assert.match(
    source,
    /<For each=\{orderedProjectGroups\(\)\}>/,
    "by-project render should iterate through the ordered project group list",
  );

  assert.match(
    source,
    /draggable/,
    "project drag handle should opt into native drag-and-drop",
  );

  assert.match(
    source,
    /onDragStart=\{\(event\) => handleProjectDragStart\(event, project\.key\)\}/,
    "drag handle should start reordering with the project key",
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
    "drag handle should clear transient drag state at the end of the gesture",
  );
});

test("clicking selected parent toggles subagent expansion while non-selected rows open sessions", () => {
  assert.match(
    source,
    /const handleSessionRowClick = \(\s*row: FlatSessionRow,\s*hasChildren: \(sessionId: string\) => boolean,\s*\) => \{\s*if \(props\.selectedSessionId !== row\.session\.id\) \{\s*props\.onOpenSession\(row\.workspace\.id, row\.session\.id\);\s*return;\s*\}\s*if \(hasChildren\(row\.session\.id\)\) \{\s*toggleExpandedParentSession\(row\.session\.id\);\s*\}\s*\};/s,
    "selected row should toggle expansion only when it has children; otherwise rows open the session",
  );

  assert.match(
    source,
    /onClick=\{\(\) => handleSessionRowClick\(row, hasChildren\)\}/,
    "session rows should route click behavior through the selected-row-aware handler",
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
