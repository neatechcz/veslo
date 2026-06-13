import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("lazy runtime ensure lives in workspace runtime controller", () => {
  const runtimeSource = readContextSource("workspace-runtime-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(runtimeSource, /export function createWorkspaceRuntimeController\(/);
  assert.match(runtimeSource, /async function ensureEngineForWorkspace/);
  assert.match(runtimeSource, /connectMode: "quiet"/);
  assert.match(runtimeSource, /clearWorkspaceBusyAllExcept\(workspace\.id\)/);
  assert.match(
    runtimeSource,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*deps\.setError\(message\);/,
    "runtime ensure failures should keep concrete engine startup messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /async function ensureEngineForWorkspace/);
});
