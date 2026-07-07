import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeOwnedRouting,
  createRuntimeOwner,
} from "../../context/runtime-owner.js";
import {
  createInitialWorkspaceLifecycleState,
  reduceWorkspaceLifecycleState,
} from "../../context/workspace-lifecycle-state.js";

const client = (id: string) => ({ id }) as any;

function createRouting(entries: Record<string, any>) {
  return {
    client: (workspaceId?: string) => entries[workspaceId ?? ""] ?? null,
    entry: (workspaceId: string) =>
      entries[workspaceId]
        ? {
            workspaceId,
            client: entries[workspaceId],
            baseUrl: `http://runtime/${workspaceId}`,
            lastUsed: 1,
          }
        : null,
    entryIds: () => Object.keys(entries),
  };
}

test("runtime owner resolves workspace readiness from orchestrator and routing only", () => {
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => true,
    readyEngineWorkspaceIds: () => new Set(["ws-orchestrator"]),
    routing: createRouting({ "ws-routed": client("ws-routed") }),
  });

  assert.deepEqual(owner.resolveWorkspace("ws-orchestrator"), {
    owner: { type: "workspace-runtime", workspaceId: "ws-orchestrator" },
    workspaceId: "ws-orchestrator",
    ready: true,
    reason: "orchestrator-ready",
    activeWorkspace: false,
    orchestratorReady: true,
    routedClientReady: false,
    activeLegacyEngineReady: false,
    busy: false,
  });
  assert.equal(owner.resolveWorkspace("ws-routed").reason, "routed-client");
  assert.equal(owner.resolveWorkspace("ws-active").reason, "not-ready");
  assert.equal(owner.resolveWorkspace("ws-active").activeLegacyEngineReady, true);
  assert.equal(owner.resolveWorkspace("ws-cold").ready, false);
});

test("runtime owner treats legacy engineReady as diagnostics, not readiness", () => {
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => true,
    readyEngineWorkspaceIds: () => new Set(),
    routing: createRouting({}),
  });

  assert.equal(owner.isWorkspaceRuntimeReady("ws-active"), false);
  assert.equal(owner.isWorkspaceRuntimeReady("ws-other"), false);
});

test("runtime owner any-ready includes orchestrator snapshots and routed workspaces", () => {
  const readyFromSnapshot = createRuntimeOwner({
    activeWorkspaceId: () => "",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(["ws-ready"]),
    routing: createRouting({}),
  });
  const readyFromRoute = createRuntimeOwner({
    activeWorkspaceId: () => "",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    routing: createRouting({ "ws-routed": client("ws-routed") }),
  });

  assert.equal(readyFromSnapshot.anyWorkspaceRuntimeReady(), true);
  assert.equal(readyFromRoute.anyWorkspaceRuntimeReady(), true);
});

test("runtime owner does not treat local orchestrator routes as ready without an engine snapshot", () => {
  const routed = client("ws-local");
  const routeOnly = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    requiresOrchestratorReadiness: (workspaceId) => workspaceId === "ws-local",
    routing: createRouting({ "ws-local": routed }),
  });
  const snapshotReady = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(["ws-local"]),
    requiresOrchestratorReadiness: (workspaceId) => workspaceId === "ws-local",
    routing: createRouting({ "ws-local": routed }),
  });

  assert.deepEqual(routeOnly.resolveWorkspace("ws-local"), {
    owner: null,
    workspaceId: "ws-local",
    ready: false,
    reason: "not-ready",
    activeWorkspace: false,
    orchestratorReady: false,
    routedClientReady: true,
    activeLegacyEngineReady: false,
    busy: false,
  });
  assert.equal(routeOnly.client("ws-local"), null);
  assert.equal(routeOnly.anyWorkspaceRuntimeReady(), false);
  assert.equal(snapshotReady.isWorkspaceRuntimeReady("ws-local"), true);
  assert.equal(snapshotReady.client("ws-local"), routed);
});

test("runtime owner accepts a connected local orchestrator lifecycle before the engine poll refreshes", () => {
  const routed = client("ws-local");
  const lifecycleState = reduceWorkspaceLifecycleState(createInitialWorkspaceLifecycleState(), {
    type: "connected",
    workspaceId: "ws-local",
    runtime: "veslo-orchestrator",
    reason: "sendPrompt-runtime-recovery",
  });
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-local",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    workspaceLifecycleState: () => lifecycleState,
    requiresOrchestratorReadiness: (workspaceId) => workspaceId === "ws-local",
    routing: createRouting({ "ws-local": routed }),
  });
  const routeMissing = createRuntimeOwner({
    activeWorkspaceId: () => "ws-local",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    workspaceLifecycleState: () => lifecycleState,
    requiresOrchestratorReadiness: (workspaceId) => workspaceId === "ws-local",
    routing: createRouting({}),
  });

  assert.equal(owner.resolveWorkspace("ws-local").reason, "orchestrator-ready");
  assert.equal(owner.client("ws-local"), routed);
  assert.equal(routeMissing.isWorkspaceRuntimeReady("ws-local"), false);
  assert.equal(routeMissing.client("ws-local"), null);
});

test("runtime owner does not let legacy engineReady bypass required orchestrator readiness", () => {
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-local",
    activeLegacyEngineReady: () => true,
    readyEngineWorkspaceIds: () => new Set(),
    requiresOrchestratorReadiness: (workspaceId) => workspaceId === "ws-local",
    routing: createRouting({}),
  });

  assert.deepEqual(owner.resolveWorkspace("ws-local"), {
    owner: null,
    workspaceId: "ws-local",
    ready: false,
    reason: "not-ready",
    activeWorkspace: true,
    orchestratorReady: false,
    routedClientReady: false,
    activeLegacyEngineReady: false,
    busy: false,
  });
});

test("runtime owner conversation-read sync allows busy workspaces without pretending runtime is ready", () => {
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    workspaceBusy: () => ({ "ws-busy": { ses_1: { startedAt: 1 } } }),
    routing: createRouting({}),
  });

  assert.equal(owner.isWorkspaceRuntimeReady("ws-busy"), false);
  assert.equal(owner.shouldSyncConversationReadForWorkspace("ws-busy"), true);
  assert.equal(owner.shouldSyncConversationReadForWorkspace("ws-cold"), false);
});

test("runtime owner client lookup is gated by concrete workspace readiness", () => {
  const routed = client("ws-routed");
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    routing: createRouting({ "ws-routed": routed }),
  });

  assert.equal(owner.client("ws-routed"), routed);
  assert.equal(owner.client("ws-cold"), null);
  assert.equal(owner.client(), null);
});

test("runtime-owned routing gates client reads through the owner", () => {
  const rawActive = client("raw-active");
  const routing = {
    client: () => rawActive,
    active: () => rawActive,
    activeWorkspaceId: () => "ws-active",
    entry: () => null,
    entryIds: () => [],
    ensure: async () => null,
    lastEnsureError: () => null,
    release: () => undefined,
    forEach: () => undefined,
  } as any;
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    routing,
  });
  const ownedRouting = createRuntimeOwnedRouting(routing, owner);

  assert.equal(ownedRouting.active(), null);
  assert.equal(ownedRouting.client(), null);
  assert.equal(ownedRouting.client("ws-active"), null);
});

test("runtime-owned routing delegates lifecycle operations without owning mutations", async () => {
  const calls: string[] = [];
  const routeClient = client("ws-routed");
  const routing = {
    client: (workspaceId?: string) => (workspaceId === "ws-routed" ? routeClient : null),
    active: () => null,
    activeWorkspaceId: () => "ws-active",
    entry: (workspaceId: string) => (workspaceId === "ws-routed" ? { workspaceId, client: routeClient } : null),
    entryIds: () => ["ws-routed"],
    ensure: async (workspaceId: string) => {
      calls.push(`ensure:${workspaceId}`);
      return null;
    },
    lastEnsureError: (workspaceId: string) => {
      calls.push(`lastEnsureError:${workspaceId}`);
      return null;
    },
    release: (workspaceId: string) => {
      calls.push(`release:${workspaceId}`);
    },
    forEach: (cb: (workspaceId: string, value: unknown) => void) => {
      calls.push("forEach");
      cb("ws-routed", routeClient);
    },
  } as any;
  const owner = createRuntimeOwner({
    activeWorkspaceId: () => "ws-active",
    activeLegacyEngineReady: () => false,
    readyEngineWorkspaceIds: () => new Set(),
    routing,
  });
  const ownedRouting = createRuntimeOwnedRouting(routing, owner);

  assert.equal(ownedRouting.client("ws-routed"), routeClient);
  assert.deepEqual(ownedRouting.entryIds(), ["ws-routed"]);
  assert.equal(ownedRouting.entry("ws-routed")?.client, routeClient);
  assert.equal(await ownedRouting.ensure("ws-new", "http://runtime"), null);
  assert.equal(ownedRouting.lastEnsureError("ws-new"), null);
  ownedRouting.release("ws-new");
  const iterated: string[] = [];
  ownedRouting.forEach((workspaceId) => iterated.push(workspaceId));

  assert.deepEqual(iterated, ["ws-routed"]);
  assert.deepEqual(calls, [
    "ensure:ws-new",
    "lastEnsureError:ws-new",
    "release:ws-new",
    "forEach",
  ]);
});
