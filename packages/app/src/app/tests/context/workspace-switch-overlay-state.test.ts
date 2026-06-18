import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorkspaceSwitchOverlayOpen,
  resolveWorkspaceSwitchOverlayStatusKey,
  resolveWorkspaceSwitchOverlayWorkspace,
} from "../../context/workspace-switch-overlay-state.js";

const workspace = (id: string, name = id) => ({ id, name, path: `/repo/${id}` } as any);

test("overlay workspace follows connecting workspace while boot-free switching", () => {
  const active = workspace("ws-a");
  const target = workspace("ws-b");

  assert.equal(
    resolveWorkspaceSwitchOverlayWorkspace({
      booting: false,
      connectingWorkspaceId: "ws-b",
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
      connectingWorkspaceId: "ws-b",
      activeWorkspace: workspace("ws-a"),
      workspaces: [workspace("ws-b")],
    }),
    null,
  );
});

test("overlay only opens for delayed switch, hold-open, boot, or engine busy states", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      connectingWorkspaceId: "ws-b",
      connectingOverlaySuppressed: false,
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
      connectingWorkspaceId: "ws-b",
      connectingOverlaySuppressed: false,
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
      connectingWorkspaceId: null,
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
      connectingWorkspaceId: null,
      switchDelayElapsed: false,
      holdOpen: false,
      busy: true,
      busyLabel: "status.starting_engine",
    }),
    true,
  );
});

test("overlay does not open for suppressed non-blocking connecting workspaces", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      connectingWorkspaceId: "ws-b",
      connectingOverlaySuppressed: true,
      switchDelayElapsed: true,
      holdOpen: false,
      busy: false,
      busyLabel: null,
    }),
    false,
  );

  assert.equal(
    resolveWorkspaceSwitchOverlayOpen({
      booting: false,
      connectingWorkspaceId: "ws-b",
      connectingOverlaySuppressed: true,
      switchDelayElapsed: true,
      holdOpen: false,
      busy: true,
      busyLabel: "status.restarting_engine",
    }),
    true,
  );
});

test("status key preserves connecting, preparing, and loading priorities", () => {
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.connecting",
      connectingWorkspaceId: "ws-b",
      booting: false,
    }),
    "workspace.switching_status_connecting",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.starting_engine",
      connectingWorkspaceId: null,
      booting: false,
    }),
    "workspace.switching_status_preparing",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: "status.loading_session",
      connectingWorkspaceId: null,
      booting: false,
    }),
    "workspace.switching_status_loading",
  );
  assert.equal(
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: null,
      connectingWorkspaceId: "ws-b",
      booting: false,
    }),
    "workspace.switching_status_loading",
  );
});
