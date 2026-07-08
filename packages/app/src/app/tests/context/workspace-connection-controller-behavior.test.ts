import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceConnectionController } from "../../context/workspace-connection-controller";

const normalize = (value?: string | null) => (value ?? "").trim().replaceAll("\\", "/").toLowerCase();
type WorkspaceConnectionDeps = Parameters<typeof createWorkspaceConnectionController>[0];
type TestClient = ReturnType<WorkspaceConnectionDeps["client"]>;
type TestRoutingClient = NonNullable<TestClient>;
type TestClientEntry = NonNullable<Awaited<ReturnType<WorkspaceConnectionDeps["routing"]["ensure"]>>>;

const fakeClient = (id: string): TestRoutingClient => ({ id }) as unknown as TestRoutingClient;
const fakeEntry = (input: {
  workspaceId: string;
  clientId: string;
  baseUrl: string;
  directory?: string;
}): TestClientEntry => ({
  workspaceId: input.workspaceId,
  client: fakeClient(input.clientId),
  baseUrl: input.baseUrl,
  directory: input.directory,
  lastUsed: Date.now(),
});

function createDeps(overrides: Partial<WorkspaceConnectionDeps> = {}) {
  const calls: string[] = [];
  const state = {
    activeWorkspaceId: "ws-a",
    activeWorkspaceRoot: "/a",
    activeWorkspaceType: "local" as const,
    baseUrl: "",
    client: null as TestClient,
    clientDirectory: "",
    selectedSessionId: null as string | null,
  };
  const deps: Parameters<typeof createWorkspaceConnectionController>[0] = {
    routing: {
      active: () => null,
      activeWorkspaceId: () => state.activeWorkspaceId,
      client: () => null,
      entry: () => null,
      ensure: async (workspaceId, baseUrl, options) => {
        calls.push("routing.ensure");
        return fakeEntry({
          workspaceId,
          clientId: "client",
          baseUrl,
          directory: options?.directory ?? "/a",
        });
      },
      release: () => undefined,
      lastEnsureError: () => null,
      forEach: () => undefined,
      entryIds: () => [],
    },
    activeWorkspaceId: () => state.activeWorkspaceId,
    activeWorkspaceRoot: () => state.activeWorkspaceRoot,
    activeWorkspaceType: () => state.activeWorkspaceType,
    baseUrl: () => state.baseUrl,
    client: () => state.client,
    clientDirectory: () => state.clientDirectory,
    selectedSessionId: () => state.selectedSessionId,
    normalizeWorkspaceScopePath: normalize,
    setClient: (value) => {
      calls.push("setClient");
      state.client = value;
    },
    setConnectedVersion: () => calls.push("setConnectedVersion"),
    setBaseUrl: (value) => {
      calls.push("setBaseUrl");
      state.baseUrl = value;
    },
    setClientDirectory: (value) => {
      calls.push("setClientDirectory");
      state.clientDirectory = value;
    },
    setError: () => calls.push("setError"),
    setBusy: () => calls.push("setBusy"),
    setBusyLabel: () => calls.push("setBusyLabel"),
    setBusyStartedAt: () => calls.push("setBusyStartedAt"),
    setSseConnected: () => calls.push("setSseConnected"),
    setTab: () => calls.push("setTab"),
    setView: () => calls.push("setView"),
    setOpencodeConnectStatus: () => calls.push("setOpencodeConnectStatus"),
    loadSessions: async () => {
      calls.push("loadSessions");
    },
    refreshPendingPermissions: async () => {
      calls.push("refreshPendingPermissions");
    },
    onEngineStable: () => calls.push("onEngineStable"),
    wsDebug: () => undefined,
    ...overrides,
  };

  return { calls, state, deps };
}

test("stale local connect after routing ensure does not publish global UI state", async () => {
  const harness = createDeps();
  const controller = createWorkspaceConnectionController({
    ...harness.deps,
    routing: {
      ...harness.deps.routing,
      ensure: async (workspaceId, baseUrl, options) => {
        harness.calls.push("routing.ensure");
        harness.state.activeWorkspaceId = "ws-b";
        harness.state.activeWorkspaceRoot = "/b";
        return fakeEntry({
          workspaceId,
          clientId: "client-a",
          baseUrl,
          directory: options?.directory ?? "/a",
        });
      },
    },
  });

  const ok = await controller.connectToServer(
    "http://engine-a",
    "/a",
    { workspaceId: "ws-a", workspaceType: "local", targetRoot: "/a", reason: "activate" },
  );

  assert.equal(ok, false);
  assert.deepEqual(
    harness.calls.filter((call) =>
      ["setClient", "setBaseUrl", "setClientDirectory", "loadSessions", "refreshPendingPermissions", "onEngineStable"].includes(call),
    ),
    [],
  );
});

test("quiet port rotation only binds the routed proxy client without global disconnect churn", async () => {
  const harness = createDeps({
    activeWorkspaceId: () => "ws-a",
    activeWorkspaceRoot: () => "/a",
  });
  const controller = createWorkspaceConnectionController(harness.deps);

  const ok = await controller.connectToServer(
    "http://engine-a",
    "/a",
    { workspaceId: "ws-a", workspaceType: "local", targetRoot: "/a", reason: "port-rotation" },
    undefined,
    { quiet: true, navigate: false, forceRefresh: true },
  );

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "routing.ensure",
    "setClient",
    "setConnectedVersion",
    "setBaseUrl",
    "setClientDirectory",
  ]);
});

test("idempotent connect rebinds the global client to the target workspace route", async () => {
  const clientA = fakeClient("client-a");
  const clientB = fakeClient("client-b");
  const harness = createDeps();
  harness.state.activeWorkspaceId = "ws-b";
  harness.state.activeWorkspaceRoot = "/b";
  harness.state.baseUrl = "http://engine";
  harness.state.clientDirectory = "/b";
  harness.state.client = clientA;
  const controller = createWorkspaceConnectionController({
    ...harness.deps,
    routing: {
      ...harness.deps.routing,
      client: (workspaceId?: string) => workspaceId === "ws-b" ? clientB : null,
    },
  });

  const ok = await controller.connectToServer(
    "http://engine",
    "/b",
    { workspaceId: "ws-b", workspaceType: "local", targetRoot: "/b", reason: "activate" },
  );

  assert.equal(ok, true);
  assert.equal(harness.state.client, clientB);
  assert.deepEqual(
    harness.calls.filter((call) => call === "routing.ensure"),
    [],
    "idempotent rebind should not perform a fresh routing ensure",
  );
  assert.ok(harness.calls.includes("setClient"));
});
