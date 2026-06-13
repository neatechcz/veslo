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
    /reconcileManagedAiApiKeys:skip"[\s\S]*error: err instanceof Error \? err\.message : String\(err\)/,
    "registry sync should preserve concrete per-workspace reconciliation errors in debug logs",
  );
  assert.doesNotMatch(facadeSource, /const reconcileManagedAiApiKeys = async/);
});
