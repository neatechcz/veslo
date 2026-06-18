import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";
import {
  isPassiveLocalBrowseActivationOrigin,
  shouldSuppressWorkspaceSwitchOverlayForActivation,
} from "../../context/workspace-activation-controller.js";

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

test("passive local browse activations suppress the fullscreen switch overlay", () => {
  assert.equal(isPassiveLocalBrowseActivationOrigin("workspace-session-list:project-open"), true);
  assert.equal(isPassiveLocalBrowseActivationOrigin("session-navigation:open-session-before-open"), true);
  assert.equal(isPassiveLocalBrowseActivationOrigin("send-target:selected-session-workspace"), false);
  assert.equal(isPassiveLocalBrowseActivationOrigin("workspace:activate-fresh-local"), false);

  assert.equal(
    shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: "local",
      origin: "workspace-session-list:project-open",
    }),
    true,
  );
  assert.equal(
    shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: "local",
      origin: "session-navigation:open-session-before-open",
    }),
    true,
  );
  assert.equal(
    shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: "local",
      origin: "workspace:activate-fresh-local",
    }),
    false,
  );
  assert.equal(
    shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: "remote",
      origin: "workspace-session-list:project-open",
    }),
    false,
  );
  assert.equal(
    shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: "local",
      origin: "workspace-session-list:project-open",
      promoteToFront: true,
    }),
    false,
  );
});

test("overlay suppression token is cleared on timeout, supersede, and completion", () => {
  const activationSource = readContextSource("workspace-activation-controller.ts");

  assert.match(
    activationSource,
    /const clearOverlaySuppressionToken = \(\) => \{[\s\S]*current === overlaySuppressionToken \? null : current,[\s\S]*\};/,
    "activation controller should clear only the suppression token it owns",
  );
  assert.match(
    activationSource,
    /deps\.wsActivateGuard\.exit\(myVersion, deps\.setConnectingWorkspaceId\);[\s\S]*clearOverlaySuppressionToken\(\);[\s\S]*deps\.setBusy\(false\);/,
    "activation timeout should clear both connecting state and overlay suppression",
  );
  assert.match(
    activationSource,
    /if \(isSuperseded\(\)\) \{[\s\S]*deps\.wsDebug\("activate:superseded:early"[\s\S]*clearOverlaySuppressionToken\(\);[\s\S]*return false;[\s\S]*\}/,
    "early superseded activation should not leave a stale overlay suppression token",
  );
  assert.match(
    activationSource,
    /finally \{[\s\S]*deps\.wsActivateGuard\.exit\(myVersion, deps\.setConnectingWorkspaceId\);[\s\S]*clearOverlaySuppressionToken\(\);[\s\S]*deps\.wsDebug\("activate:finally"/,
    "normal activation completion should clear overlay suppression after the guard exits",
  );
});
