import assert from "node:assert/strict";
import test from "node:test";

import {
  createSendRuntimeReadiness,
  isLocalRuntimeHealthTimeoutError,
  localRuntimeHealthTimeoutMessage,
  managedAiRuntimeAuthorizationNotReadyMessage,
  managedAiRuntimeConfigNotReadyMessage,
  shouldRecoverLocalRuntimeFromHealthError,
  withLocalRuntimeHealthTimeout,
  type SendRuntimePreflightContext,
  type SendRuntimeReadinessDeps,
} from "../../context/send-runtime-readiness.js";

type TestClient = {
  id: string;
  global: {
    health: () => Promise<unknown>;
  };
};

type HarnessOverrides = Partial<SendRuntimeReadinessDeps<TestClient>>;

function createClient(
  id: string,
  health: () => Promise<unknown> = async () => ({}),
): TestClient {
  return {
    id,
    global: { health },
  };
}

function createHarness(overrides: HarnessOverrides = {}) {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> =
    [];
  const errors: string[] = [];
  const engineReadyValues: boolean[] = [];
  const sseConnectedValues: boolean[] = [];
  const ensureEngineCalls: Array<string | undefined> = [];
  const routeReleaseCalls: string[] = [];
  const connectCalls: Array<{
    baseUrl: string;
    directory: string | undefined;
    metadata: unknown;
    auth: Record<string, string> | undefined;
    options: unknown;
  }> = [];
  const engineInfoCalls: Array<{
    workspaceId: string | undefined;
    workspaceRoot: string | undefined;
  }> = [];
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
    routedClient: (workspaceId?: string) =>
      clients.get(workspaceId ?? "active") ?? null,
    releaseWorkspaceRoute: (workspaceId: string) => {
      routeReleaseCalls.push(workspaceId);
      clients.delete(workspaceId);
    },
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
      return {
        running: true,
        engineState: "ready",
        baseUrl: "http://127.0.0.1:53553",
      };
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
    safeStringify: (value) => JSON.stringify(value),
    ...overrides,
  };

  return {
    readiness: createSendRuntimeReadiness(deps),
    deps,
    clients,
    events,
    errors,
    engineReadyValues,
    sseConnectedValues,
    ensureEngineCalls,
    routeReleaseCalls,
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

test("managed AI bootstrap primes runtime gateway authorization for a usable managed config", async () => {
  const order: string[] = [];
  const { readiness } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async () => {
      order.push("config-check");
      return true;
    },
    ensureManagedAiRuntimeAuthorizationForSend: async () => {
      order.push("auth-prime");
      return true;
    },
    waitForManagedAiBootstrapReady: async () => {
      order.push("wait");
    },
  });

  assert.equal(await readiness.ensureManagedAiBootstrapReady(), true);
  assert.deepEqual(order, ["config-check", "auth-prime", "wait"]);
});

test("managed AI bootstrap blocks when runtime gateway authorization cannot be primed", async () => {
  const waits: string[] = [];
  const { readiness, errors } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async () => true,
    ensureManagedAiRuntimeAuthorizationForSend: async () => false,
    waitForManagedAiBootstrapReady: async () => {
      waits.push("wait");
    },
  });

  assert.equal(await readiness.ensureManagedAiBootstrapReady(), false);
  assert.deepEqual(waits, []);
  assert.deepEqual(errors, [managedAiRuntimeAuthorizationNotReadyMessage]);
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

test("managed AI bootstrap readiness blocks managed sends when runtime config is not usable", async () => {
  const waits: Array<{ hasManagedProfile: boolean }> = [];
  const { readiness, errors } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    managedAiAccessBusy: () => false,
    managedAiBootstrapBusy: () => false,
    hasUsableManagedAiRuntimeConfigForSend: async () => false,
    waitForManagedAiBootstrapReady: async (options) => {
      waits.push({ hasManagedProfile: options.hasManagedProfile });
    },
  });

  assert.equal(await readiness.ensureManagedAiBootstrapReady(), false);
  assert.deepEqual(waits, []);
  assert.deepEqual(errors, [managedAiRuntimeConfigNotReadyMessage]);
});

test("managed AI bootstrap syncs the snapshotted workspace config before blocking", async () => {
  const targets: Array<SendRuntimePreflightContext["targetWorkspace"]> = [];
  const syncTargets: Array<SendRuntimePreflightContext["targetWorkspace"]> = [];
  let configReady = false;
  const { readiness, errors, events, clients } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async (targetWorkspace) => {
      targets.push(targetWorkspace);
      return configReady;
    },
    syncManagedAiRuntimeConfigForSend: async (targetWorkspace) => {
      syncTargets.push(targetWorkspace);
      configReady = true;
    },
  });
  clients.set("target", createClient("target"));

  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-managed-sync",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
  };

  assert.equal(await readiness.ensureManagedAiBootstrapReady(preflight), true);
  assert.deepEqual(targets, [
    preflight.targetWorkspace,
    preflight.targetWorkspace,
  ]);
  assert.deepEqual(syncTargets, [preflight.targetWorkspace]);
  assert.deepEqual(errors, []);
  assert.ok(
    events.some(
      (entry) => entry.event === "managed-ai-bootstrap-config-sync:start",
    ),
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "managed-ai-bootstrap-config-sync:end" &&
        entry.payload?.canUseCurrentManagedConfig === true,
    ),
  );
});

test("managed AI send preflight revalidates a config that is already usable", async () => {
  const syncTargets: Array<SendRuntimePreflightContext["targetWorkspace"]> = [];
  const { readiness, errors, events } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async () => true,
    syncManagedAiRuntimeConfigForSend: async (targetWorkspace) => {
      syncTargets.push(targetWorkspace);
    },
  });
  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-managed-freshness",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
  };

  assert.equal(await readiness.ensureManagedAiBootstrapReady(preflight), true);

  assert.deepEqual(syncTargets, [preflight.targetWorkspace]);
  assert.deepEqual(errors, []);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "managed-ai-bootstrap-config-sync:start" &&
        entry.payload?.freshnessRevalidation === true,
    ),
  );
});

test("managed AI bootstrap readiness validates the snapshotted target workspace config", async () => {
  const targets: Array<
    | {
        workspaceId?: string | null;
        workspaceRoot?: string | null;
        directory?: string | null;
      }
    | null
    | undefined
  > = [];
  const waits: Array<{ hasClient: boolean }> = [];
  const { readiness, clients } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async (targetWorkspace) => {
      targets.push(targetWorkspace);
      return true;
    },
    waitForManagedAiBootstrapReady: async (options) => {
      waits.push({ hasClient: options.hasClient() });
    },
  });
  clients.set("target", createClient("target"));

  const preflight = {
    traceId: "trace-managed-target",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(await readiness.ensureManagedAiBootstrapReady(preflight), true);
  assert.deepEqual(targets, [preflight.targetWorkspace]);
  assert.deepEqual(waits, [{ hasClient: true }]);
});

test("send runtime readiness owner prepares runtime before managed AI bootstrap", async () => {
  const order: string[] = [];
  const waits: Array<{ hasClient: boolean }> = [];
  const { readiness, clients } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async () => {
      order.push("managed-config-check");
      return true;
    },
    waitForManagedAiBootstrapReady: async (options) => {
      order.push("managed-bootstrap-wait");
      waits.push({ hasClient: options.hasClient() });
    },
    sendTraceStep: async (event, run) => {
      order.push(`trace-start:${event}`);
      const result = await run();
      order.push(`trace-end:${event}`);
      return result;
    },
  });
  clients.set(
    "target",
    createClient("target", async () => {
      order.push("runtime-health");
      return {};
    }),
  );

  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-prepare",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.deepEqual(
    await readiness.prepareSendRuntimeForSend("sendPrompt", preflight),
    {
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
      workspaceId: "target",
      activeWorkspace: false,
      recoveryAttempted: false,
      reason: "runtime-health-ok",
    },
  );
  assert.equal(preflight.runtimeHealthOk, true);
  assert.equal(preflight.enginePrepared, true);
  assert.equal(preflight.managedAiReady, true);
  assert.deepEqual(waits, [{ hasClient: true }]);
  assert.ok(
    order.indexOf("trace-start:sendPrompt:ensure-local-runtime-reachable") <
      order.indexOf("trace-start:sendPrompt:ensure-managed-ai-bootstrap-ready"),
    "runtime reachability should be prepared before managed AI bootstrap",
  );
  assert.ok(
    order.indexOf("runtime-health") < order.indexOf("managed-config-check"),
    "managed AI routing should be validated only after runtime health succeeds",
  );
});

test("send runtime readiness owner blocks managed AI bootstrap when runtime recovery fails", async () => {
  const managedConfigChecks: unknown[] = [];
  const { readiness, events, ensureEngineCalls } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    ensureEngineForWorkspace: async (workspaceId?: string) => {
      ensureEngineCalls.push(workspaceId);
      return false;
    },
    hasUsableManagedAiRuntimeConfigForSend: async (targetWorkspace) => {
      managedConfigChecks.push(targetWorkspace);
      return true;
    },
  });

  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-prepare-blocked",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.deepEqual(
    await readiness.prepareSendRuntimeForSend("sendPrompt", preflight),
    {
      ok: false,
      runtimeReady: false,
      managedAiReady: false,
      workspaceId: "target",
      activeWorkspace: false,
      recoveryAttempted: true,
      reason: "runtime-recovery-not-started",
    },
  );
  assert.deepEqual(ensureEngineCalls, ["target", "target", "target"]);
  assert.deepEqual(managedConfigChecks, []);
  assert.equal(preflight.enginePrepared, undefined);
  assert.equal(preflight.managedAiReady, undefined);
  assert.ok(
    events.some(
      (entry) => entry.event === "sendPrompt:blocked-runtime-unreachable",
    ),
  );
});

test("send runtime readiness retries foreground recovery after a shared warmup fails without a route", async () => {
  const { readiness, clients, events, ensureEngineCalls } = createHarness({
    ensureEngineForWorkspace: async (workspaceId?: string) => {
      ensureEngineCalls.push(workspaceId);
      if (ensureEngineCalls.length <= 2) return false;
      clients.set("target", createClient("target-recovered"));
      return true;
    },
  });

  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-retry-after-warmup",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(ensureEngineCalls, ["target", "target", "target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "sendPrompt:runtime-recovery-first-attempt-not-started",
    ),
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "sendPrompt:runtime-recovery-ok" &&
        entry.payload?.retryAttempted === true,
    ),
  );
});

test("send runtime readiness owner blocks managed AI when runtime routing config is unusable", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, errors, events } = createHarness({
    managedAiAccess: () => ({ providerId: "codex_oauth" }),
    hasUsableManagedAiRuntimeConfigForSend: async () => false,
  });
  clients.set(
    "target",
    createClient("target", async () => {
      healthCalls.push("target");
      return {};
    }),
  );

  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-prepare-managed-blocked",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.deepEqual(
    await readiness.prepareSendRuntimeForSend("sendPrompt", preflight),
    {
      ok: false,
      runtimeReady: true,
      managedAiReady: false,
      workspaceId: "target",
      activeWorkspace: false,
      recoveryAttempted: false,
      reason: "managed-ai-bootstrap-blocked",
    },
  );
  assert.deepEqual(healthCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.equal(preflight.enginePrepared, true);
  assert.equal(preflight.managedAiReady, undefined);
  assert.deepEqual(errors, [managedAiRuntimeConfigNotReadyMessage]);
  assert.ok(
    events.some(
      (entry) => entry.event === "sendPrompt:blocked-managed-ai-bootstrap",
    ),
  );
});

test("local runtime readiness probes the snapshotted target workspace client", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, engineReadyValues } =
    createHarness();
  clients.set(
    "target",
    createClient("target", async () => healthCalls.push("target")),
  );

  const preflight = {
    traceId: "trace-target",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(healthCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, []);
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-health-ok"),
  );
});

test("local runtime readiness marks the active workspace engine ready after a successful health probe", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, engineReadyValues, ensureEngineCalls } =
    createHarness();
  clients.set(
    "active",
    createClient("active", async () => healthCalls.push("active")),
  );

  const preflight = {
    traceId: "trace-active",
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(healthCalls, ["active"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, [true]);
});

test("local runtime readiness recovers when global health passes but engine info is not ready", async () => {
  const healthCalls: string[] = [];
  const {
    readiness,
    clients,
    engineInfoCalls,
    ensureEngineCalls,
    routeReleaseCalls,
    events,
  } = createHarness({
    engineInfo: async (workspaceId?: string, workspaceRoot?: string) => {
      engineInfoCalls.push({ workspaceId, workspaceRoot });
      return {
        running: false,
        engineState: "failed",
        baseUrl: "http://127.0.0.1:53553",
      };
    },
    ensureEngineForWorkspace: async (workspaceId?: string) => {
      ensureEngineCalls.push(workspaceId);
      clients.set("target", createClient("target-recovered"));
      return true;
    },
  });
  clients.set(
    "target",
    createClient("target", async () => healthCalls.push("target")),
  );

  const preflight = {
    traceId: "trace-chain-not-ready",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(healthCalls, ["target"]);
  assert.deepEqual(engineInfoCalls, [
    { workspaceId: "target", workspaceRoot: "/repo/target" },
  ]);
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-health-error"),
  );
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-recovery-ok"),
  );
});

test("local runtime readiness skips duplicate health probes when preflight is already healthy", async () => {
  const healthCalls: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, engineReadyValues } =
    createHarness();
  clients.set(
    "target",
    createClient("target", async () => healthCalls.push("target")),
  );

  const preflight = {
    traceId: "trace-skip",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: true,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend(
      "createSessionAndOpen",
      preflight,
    ),
    true,
  );
  assert.deepEqual(healthCalls, []);
  assert.deepEqual(ensureEngineCalls, []);
  assert.deepEqual(engineReadyValues, []);
  assert.ok(
    events.some(
      (entry) => entry.event === "createSessionAndOpen:runtime-health-skip",
    ),
  );
});

test("local runtime readiness joins cold bootstrap before forcing recovery for a missing client", async () => {
  const ensureOptions: Array<{
    workspaceId: string | undefined;
    options: unknown;
  }> = [];
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId, options) => {
        ensureEngineCalls.push(workspaceId);
        ensureOptions.push({ workspaceId, options });
        clients.set("target", createClient("target-after-bootstrap"));
        return true;
      },
    });
  clients.delete("target");

  const preflight = {
    traceId: "trace-bootstrap-join",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend(
      "createSessionAndOpen",
      preflight,
    ),
    true,
  );
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.deepEqual(ensureOptions, [
    {
      workspaceId: "target",
      options: {
        reason: "createSessionAndOpen-runtime-initial-ensure",
        loadSessions: false,
      },
    },
  ]);
  assert.deepEqual(routeReleaseCalls, []);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "createSessionAndOpen:runtime-initial-ensure-ready",
    ),
  );
  assert.ok(
    !events.some(
      (entry) => entry.event === "createSessionAndOpen:runtime-recovery-start",
    ),
  );
});

test("local runtime readiness restarts the target workspace engine for dead endpoints", async () => {
  const {
    readiness,
    clients,
    events,
    ensureEngineCalls,
    routeReleaseCalls,
    engineReadyValues,
    sseConnectedValues,
  } = createHarness({
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
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(engineReadyValues, []);
  assert.deepEqual(sseConnectedValues, []);
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-recovery-start"),
  );
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-recovery-ok"),
  );
});

test("local runtime readiness recovers when health throws engine_not_running", async () => {
  const order: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      releaseWorkspaceRoute: (workspaceId: string) => {
        order.push(`release:${workspaceId}`);
        routeReleaseCalls.push(workspaceId);
        clients.delete(workspaceId);
      },
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        order.push(`ensure:${workspaceId ?? ""}`);
        ensureEngineCalls.push(workspaceId);
        clients.set("target", createClient("target-recovered"));
        return true;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw new Error('{"error":"engine_not_running","workspaceId":"target"}');
    }),
  );

  const preflight = {
    traceId: "trace-engine-not-running-thrown",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.deepEqual(order, ["release:target", "ensure:target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-recovery-start"),
  );
  assert.ok(
    events.some((entry) => entry.event === "sendPrompt:runtime-recovery-ok"),
  );
});

test("local runtime readiness does not continue when ensure fails even if a route appears", async () => {
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        ensureEngineCalls.push(workspaceId);
        clients.set("target", createClient("target-racy-route"));
        return false;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw new Error('{"error":"orchestrator daemon is not running"}');
    }),
  );

  const preflight = {
    traceId: "trace-racy-route",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    false,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, false);
  const notStarted = events.find(
    (entry) => entry.event === "sendPrompt:runtime-recovery-not-started",
  );
  assert.equal(notStarted?.payload?.started, false);
  assert.equal(notStarted?.payload?.hasClient, true);
});

test("local runtime readiness recovers when health resolves an SDK engine_not_running error result", async () => {
  const { readiness, clients, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        ensureEngineCalls.push(workspaceId);
        clients.set("target", createClient("target-recovered"));
        return true;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => ({
      error: { error: "engine_not_running", workspaceId: "target" },
      response: { status: 503 },
    })),
  );

  const preflight = {
    traceId: "trace-engine-not-running-result",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
});

test("local runtime readiness recovers when health reports workspace not found", async () => {
  const order: string[] = [];
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      releaseWorkspaceRoute: (workspaceId: string) => {
        order.push(`release:${workspaceId}`);
        routeReleaseCalls.push(workspaceId);
        clients.delete(workspaceId);
      },
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        order.push(`ensure:${workspaceId ?? ""}`);
        ensureEngineCalls.push(workspaceId);
        clients.set("target", createClient("target-recovered"));
        return true;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => ({
      error: { error: "workspace not found", workspaceId: "target" },
      response: { status: 404 },
    })),
  );

  const preflight = {
    traceId: "trace-workspace-not-found",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.deepEqual(order, ["release:target", "ensure:target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  const healthError = events.find(
    (entry) => entry.event === "sendPrompt:runtime-health-error",
  );
  assert.equal(healthError?.payload?.recoverable, true);
  assert.equal(healthError?.payload?.recoverByDefault, false);
});

test("local runtime readiness recovers by default when routed health fails with an unclassified error", async () => {
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
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
      throw new Error("permission denied");
    }),
  );

  const preflight = {
    traceId: "trace-default-recovery",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
  const healthError = events.find(
    (entry) => entry.event === "sendPrompt:runtime-health-error",
  );
  assert.equal(healthError?.payload?.recoverable, false);
  assert.equal(healthError?.payload?.recoverByDefault, true);
});

test("local runtime readiness blocks when workspace-not-found recovery cannot restore a route", async () => {
  const { readiness, clients, events, ensureEngineCalls, routeReleaseCalls } =
    createHarness({
      ensureEngineForWorkspace: async (workspaceId?: string) => {
        ensureEngineCalls.push(workspaceId);
        return false;
      },
    });
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw new Error('{"error":"workspace not found","workspaceId":"target"}');
    }),
  );

  const preflight = {
    traceId: "trace-workspace-not-found-unrestored",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    false,
  );
  assert.deepEqual(routeReleaseCalls, ["target"]);
  assert.deepEqual(ensureEngineCalls, ["target", "target"]);
  assert.equal(preflight.runtimeHealthOk, false);
  const notStarted = events.find(
    (entry) => entry.event === "sendPrompt:runtime-recovery-not-started",
  );
  assert.equal(notStarted?.payload?.retryAttempted, true);
  assert.equal(notStarted?.payload?.retryStarted, false);
  assert.equal(notStarted?.payload?.retryHasClient, false);
});

test("local runtime readiness reflects route state only for the active workspace", async () => {
  const {
    readiness,
    clients,
    ensureEngineCalls,
    engineReadyValues,
    sseConnectedValues,
  } = createHarness({
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

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(ensureEngineCalls, [undefined]);
  assert.equal(preflight.runtimeHealthOk, true);
  assert.deepEqual(engineReadyValues, [false]);
  assert.deepEqual(sseConnectedValues, [false]);
});

test("local runtime readiness returns a typed preparation result after successful recovery", async () => {
  const { readiness, clients, ensureEngineCalls } = createHarness({
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

  assert.deepEqual(
    await readiness.ensureLocalRuntimeReachableForSendResult(
      "replaceUserMessage",
      {
        traceId: "trace-active-recovery-cleanup",
        runtimeHealthOk: false,
      },
    ),
    {
      ok: true,
      runtimeReady: true,
      managedAiReady: false,
      workspaceId: "active",
      activeWorkspace: true,
      recoveryAttempted: true,
      reason: "runtime-recovery-ok",
    },
  );

  assert.deepEqual(ensureEngineCalls, [undefined]);
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
  const error = { message: "ECONNREFUSED" } as {
    message: string;
    self?: unknown;
  };
  error.self = error;
  clients.set(
    "target",
    createClient("target-stale", async () => {
      throw error;
    }),
  );

  const preflight = {
    traceId: "trace-circular-recovery",
    targetWorkspace: {
      workspaceId: "target",
      workspaceRoot: "/repo/target",
      directory: "/repo/target",
    },
    runtimeHealthOk: false,
  };

  assert.equal(
    await readiness.ensureLocalRuntimeReachableForSend("sendPrompt", preflight),
    true,
  );
  assert.deepEqual(ensureEngineCalls, ["target"]);
  assert.equal(preflight.runtimeHealthOk, true);
});

test("engine-info reconnect scopes the lookup and connection to the active local workspace", async () => {
  const reconnectedClient = createClient("reconnected");
  const {
    readiness,
    clients,
    connectCalls,
    engineInfoCalls,
    engineReadyValues,
  } = createHarness({
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

  assert.equal(
    await readiness.connectLocalRuntimeClientFromEngineInfo(
      "replaceUserMessage",
    ),
    reconnectedClient,
  );
  assert.deepEqual(engineInfoCalls, [
    { workspaceId: "active", workspaceRoot: "/repo/active" },
  ]);
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
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(new Error("failed to fetch")),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(new Error("ECONNREFUSED")),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"error":"engine_not_running"}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"error":"engine_starting","engineState":"starting"}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"error":"engine_not_running","workspaceId":"target"}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"error":"workspace not found"}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error("workspace_registry_unsynced"),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error("workspace_id_mismatch"),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error("Unauthorized: Invalid bearer token"),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"code":"unauthorized","message":"Invalid bearer token"}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error('{"error":"opencode_request_failed","status":503}'),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(
      new Error("OpenCode health returned status 404"),
    ),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(new Error('{"status":404}')),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(new Error("upstream status 502")),
    true,
  );
  assert.equal(
    shouldRecoverLocalRuntimeFromHealthError(new Error("permission denied")),
    false,
  );
  assert.equal(
    isLocalRuntimeHealthTimeoutError(
      new Error(localRuntimeHealthTimeoutMessage),
    ),
    true,
  );
});

test("local runtime health timeout callback marks a visible timeout", async () => {
  let timedOut = false;

  await assert.rejects(
    () =>
      withLocalRuntimeHealthTimeout(new Promise(() => undefined), 1, () => {
        timedOut = true;
      }),
    new RegExp(localRuntimeHealthTimeoutMessage),
  );

  assert.equal(timedOut, true);
});
