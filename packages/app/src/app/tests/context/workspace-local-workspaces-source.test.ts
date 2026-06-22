import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("local workspace CRUD lives outside workspace facade", () => {
  const localSource = readContextSource("workspace-local-workspaces.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(localSource, /export function createWorkspaceLocalWorkspaces\(/);
  assert.match(localSource, /async function createLocalWorkspace/);
  assert.match(localSource, /const mode = forgetOptions\?\.deleteLocalData \? "delete_local_data" : "detach_only";/);
  assert.match(localSource, /return \[existing, \.\.\.rest\];/);
  assert.doesNotMatch(facadeSource, /async function createLocalWorkspace/);
});

test("missing local workspace roots do not start a host process", () => {
  const localSource = readContextSource("workspace-local-workspaces.ts");

  assert.match(
    localSource,
    /if \(workspace\.missing\) \{\s*deps\.setError\("Workspace folder no longer exists\. Remove it from Veslo or choose the folder again\."\);\s*return false;\s*\}[\s\S]*const started = await deps\.startHost\(\{ workspacePath: workspace\.path, navigate: false \}\);/s,
    "missing local workspaces should remain removable without recreating or starting their deleted folder",
  );
});
