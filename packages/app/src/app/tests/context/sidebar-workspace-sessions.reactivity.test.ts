import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";
import { createComputed, createRoot, createSignal } from "solid-js";

import { createSidebarWorkspaceSessions } from "../../context/sidebar-workspace-sessions.js";
import type { WorkspaceRouting } from "../../context/workspace-routing.js";
import type { WorkspaceStore } from "../../context/workspace.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import type { SidebarSessionItem } from "../../types.js";

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
    pendingTimerCount: () => Array.from(timers.values()).filter((timer) => !timer.cancelled).length,
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

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const localWorkspace: WorkspaceInfo = {
  id: "ws-local",
  name: "Local",
  path: "C:/work/project",
  preset: "starter",
  workspaceType: "local",
};

const workspaceRouting = (): WorkspaceRouting => ({
  client: () => null,
  active: () => null,
  activeWorkspaceId: () => localWorkspace.id,
  entry: () => null,
  ensure: async () => null,
  lastEnsureError: () => null,
  release: () => undefined,
  forEach: () => undefined,
  entryIds: () => [],
});

test("sidebar refresh uses one deferred send timer and cancels it with its owner", behaviorTestOptions, async () => {
  const fakeWindow = installFakeWindow();
  const [activeSendTraceId, setActiveSendTraceId] = createSignal<string | null>("trace-a");
  let readApiCalls = 0;
  let dispose: () => void = () => {};

  try {
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const workspaceStore = {
        workspaces: () => [localWorkspace],
        activeWorkspaceId: () => localWorkspace.id,
        connectingWorkspaceId: () => null,
        engine: () => null,
        isPrivateWorkspacePath: () => false,
      } as unknown as WorkspaceStore;

      createSidebarWorkspaceSessions({
        workspaceStore,
        workspaceRouting: workspaceRouting(),
        activeWorkspaceRuntimeReady: () => true,
        activeSendTraceId,
        developerMode: () => false,
        sessions: () => [],
        sessionDirectoryOverrideById: () => ({}),
        resolveSessionDirectory: (session) => session.directory ?? "",
        applySessionDirectoryOverride: <T extends Session | SidebarSessionItem>(session: T) => session,
        applyPendingInitialSessionTitle: <T extends Session | SidebarSessionItem>(session: T) => session,
        listConversationsFromVesloReadApi: async () => {
          readApiCalls += 1;
          return { items: [], source: "unavailable" as const };
        },
        allowLiveWorkspaceSessionList: () => false,
        reportError: (error) => { throw error; },
        wsDebug: () => {},
      });
    });

    await settleEffects();
    assert.ok(readApiCalls > 0, "active-send refresh should still read the host API");
    assert.equal(fakeWindow.pendingTimerCount(), 1, "one workspace owns at most one deferred refresh");

    setActiveSendTraceId(null);
    await settleEffects();
    const callsBeforeDispose = readApiCalls;

    dispose();
    assert.equal(fakeWindow.pendingTimerCount(), 0, "dispose cancels the deferred refresh timer");

    fakeWindow.runTimers();
    await settleEffects();
    assert.equal(readApiCalls, callsBeforeDispose, "disposed sidebar must not perform a deferred refresh");
  } finally {
    dispose();
    fakeWindow.restore();
  }
});
