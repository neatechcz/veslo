import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  shouldShowBlockingWorkspaceOverlayForActivation,
} from "../../context/workspace-activation-controller.js";
import {
  resolveWorkspaceSwitchOverlayOpen,
  resolveWorkspaceSwitchOverlayStatusKey,
  resolveWorkspaceSwitchOverlayWorkspace,
} from "../../context/workspace-switch-overlay-state.js";

const workspace = (id: string, name = id) => ({ id, name, path: `/repo/${id}` } as any);
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("overlay workspace follows explicit blocking workspace while boot-free switching", () => {
  const active = workspace("ws-a");
  const target = workspace("ws-b");

  assert.equal(
    resolveWorkspaceSwitchOverlayWorkspace({
      booting: false,
      blockingWorkspaceId: "ws-b",
      activeWorkspace: active,
      workspaces: [active, target],
    }),
    target,
  );
});

test("overlay workspace is null while booting", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayWorkspace({
      booting: true,
      blockingWorkspaceId: "ws-b",
      activeWorkspace: workspace("ws-a"),
      workspaces: [workspace("ws-b")],
    }),
    null,
  );
});

test("overlay only opens for delayed explicit switch, hold-open, or boot", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: "ws-b",
      switchDelayElapsed: false,
      holdOpen: false,
      busy: false,
      busyLabel: null,
    }),
    false,
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: "ws-b",
      switchDelayElapsed: true,
      holdOpen: false,
      busy: false,
      busyLabel: null,
    }),
    true,
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: null,
      switchDelayElapsed: false,
      holdOpen: true,
      busy: false,
      busyLabel: null,
    }),
    true,
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: null,
      switchDelayElapsed: false,
      holdOpen: false,
      busy: true,
      busyLabel: "status.starting_engine",
    }),
    false,
  );
});

test("activation overlay policy defaults to non-blocking local and blocking remote", () => {
  assert.equal(
    shouldShowBlockingWorkspaceOverlayForActivation({
      workspaceType: "local",
      origin: "workspace-session-list:project-open",
    }),
    false,
  );
  assert.equal(
    shouldShowBlockingWorkspaceOverlayForActivation({
      workspaceType: "remote",
      origin: "remote-store:recover-active-workspace",
    }),
    true,
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

test("app overlay wiring uses explicit blocking workspace id, not connecting workspace id", () => {
  const overlayStateMatch = appSource.match(
    /createWorkspaceSwitchOverlayState\(\{[\s\S]*?\}\);/,
  );
  assert.ok(overlayStateMatch, "app should wire workspace switch overlay state");
  const overlayStateSource = overlayStateMatch[0];

  assert.match(
    overlayStateSource,
    /blockingWorkspaceId: \(\) => workspaceStore\.workspaceSwitchOverlayWorkspaceId\(\)/,
    "overlay should be driven by explicit blocking workspace state",
  );
  assert.doesNotMatch(
    overlayStateSource,
    /connectingWorkspaceId/,
    "overlay wiring must not use connectingWorkspaceId as a fullscreen trigger",
  );
});

test("overlay does not open for non-blocking busy state without explicit target", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: null,
      switchDelayElapsed: true,
      holdOpen: false,
      busy: true,
      busyLabel: "status.connecting",
    }),
    false,
  );

  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      blockingWorkspaceId: null,
      switchDelayElapsed: true,
      holdOpen: false,
      busy: true,
      busyLabel: "status.restarting_engine",
    }),
    false,
  );
});

test("status key preserves connecting, preparing, and loading priorities", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.connecting",
      blockingWorkspaceId: "ws-b",
      booting: false,
    }),
    "workspace.switching_status_connecting",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.starting_engine",
      blockingWorkspaceId: null,
      booting: false,
    }),
    "workspace.switching_status_preparing",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.loading_session",
      blockingWorkspaceId: null,
      booting: false,
    }),
    "workspace.switching_status_loading",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: null,
      blockingWorkspaceId: "ws-b",
      booting: false,
    }),
    "workspace.switching_status_loading",
  );
});
