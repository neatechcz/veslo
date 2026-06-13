import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource } from "./workspace-source";

test("remote workspace activation lives in a scoped activation module", () => {
  const remoteSource = readContextSource("workspace-activation-remote.ts");
  const facadeSource = readContextSource("workspace.ts");

  assert.match(remoteSource, /export function createWorkspaceRemoteActivation\(/);
  assert.match(remoteSource, /async function activateRemoteVesloWorkspace/);
  assert.match(remoteSource, /async function activateRemoteDirectWorkspace/);
  assert.match(remoteSource, /workspace-switch-veslo/);
  assert.match(remoteSource, /workspace-switch-direct/);
  assert.match(remoteSource, /deps\.isSuperseded\(\)/);
  assert.match(
    remoteSource,
    /const message = error instanceof Error \? error\.message : deps\.safeStringify\(error\);[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(message\)\);/,
    "remote activation errors should keep concrete messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /workspace-switch-veslo/);
  assert.doesNotMatch(facadeSource, /workspace-switch-direct/);
});
