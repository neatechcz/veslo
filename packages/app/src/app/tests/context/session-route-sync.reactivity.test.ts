import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createSessionRouteSync } from "../../context/session-route-sync.js";
import type { MessageWithParts } from "../../types";

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

test("session route resume selects each route once and stops with its owner", behaviorTestOptions, async () => {
  const [pathname, setPathname] = createSignal("/session/sess-a");
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [visibleMessages, setVisibleMessages] = createSignal<MessageWithParts[]>([]);
  const selected: string[] = [];
  let dispose: () => void = () => {};

  createRoot((rootDispose) => {
    dispose = rootDispose;
    const sync = createSessionRouteSync({
      pathname,
      sidebarWorkspaceGroups: () => [],
      sessions: () => [{ id: "sess-a" }, { id: "sess-b" }],
      scopedSessionIds: () => [],
      resolveSelectedSessionBrowseScope: (sessionId) => ({
        sessionId,
        workspaceId: "workspace-a",
        workspaceRoot: "/repo",
        directory: "/repo",
      }),
      activeWorkspaceId: () => "workspace-a",
      activeWorkspaceRoot: () => "/repo",
      clientDirectory: () => "/repo",
      routedClient: () => ({}),
      connectedVersion: () => "v1",
      sessionsLoadedForActiveWorkspace: () => true,
      selectedSessionId,
      visibleMessages,
      selectedSessionLoadingEarlierMessages: () => false,
      activePendingDraftKey: () => null,
      activePendingDraftMeta: () => null,
      isPendingSessionInstanceKey: () => false,
      visibleSelectedSessionStatus: () => "idle",
      setSelectedSessionId,
      setMessages: () => {},
      setTodos: () => {},
      selectSession: async (sessionId) => {
        selected.push(sessionId);
        setSelectedSessionId(sessionId);
      },
      navigate: () => {},
    });

    sync.startRouteResumeEffect();
  });

  try {
    await flushEffects();
    assert.deepEqual(selected, ["sess-a"]);

    setVisibleMessages([]);
    await flushEffects();
    assert.deepEqual(selected, ["sess-a"], "unrelated reruns must not reselect the route");

    setPathname("/session/sess-b");
    await flushEffects();
    assert.deepEqual(selected, ["sess-a", "sess-b"]);
  } finally {
    dispose();
  }

  setPathname("/session/sess-a");
  await flushEffects();
  assert.deepEqual(selected, ["sess-a", "sess-b"], "disposed route sync must not resume a route");
});
