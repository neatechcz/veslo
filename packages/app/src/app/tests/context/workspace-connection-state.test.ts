import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import { createWorkspaceConnectionState } from "../../context/workspace-connection-state";
import type { WorkspaceInfo } from "../../lib/tauri";

const workspace = (id: string): WorkspaceInfo =>
  ({
    id,
    name: id,
    path: `C:/work/${id}`,
    preset: "starter",
    workspaceType: "local",
  }) as WorkspaceInfo;

test("connection state is updated with checkedAt", () => {
  createRoot((dispose) => {
    const [workspaces] = createSignal([workspace("ws-a")]);
    const state = createWorkspaceConnectionState(workspaces);

    state.updateWorkspaceConnectionState(" ws-a ", {
      status: "connecting",
      message: null,
    });

    const entry = state.workspaceConnectionStateById()["ws-a"];
    assert.equal(entry.status, "connecting");
    assert.equal(entry.message, null);
    assert.equal(typeof entry.checkedAt, "number");

    dispose();
  });
});

test("connection state preserves concrete error messages for UI", () => {
  createRoot((dispose) => {
    const [workspaces] = createSignal([workspace("ws-a")]);
    const state = createWorkspaceConnectionState(workspaces);

    state.updateWorkspaceConnectionState("ws-a", {
      status: "error",
      message: "engine_info timed out after 75000ms",
    });

    assert.equal(
      state.workspaceConnectionStateById()["ws-a"]?.message,
      "engine_info timed out after 75000ms",
    );

    dispose();
  });
});

test("connection state can be cleared by workspace id", () => {
  createRoot((dispose) => {
    const [workspaces] = createSignal([workspace("ws-a")]);
    const state = createWorkspaceConnectionState(workspaces);

    state.updateWorkspaceConnectionState("ws-a", {
      status: "error",
      message: "failed",
    });
    state.clearWorkspaceConnectionState("ws-a");

    assert.equal(state.workspaceConnectionStateById()["ws-a"], undefined);

    dispose();
  });
});
