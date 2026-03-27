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
