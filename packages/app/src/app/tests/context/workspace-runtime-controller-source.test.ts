import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("lazy runtime ensure lives in workspace runtime controller", () => {
  const runtimeSource = readContextSource("workspace-runtime-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(runtimeSource, /export function createWorkspaceRuntimeController\(/);
  assert.match(runtimeSource, /async function ensureEngineForWorkspace/);
  assert.match(runtimeSource, /connectMode: "quiet"/);
  assert.match(
    runtimeSource,
    /async function connectToEngineQuiet[\s\S]*deps\.routing\.ensure\(workspaceId, baseUrl,[\s\S]*deps\.setClient\(nextClient\);/s,
    "quiet reconnect must bind a workspace-scoped routed client before send uses routedClient(workspaceId)",
  );
  assert.match(runtimeSource, /reattachOrchestratorWorkspace\(/);
  assert.match(runtimeSource, /withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\)/);
  assert.match(runtimeSource, /loadSessions failed; continuing first prompt/);
  assert.match(runtimeSource, /clearWorkspaceBusyAllExcept\(workspace\.id\)/);
  assert.match(
    runtimeSource,
    /const isActiveWorkspace = workspace\.id === deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*if \(isActiveWorkspace\) \{[\s\S]*deps\.setEngineReady\?\.\(true\);[\s\S]*deps\.onEngineStable\?\.\(\);[\s\S]*\}/s,
    "runtime ensure should reflect engine readiness only for the currently active workspace",
  );
  assert.match(
    runtimeSource,
    /const message = messageFromUnknownError\(e, deps\.safeStringify\);[\s\S]*deps\.setError\(message\);/,
    "runtime ensure failures should keep concrete engine startup messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /async function ensureEngineForWorkspace/);
});
