import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createWorkspaceConnectionState } from "../../context/workspace-connection-state.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import type { WorkspaceConnectionState } from "../../types.js";

type ConnectionStateOwner = {
  workspaceConnectionStateById: () => Record<string, WorkspaceConnectionState>;
  updateWorkspaceConnectionState: (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => void;
};

const workspace = (id: string): WorkspaceInfo => ({
  id,
  name: id,
  path: `C:/work/${id}`,
  preset: "starter",
  workspaceType: "local",
});

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => { observed = value(); });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("connection state prunes removed workspaces and stops after disposal", behaviorTestOptions, async () => {
  const [workspaces, setWorkspaces] = createSignal([workspace("ws-a"), workspace("ws-b")]);
  let dispose: () => void = () => {};
  let state!: ConnectionStateOwner;

  createRoot((rootDispose) => {
    dispose = rootDispose;
    state = createWorkspaceConnectionState(workspaces);
  });

  try {
    state.updateWorkspaceConnectionState("ws-a", { status: "error", message: "stale" });
    state.updateWorkspaceConnectionState("ws-b", { status: "connected", message: null });
    await flushEffects();

    setWorkspaces([workspace("ws-b")]);
    await flushEffects();
    assert.equal(state.workspaceConnectionStateById()["ws-a"], undefined);
    assert.equal(state.workspaceConnectionStateById()["ws-b"]?.status, "connected");
  } finally {
    dispose();
  }

  setWorkspaces([]);
  await flushEffects();
  assert.equal(
    state.workspaceConnectionStateById()["ws-b"]?.status,
    "connected",
    "disposed owner must not mutate connection state",
  );
});
