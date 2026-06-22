import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-runtime-controller.ts", import.meta.url), "utf8");

test("runtime errors from inactive workspaces do not set the global error", () => {
  assert.match(
    source,
    /const setErrorForActiveWorkspace = \(workspaceId: string, message: string\) => \{/,
    "workspace runtime errors should be scoped before they reach the global app error",
  );
  assert.match(
    source,
    /if \(!activeWorkspaceId \|\| activeWorkspaceId === workspaceId\) \{[\s\S]*deps\.setError\(message\);/,
    "only the active workspace should publish runtime errors globally",
  );
  assert.match(
    source,
    /inactive-workspace-error-suppressed/,
    "suppressed inactive workspace errors should remain traceable",
  );
});
