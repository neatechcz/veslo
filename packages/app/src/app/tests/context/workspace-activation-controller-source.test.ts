import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";
import {
  activateWorkspaceWithBrowsePolicy,
  isPassiveLocalBrowseActivationOrigin,
  shouldShowBlockingWorkspaceOverlayForActivation,
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
  assert.equal(isPassiveLocalBrowseActivationOrigin("send-target:selected-session-workspace"), true);
  assert.equal(isPassiveLocalBrowseActivationOrigin("composer-target:workspace"), true);
  assert.equal(isPassiveLocalBrowseActivationOrigin("app:open-pending-directory-draft-workspace"), true);
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
    true,
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
    true,
  );
  assert.equal(
    shouldShowBlockingWorkspaceOverlayForActivation({
      workspaceType: "local",
      origin: "workspace-session-list:project-open",
      promoteToFront: true,
    }),
    false,
  );
  assert.equal(
    shouldShowBlockingWorkspaceOverlayForActivation({
      workspaceType: "local",
      origin: "app:reload-workspace-engine",
      blockingOverlay: true,
    }),
    true,
  );
});

test("browse policy never falls back to activation for local passive browse", async () => {
  const calls: string[] = [];
  const ok = await activateWorkspaceWithBrowsePolicy(
    {
      workspaces: () => [{ id: "ws-local", workspaceType: "local" }],
      browseWorkspace: async () => {
        calls.push("browse");
        return false;
      },
      activateWorkspace: async () => {
        calls.push("activate");
        return true;
      },
    },
    "ws-local",
    { origin: "workspace-session-list:project-open" },
  );

  assert.equal(ok, false);
  assert.deepEqual(calls, ["browse"]);
});

test("new private pending draft origins require runtime activation", async () => {
  for (const origin of [
    "app:new-private-existing-pending-draft",
    "app:new-private-scratch-workspace",
  ]) {
    assert.equal(
      isPassiveLocalBrowseActivationOrigin(origin),
      false,
      `${origin} must not use passive local browse before first send`,
    );

    const calls: string[] = [];
    const ok = await activateWorkspaceWithBrowsePolicy(
      {
        workspaces: () => [{ id: "ws-private", workspaceType: "local" }],
        browseWorkspace: async () => {
          calls.push("browse");
          return false;
        },
        activateWorkspace: async () => {
          calls.push("activate");
          return true;
        },
      },
      "ws-private",
      { origin },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, ["activate"]);
  }
});

test("remote to local activation starts host with the target workspace id", () => {
  const localActivationSource = readContextSource("workspace-activation-local.ts");

  assert.match(
    localActivationSource,
    /deps\.startHost\(\{[\s\S]*workspacePath: next\.path,[\s\S]*workspaceId: next\.id,[\s\S]*navigate: false,[\s\S]*\}\)/,
    "startHost must use the workspace being activated when reconnecting from a stale route",
  );
});

test("browse policy keeps activation for remote or explicit runtime activation", async () => {
  const remoteCalls: string[] = [];
  const remoteOk = await activateWorkspaceWithBrowsePolicy(
    {
      workspaces: () => [{ id: "ws-remote", workspaceType: "remote" }],
      browseWorkspace: async () => {
        remoteCalls.push("browse");
        return true;
      },
      activateWorkspace: async () => {
        remoteCalls.push("activate");
        return true;
      },
    },
    "ws-remote",
    { origin: "workspace-session-list:project-open" },
  );

  assert.equal(remoteOk, true);
  assert.deepEqual(remoteCalls, ["activate"]);

  const explicitCalls: string[] = [];
  const explicitOk = await activateWorkspaceWithBrowsePolicy(
    {
      workspaces: () => [{ id: "ws-local", workspaceType: "local" }],
      browseWorkspace: async () => {
        explicitCalls.push("browse");
        return true;
      },
      activateWorkspace: async () => {
        explicitCalls.push("activate");
        return true;
      },
    },
    "ws-local",
    { origin: "workspace:activate-fresh-local" },
  );

  assert.equal(explicitOk, true);
  assert.deepEqual(explicitCalls, ["activate"]);
});

test("overlay suppression token is cleared on timeout, supersede, and completion", () => {
  const activationSource = readContextSource("workspace-activation-controller.ts");

  assert.match(
    activationSource,
    /setWorkspaceSwitchOverlayTarget\?: \([\s\S]*WorkspaceSwitchOverlayTarget[\s\S]*\) => void;/,
    "activation controller should expose an explicit blocking overlay target separate from connecting state",
  );
  assert.match(
    activationSource,
    /const overlayTarget = overlaySuppressionToken[\s\S]*workspaceId: id,[\s\S]*version: myVersion,/,
    "blocking overlay target should be versioned so late activation cleanup cannot clear a newer overlay",
  );
  assert.match(
    activationSource,
    /deps\.setWorkspaceSwitchOverlayTarget\?\.\(\(current\) =>[\s\S]*current\?\.version === overlayTarget\.version \? null : current/,
    "overlay target cleanup should only clear the activation version that owns it",
  );
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
