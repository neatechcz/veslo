import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("veslo server registry sync lives outside workspace facade", () => {
  const registrySource = readContextSource("workspace-server-registry.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(registrySource, /export function createWorkspaceServerRegistry\(/);
  assert.match(registrySource, /addLocalWorkspace\(\{ path: trimmed/);
  assert.match(registrySource, /reconcileManagedAiApiKeys/);
  assert.match(registrySource, /activateWorkspace\(match\.id\)/);
  assert.match(
    registrySource,
    /reconcileManagedAiApiKeys:skip"[\s\S]*managed-config-owned-by-app-sync/,
    "registry sync should leave managed config writes to the app-level managed config sync owner",
  );
  assert.doesNotMatch(
    registrySource,
    /patchConfig\(/,
    "registry sync should not patch managed AI config independently",
  );
  assert.doesNotMatch(facadeSource, /const reconcileManagedAiApiKeys = async/);
});
