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
    /deps\.isSuperseded\(\)[\s\S]*activate:superseded:before-remote-persist[\s\S]*workspaceSetActive\(id/,
    "stale remote activations should not persist active workspace after being superseded",
  );
  assert.match(
    remoteSource,
    /workspaceSetActive\(id[\s\S]*deps\.isSuperseded\(\)[\s\S]*activate:superseded:after-remote-set-active[\s\S]*deps\.setWorkspaces\(ws\.workspaces\)/,
    "stale remote workspaceSetActive responses should not be applied to UI state",
  );
  assert.match(
    remoteSource,
    /const message = error instanceof Error \? error\.message : deps\.safeStringify\(error\);[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(message\)\);/,
    "remote activation errors should keep concrete messages for the UI",
  );
  assert.match(
    remoteSource,
    /provisionWorkspaceSystem\([\s\S]*workspaceInfo\.id,[\s\S]*deps\.soulAuthContext\?\.\(\)[\s\S]*\)/,
    "Veslo workspace provisioning should pass Den context for Soul materialization",
  );
  assert.match(
    facadeSource,
    /soulAuthContext:\s*\(\)\s*=>[\s\S]*readDenAuth\(\)[\s\S]*denToken[\s\S]*denOrgId[\s\S]*denUserId/,
    "workspace activation should provide the active Den identity to remote provisioning",
  );
  assert.match(
    remoteSource,
    /const canUseFallbackToken =[\s\S]*!workspaceToken[\s\S]*Boolean\(fallbackToken\)[\s\S]*normalizeVesloHostForTokenFallback\(settingsHostUrl\) === normalizeVesloHostForTokenFallback\(hostUrl\)/,
    "global Veslo token fallback should be allowed only when the settings host exactly matches the workspace host",
  );
  assert.match(
    remoteSource,
    /const tokenToPersistWithWorkspace = workspaceToken \|\| null;/,
    "workspace activation must not silently persist an inherited global token into the workspace credential",
  );
  assert.match(
    remoteSource,
    /updateVesloServerSettings\(\{[\s\S]*token: token \|\| undefined,[\s\S]*\}\);/,
    "switching remote Veslo hosts without a matching token should clear stale global credentials instead of carrying them forward",
  );
  assert.doesNotMatch(facadeSource, /workspace-switch-veslo/);
  assert.doesNotMatch(facadeSource, /workspace-switch-direct/);
});
