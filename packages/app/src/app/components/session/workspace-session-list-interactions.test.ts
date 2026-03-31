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
