import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createWorkspaceSwitchOverlayState } from "../../context/workspace-switch-overlay-state.js";

type FakeTimer = { callback: () => void; cancelled: boolean };

function installFakeWindow() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers = new Map<number, FakeTimer>();
  let nextTimerId = 1;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, { callback, cancelled: false });
        return id;
      },
      clearTimeout(id: number) {
        const timer = timers.get(id);
        if (timer) timer.cancelled = true;
      },
    },
    writable: true,
  });

  return {
    runTimers() {
      const pending = Array.from(timers.entries());
      timers.clear();
      for (const [, timer] of pending) {
        if (!timer.cancelled) timer.callback();
      }
    },
    restore() {
      if (previous) {
        Object.defineProperty(globalThis, "window", previous);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    },
  };
}

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

test("workspace switch overlay delays, holds, and cancels timers with its lifecycle", behaviorTestOptions, async () => {
  const fakeWindow = installFakeWindow();
  const [booting] = createSignal(false);
  const [blockingWorkspaceId, setBlockingWorkspaceId] = createSignal<string | null>(null);
  let nowMs = 0;

  try {
    await createRoot(async (dispose) => {
      const state = createWorkspaceSwitchOverlayState({
        booting,
        blockingWorkspaceId,
        activeWorkspaceDisplay: () => ({ id: "workspace-a", name: "Workspace A" }) as any,
        workspaces: () => [],
        busy: () => false,
        busyLabel: () => null,
        now: () => nowMs,
      });

      try {
        await flushEffects();
        assert.equal(state.workspaceSwitchOpen(), false);

        setBlockingWorkspaceId("workspace-b");
        await flushEffects();
        assert.equal(state.workspaceSwitchOpen(), false, "overlay must wait for its delay");

        fakeWindow.runTimers();
        await flushEffects();
        assert.equal(state.workspaceSwitchOpen(), true, "delayed switch opens the overlay");

        nowMs = 100;
        setBlockingWorkspaceId(null);
        await flushEffects();
        assert.equal(state.workspaceSwitchOpen(), true, "minimum-visible hold keeps the overlay open");

        fakeWindow.runTimers();
        await flushEffects();
        assert.equal(state.workspaceSwitchOpen(), false, "hold timer closes the overlay exactly once");

        setBlockingWorkspaceId("workspace-c");
        await flushEffects();
      } finally {
        dispose();
      }

      fakeWindow.runTimers();
      await flushEffects();
      assert.equal(state.workspaceSwitchOpen(), false, "disposed overlay must not fire a delayed timer");
    });
  } finally {
    fakeWindow.restore();
  }
});
