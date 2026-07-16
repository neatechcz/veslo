import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createWorkspaceSessionSnapshots } from "../../context/workspace-session-snapshots.js";

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

test("workspace snapshots save and load once per switch, then stop with their owner", behaviorTestOptions, async () => {
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal("ws-a");
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const calls: string[] = [];
  let dispose: () => void = () => {};

  createRoot((rootDispose) => {
    dispose = rootDispose;
    createWorkspaceSessionSnapshots({
      activeWorkspaceId,
      selectedSessionId,
      resolveSelectedSessionBrowseScope: () => null,
      saveWorkspaceSnapshot: (workspaceId) => calls.push(`save:${workspaceId}`),
      loadWorkspaceSnapshot: (workspaceId) => {
        calls.push(`load:${workspaceId}`);
        return true;
      },
    });
  });

  try {
    await flushEffects();
    assert.deepEqual(calls, ["load:ws-a"]);

    setSelectedSessionId("session-a");
    await flushEffects();
    assert.deepEqual(calls, ["load:ws-a"], "selected session changes do not reload the same workspace");

    setActiveWorkspaceId("ws-b");
    await flushEffects();
    assert.deepEqual(calls, ["load:ws-a", "save:ws-a", "load:ws-b"]);
  } finally {
    dispose();
  }

  setActiveWorkspaceId("ws-a");
  await flushEffects();
  assert.deepEqual(calls, ["load:ws-a", "save:ws-a", "load:ws-b"], "disposed snapshots must not restore state");
});
