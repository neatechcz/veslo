import assert from "node:assert/strict";
import test from "node:test";

import {
  createSendRuntimeReadiness,
  isLocalRuntimeHealthTimeoutError,
  localRuntimeHealthTimeoutMessage,
  shouldRecoverLocalRuntimeFromHealthError,
  type SendRuntimeReadinessDeps,
} from "../../context/send-runtime-readiness.js";

type TestClient = {
  id: string;
  global: {
    health: () => Promise<unknown>;
  };
};

type HarnessOverrides = Partial<SendRuntimeReadinessDeps<TestClient>>;

function createClient(id: string, health: () => Promise<unknown> = async () => ({})): TestClient {
  return {
    id,
    global: { health },
  };
}

function createHarness(overrides: HarnessOverrides = {}) {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const busyValues: boolean[] = [];
  const busyLabels: Array<string | null> = [];
  const engineReadyValues: boolean[] = [];
  const sseConnectedValues: boolean[] = [];
  const ensureEngineCalls: Array<string | undefined> = [];
  const connectCalls: Array<{
    baseUrl: string;
    directory: string | undefined;
    metadata: unknown;
    auth: Record<string, string> | undefined;
    options: unknown;
  }> = [];
  const engineInfoCalls: Array<{ workspaceId: string | undefined; workspaceRoot: string | undefined }> = [];
  const clients = new Map<string, TestClient | null>();
  const activeClient = createClient("active");
  clients.set("active", activeClient);

  const deps: SendRuntimeReadinessDeps<TestClient> = {
    isTauriRuntime: () => true,
    activeWorkspaceDisplay: () => ({
      id: "active",
      workspaceType: "local",
      path: "/repo/active",
      directory: "/repo/active",
    }),
    activeWorkspaceId: () => "active",
    activeWorkspaceRoot: () => "/repo/active",
    clientDirectory: () => "/repo/client",
    workspaces: () => [
      {
        id: "active",
        workspaceType: "local",
        path: "/repo/active",
        directory: "/repo/active",
      },
      {
        id: "target",
        workspaceType: "local",
        path: "/repo/target",
        directory: "/repo/target",
      },
    ],
    routedClient: (workspaceId?: string) => clients.get(workspaceId ?? "active") ?? null,
    ensureEngineForWorkspace: async (workspaceId?: string) => {
      ensureEngineCalls.push(workspaceId);
      return true;
    },
    connectToServer: async (baseUrl, directory, metadata, auth, options) => {
      connectCalls.push({ baseUrl, directory, metadata, auth, options });
      return true;
    },
    engineInfo: async (workspaceId?: string, workspaceRoot?: string) => {
      engineInfoCalls.push({ workspaceId, workspaceRoot });
      return { running: false, baseUrl: null };
    },
    managedAiAccess: () => null,
    managedAiAccessBusy: () => false,
    managedAiBootstrapBusy: () => false,
    managedAiBootstrapPendingCount: () => 0,
    reloadBusy: () => false,
    hasUsableManagedAiRuntimeConfigForSend: async () => false,
    waitForManagedAiBootstrapReady: async () => undefined,
    sendTraceStep: async (_event, run) => run(),
    recordSendTrace: (event, payload) => events.push({ event, payload }),
    setError: (message) => errors.push(message),
    setEngineReady: (value) => engineReadyValues.push(value),
    setSseConnected: (value) => sseConnectedValues.push(value),
    setBusy: (value) => busyValues.push(value),
    setBusyLabel: (value) => busyLabels.push(value),
    setBusyStartedAt: () => undefined,
    safeStringify: (value) => JSON.stringify(value),
    ...overrides,
  };

  return {
    readiness: createSendRuntimeReadiness(deps),
    deps,
    clients,
    events,
    errors,
    busyValues,
    busyLabels,
    engineReadyValues,
    sseConnectedValues,
    ensureEngineCalls,
    connectCalls,
    engineInfoCalls,
  };
}

test("managed AI bootstrap readiness can use a validated runtime config while access refresh is busy", async () => {
  const waits: Array<{ hasManagedProfile: boolean; hasClient: boolean }> = [];
  const { readiness, errors } = createHarness({
    managedAiAccessBusy: () => true,
    managedAiBootstrapBusy: () => true,
    hasUsableManagedAiRuntimeConfigForSend: async () => true,
    waitForManagedAiBootstrapReady: async (options) => {
      waits.push({
        hasManagedProfile: options.hasManagedProfile,
        hasClient: options.hasClient(),
      });
    },
  });

  assert.equal(await readiness.ensureManagedAiBootstrapReady(), true);
  assert.deepEqual(waits, [{ hasManagedProfile: false, hasClient: true }]);
  assert.deepEqual(errors, []);
});

test("managed AI bootstrap readiness waits when the current runtime config is not usable", async () => {
  const waits: Array<{ hasManagedProfile: boolean }> = [];
  const { readiness } = createHarness({
    managedAiAccessBusy: () => true,
    managedAiBootstrapBusy: () => true,
    hasUsableManagedAiRuntimeConfigForSend: async () => false,
    waitForManagedAiBootstrapReady: async (options) => {
      waits.push({ hasManagedProfile: options.hasManagedProfile });
    },
  });

  assert.equal(await readiness.ensureManagedAiBootstrapReady(), true);
  assert.deepEqual(waits, [{ hasManagedProfile: true }]);
});

test("local runtime readiness probes the snapshotted target workspace client", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, engineReadyValues } = createHarness();
  clients.set("target", createClient("target", async () => healthCalls.push("target")));

  const preflight = {
    traceId: "trace-target",
    targetWorkspace: { workspaceId: "target", workspaceRoot: "/repo/target", directory: "/repo/target" },
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight), true);
  assert.deepEqual(healthCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, []);
  assert.ok(events.some((entry) => entry.event === "sendPrompt:runtime-health-ok"));
});

test("local runtime readiness marks the active workspace engine ready after a successful health probe", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, engineReadyValues, ensureEngineCalls } = createHarness();
  clients.set("active", createClient("active", async () => healthCalls.push("active")));

  const preflight = {
    traceId: "trace-active",
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight), true);
  assert.deepEqual(healthCalls, ["active"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, [true]);
});

test("local runtime readiness skips duplicate health probes when preflight is already healthy", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, engineReadyValues } = createHarness();
  clients.set("target", createClient("target", async () => healthCalls.push("target")));

  const preflight = {
    traceId: "trace-skip",
    targetWorkspace: { workspaceId: "target", workspaceRoot: "/repo/target", directory: "/repo/target" },
    runtimeHealthOk: true,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("createSessionAndOpen", preflight), true);
  assert.deepEqual(healthCalls, []);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, []);
  assert.ok(events.some((entry) => entry.event === "createSessionAndOpen:runtime-health-skip"));
});

test("local runtime readiness restarts the target workspace engine for dead endpoints", async () => {
  const { readiness, clients, events, ensureEngineCalls, engineReadyValues, sseConnectedValues, busyValues, busyLabels } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        ensureEngineCalls.push(workspaceId);
        clients.set("target", createClient("target-recovered"));
        return true;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw new Error("ECONNREFUSED");
    }),
  );

  const preflight = {
    traceId: "trace-recovery",
    targetWorkspace: { workspaceId: "target", workspaceRoot: "/repo/target", directory: "/repo/target" },
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight), true);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(engineReadyValues, []);
  assert.deepEqual(sseConnectedValues, []);
  assert.deepEqual(busyValues, []);
  assert.deepEqual(busyLabels, []);
  assert.ok(events.some((entry) => entry.event === "sendPrompt:runtime-recovery-start"));
  assert.ok(events.some((entry) => entry.event === "sendPrompt:runtime-recovery-ok"));
});

test("local runtime readiness reflects recovery in active UI only for the active workspace", async () => {
  const { readiness, clients, ensureEngineCalls, engineReadyValues, sseConnectedValues, busyValues, busyLabels } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        ensureEngineCalls.push(workspaceId);
        clients.set("active", createClient("active-recovered"));
        return true;
      },
    });
  clients.set(
    "active",
    createClient("active-stale", async () => {
      throw new Error("ECONNREFUSED");
    }),
  );

  const preflight = {
    traceId: "trace-active-recovery",
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight), true);
  assert.deepEqual(ensureEngineCalls, [undefined]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(engineReadyValues, [false]);
  assert.deepEqual(sseConnectedValues, [false]);
  assert.deepEqual(busyValues, [true]);
  assert.deepEqual(busyLabels, ["status.connecting"]);
});

test("local runtime readiness classifies circular non-Error endpoint failures through the injected serializer", async () => {
  const { readiness, clients, ensureEngineCalls } = createHarness({
    safeStringify: (value) => {
      const seen = new WeakSet<object>();
      return JSON.stringify(value, (_key, entry) => {
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) return "<circular>";
          seen.add(entry);
        }
        return entry;
      });
    },
    ensureEngineForWorkspace: async (workspaceId?: string) => {
      ensureEngineCalls.push(workspaceId);
      clients.set("target", createClient("target-recovered"));
      return true;
    },
  });
  const error = { message: "ECONNREFUSED" } as { message: string; self?: unknown };
  error.self = error;
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw error;
    }),
  );

  const preflight = {
    traceId: "trace-circular-recovery",
    targetWorkspace: { workspaceId: "target", workspaceRoot: "/repo/target", directory: "/repo/target" },
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight), true);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
});

test("engine-info reconnect scopes the lookup and connection to the active local workspace", async () => {
  const reconnectedClient = createClient("reconnected");
  const { readiness, clients, connectCalls, engineInfoCalls, engineReadyValues } = createHarness({
    engineInfo: async (workspaceId?: string, workspaceRoot?: string) => {
      engineInfoCalls.push({ workspaceId, workspaceRoot });
      return {
        running: true,
        baseUrl: " http://127.0.0.1:45321 ",
        projectDir: " /repo/from-engine ",
        opencodeUsername: " user ",
        opencodePassword: " pass ",
      };
    },
    connectToServer: async (baseUrl, directory, metadata, auth, options) => {
      connectCalls.push({ baseUrl, directory, metadata, auth, options });
      clients.set("active", reconnectedClient);
      return true;
    },
  });

  assert.equal(await readiness.connectLocalRuntimeClientFromEngineInfo("replaceUserMessage"), reconnectedClient);
  assert.deepEqual(engineInfoCalls, [{ workspaceId: "active", workspaceRoot: "/repo/active" }]);
  assert.deepEqual(connectCalls, [
    {
      baseUrl: "http://127.0.0.1:45321",
      directory: "/repo/from-engine",
      metadata: {
        workspaceId: "active",
        workspaceType: "local",
        targetRoot: "/repo/from-engine",
        reason: "replaceUserMessage",
      },
      auth: { username: "user", password: "pass" },
      options: { quiet: true, navigate: false, forceRefresh: true },
    },
  ]);
  assert.deepEqual(engineReadyValues, [true]);
});

test("local runtime health error helpers classify dead endpoints and probe timeouts", () => {
  assert.equal(shouldRecoverLocalRuntimeFromHealthError(new Error("failed to fetch")), true);
  assert.equal(shouldRecoverLocalRuntimeFromHealthError(new Error("ECONNREFUSED")), true);
  assert.equal(shouldRecoverLocalRuntimeFromHealthError(new Error("permission denied")), false);
  assert.equal(isLocalRuntimeHealthTimeoutError(new Error(localRuntimeHealthTimeoutMessage)), true);
});
