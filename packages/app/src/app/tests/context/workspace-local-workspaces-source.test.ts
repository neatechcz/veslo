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

test("first workspace onboarding completes only after runtime activation succeeds", () => {
  const localSource = readContextSource("workspace-local-workspaces.ts");

  assert.match(
    localSource,
    /async function createWorkspaceFlow[\s\S]*markOnboardingComplete: false,[\s\S]*const opened = await activateFreshLocalWorkspace[\s\S]*if \(!opened\) \{[\s\S]*return;[\s\S]*\}[\s\S]*deps\.markOnboardingComplete\(\);/s,
  );
});

test("Windows workspace creation leaves WSL mountability to runtime fallback", () => {
  const localSource = readContextSource("workspace-local-workspaces.ts");

  assert.doesNotMatch(localSource, /isWslMappableWindowsWorkspacePath\(resolvedFolder\)/);
  assert.doesNotMatch(localSource, /network and UNC paths are not supported for local sandboxed runs/);
});
