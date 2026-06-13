import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("activateWorkspace is implemented by activation controller", () => {
  const activationSource = readContextSource("workspace-activation-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(activationSource, /export function createWorkspaceActivationController\(/);
  assert.match(activationSource, /async function activateWorkspace/);
  assert.match(activationSource, /deps\.wsActivateGuard\.enter\(id\)/);
  assert.match(activationSource, /deps\.wsActivateGuard\.isSuperseded\(myVersion\)/);
  assert.match(activationSource, /deps\.runActivationBody\(\{/);
  assert.match(activationSource, /deps\.wsActivateGuard\.exit\(myVersion, deps\.setConnectingWorkspaceId\)/);
  assert.match(
    activationSource,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(message\)\);/,
    "activation failures should keep concrete messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /async function activateWorkspace/);
});
