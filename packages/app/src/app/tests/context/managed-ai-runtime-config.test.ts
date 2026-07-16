import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUsableManagedAiRuntimeConfig,
  type ManagedAiAccessProfile,
} from "../../lib/ai-access.js";
import { VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE } from "../../lib/opencode.js";
import type { ModelRef } from "../../types.js";
import {
  createManagedAiRuntimeConfigSync,
  type ManagedAiRuntimeConfigSyncOptions,
  type ManagedAiRuntimeConfigVesloClient,
} from "../../context/managed-ai-runtime-config.js";

const model: ModelRef = {
  providerID: "codex_oauth",
  modelID: "gpt-5",
};

const profile: ManagedAiAccessProfile = {
  userId: "user-1",
  providerId: "codex_oauth",
  effectiveModel: model,
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createVesloClient(): ManagedAiRuntimeConfigVesloClient & {
  patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }>;
  getConfigCalls: string[];
  listCalls: number;
} {
  const patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }> = [];
  const getConfigCalls: string[] = [];
  let listCalls = 0;
  return {
    baseUrl: "http://127.0.0.1:34115",
    token: "veslo-token",
    patched,
    getConfigCalls,
    get listCalls() {
      return listCalls;
    },
    getConfig: async (workspaceId) => {
      getConfigCalls.push(workspaceId);
      if (workspaceId === "ws-private") {
        throw new Error("Workspace is not authorized");
      }
      return { opencode: {} };
    },
    patchConfig: async (workspaceId, payload) => {
      patched.push({ workspaceId, payload });
      return { ok: true };
    },
    listWorkspaces: async () => {
      listCalls += 1;
      return {
        items: [
          { id: "ws-active", workspaceType: "local" },
          { id: "ws-private", workspaceType: "local" },
        ],
      };
    },
  };
}

function createOptions(
  overrides: Partial<ManagedAiRuntimeConfigSyncOptions> = {},
): ManagedAiRuntimeConfigSyncOptions {
  const vesloClient = createVesloClient();
  const options: ManagedAiRuntimeConfigSyncOptions = {
    effect: () => undefined,
    isTauriRuntime: () => true,
    workspaceDefaultModelReady: () => true,
    defaultModelExplicit: () => true,
    defaultModel: () => model,
    managedAiAccess: () => profile,
    managedAiAccessBusy: () => false,
    managedAiAccessError: () => null,
    managedAiGatewayAccessToken: () => "gateway-access-token",
    denGatewayAccessToken: () => "den-token",
    denOrgId: () => "org-1",
    denAuthRevision: () => 1,
    gatewayVesloServerClient: () => ({ baseUrl: "https://gateway.veslo.test", token: "gateway-token" }),
    vesloServerClient: () => vesloClient,
    vesloServerStatus: () => "connected",
    vesloServerWorkspaceId: () => "ws-active",
    resolvedVesloCapabilities: () => ({
      config: { read: true, write: true },
      sandbox: { enabled: false, backend: "none" },
    }),
    activeVesloServerRoutingInfo: () => ({
      baseUrl: "http://127.0.0.1:34115",
      engineUrl: "http://127.0.0.1:34116",
      clientToken: "local-client-token",
      hostToken: "local-host-token",
    }),
    baseUrl: () => "http://127.0.0.1:4096",
    activeWorkspaceDisplay: () => ({
      id: "ws-active",
      workspaceType: "local",
      path: "/repo",
      directory: "/repo",
    }),
    activeWorkspaceId: () => "ws-active",
    activeWorkspaceRoot: () => "/repo",
    activeWorkspacePath: () => "/repo",
    workspaces: () => [
      { id: "ws-active", workspaceType: "local", path: "/repo", directory: "/repo" },
      { id: "ws-private", workspaceType: "local", path: "/private", directory: "/private" },
    ],
    engine: () => ({ running: true, runtime: "direct", childKind: "direct", projectDir: "/repo" }),
    orchestratorStatusEngines: () => [],
    orchestratorEngines: () => [],
    resolveConversationServerWorkspaceId: (workspaceId) =>
      workspaceId === "ws-active" || workspaceId === "ws-private" ? workspaceId : null,
    ensureConversationReadWorkspaceRegistered: async () => "ws-active",
    readOpencodeConfig: async () => ({ content: "{}" }),
    writeOpencodeConfig: async () => ({ ok: true, stdout: "", stderr: "" }),
    markReloadRequired: () => undefined,
    anyActiveRuns: () => false,
    sendPromptInFlight: () => false,
    canReloadWorkspace: () => true,
    setError: () => undefined,
    reportError: () => undefined,
    addOpencodeCacheHint: (message) => message,
    safeStringify: (value) => JSON.stringify(value),
    recordManagedAiWorkflowTrace: () => undefined,
    createVesloServerClient: () => ({
      baseUrl: "http://127.0.0.1:34115",
      getMyAiAccess: async () => ({
        aiAccess: {
          id: "access-1",
          enabled: true,
          userId: profile.userId,
          provider: profile.providerId,
          effectiveModel: { provider: profile.providerId, model: profile.effectiveModel.modelID },
          updatedAt: profile.updatedAt,
        },
        accessToken: "runtime-access-token",
      }),
    }),
    applyManagedAiAccessProfile: () => undefined,
    setManagedAiAccessError: () => undefined,
    ...overrides,
  };
  return options;
}

test("runtime auth prime is single-flight and cached for a short success window", async () => {
  let now = 1_000;
  let accessCalls = 0;
  const firstAccessGate: { release?: () => void } = {};
  const traces: string[] = [];
  const accessArguments: Array<[string, string | undefined, string | undefined]> = [];
  const response = {
    aiAccess: {
      id: "access-1",
      enabled: true,
      userId: profile.userId,
      provider: profile.providerId,
      effectiveModel: { provider: profile.providerId, model: profile.effectiveModel.modelID },
      updatedAt: profile.updatedAt,
    },
    accessToken: "runtime-access-token",
  };

  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      now: () => now,
      runtimeAuthorizationPrimeSuccessTtlMs: 5_000,
      recordManagedAiWorkflowTrace: (event) => {
        traces.push(event);
      },
      createVesloServerClient: () => ({
        baseUrl: "http://127.0.0.1:34115",
        getMyAiAccess: async (userToken, orgId, workspaceId) => {
          accessArguments.push([userToken, orgId, workspaceId]);
          accessCalls += 1;
          if (accessCalls === 1) {
            await new Promise<void>((resolve) => {
              firstAccessGate.release = resolve;
            });
          }
          return response;
        },
      }),
    }),
  );

  const first = sync.ensureManagedAiRuntimeAuthorizationForSend();
  const second = sync.ensureManagedAiRuntimeAuthorizationForSend();
  await Promise.resolve();
  assert.equal(accessCalls, 1);
  assert.ok(traces.includes("managed-ai-runtime-auth-prime:join"));

  const releaseFirstAccess = firstAccessGate.release;
  if (typeof releaseFirstAccess !== "function") {
    throw new Error("first access was not awaited");
  }
  releaseFirstAccess();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(accessCalls, 1);

  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), true);
  assert.equal(accessCalls, 1);
  assert.ok(traces.includes("managed-ai-runtime-auth-prime:cache-hit"));

  sync.clearManagedAiRuntimeAuthorizationPrimeCache();
  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), true);
  assert.equal(accessCalls, 2);

  now = 7_001;
  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), true);
  assert.equal(accessCalls, 3);
  assert.deepEqual(accessArguments, [
    ["den-token", "org-1", "ws-active"],
    ["den-token", "org-1", "ws-active"],
    ["den-token", "org-1", "ws-active"],
  ]);
});

test("runtime auth prime records request diagnostics after the success cache expires", async () => {
  let now = 1_000;
  let accessCalls = 0;
  const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const accessErrors: Array<string | null> = [];
  const response = {
    aiAccess: {
      id: "access-1",
      enabled: true,
      userId: profile.userId,
      provider: profile.providerId,
      effectiveModel: { provider: profile.providerId, model: profile.effectiveModel.modelID },
      updatedAt: profile.updatedAt,
    },
    accessToken: "runtime-access-token",
  };

  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      now: () => now,
      runtimeAuthorizationPrimeSuccessTtlMs: 5_000,
      recordManagedAiWorkflowTrace: (event, payload) => {
        traces.push({ event, payload });
      },
      setManagedAiAccessError: (message) => {
        accessErrors.push(message);
      },
      createVesloServerClient: () => ({
        baseUrl: "http://127.0.0.1:34115",
        getMyAiAccess: async () => {
          accessCalls += 1;
          if (accessCalls === 1) return response;
          throw new Error("connect ETIMEDOUT");
        },
      }),
    }),
  );

  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), true);
  assert.equal(sync.lastManagedAiRuntimeAuthorizationPrimeDiagnostic(), null);

  now = 6_001;
  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), false);
  assert.equal(accessCalls, 2);
  assert.deepEqual(sync.lastManagedAiRuntimeAuthorizationPrimeDiagnostic(), {
    reason: "request-failed",
    supportMessage: "Managed AI runtime authorization could not be refreshed. Check the local Veslo server connection and retry.",
    message: "connect ETIMEDOUT",
  });
  assert.deepEqual(accessErrors, [
    "Managed AI runtime authorization could not be refreshed. Check the local Veslo server connection and retry.",
  ]);

  const errorTrace = traces.find((entry) => entry.event === "managed-ai-runtime-auth-prime:error");
  assert.equal(errorTrace?.payload.reason, "request-failed");
  assert.equal(errorTrace?.payload.message, "connect ETIMEDOUT");
});

test("runtime auth prime reports stable support diagnostics for missing user token", async () => {
  const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const accessErrors: Array<string | null> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      denGatewayAccessToken: () => "",
      recordManagedAiWorkflowTrace: (event, payload) => {
        traces.push({ event, payload });
      },
      setManagedAiAccessError: (message) => {
        accessErrors.push(message);
      },
    }),
  );

  assert.equal(await sync.ensureManagedAiRuntimeAuthorizationForSend(), false);
  assert.deepEqual(traces, [{
    event: "managed-ai-runtime-auth-prime:skip",
    payload: {
      reason: "missing-user-token",
      supportMessage: "Sign in again to refresh managed AI authorization before sending.",
    },
  }]);
  assert.deepEqual(accessErrors, ["Sign in again to refresh managed AI authorization before sending."]);
});

test("runtime config sync joins matching active and send-preflight work", async () => {
  const client = createVesloClient();
  const readGate = createDeferred<{ opencode?: Record<string, unknown> | null }>();
  const readStarted = createDeferred<void>();
  const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
  client.getConfig = async (workspaceId) => {
    client.getConfigCalls.push(workspaceId);
    readStarted.resolve();
    return await readGate.promise;
  };
  const sync = createManagedAiRuntimeConfigSync(createOptions({
    vesloServerClient: () => client,
    recordManagedAiWorkflowTrace: (event, payload) => traces.push({ event, payload }),
  }));

  const active = sync.syncActiveWorkspaceManagedAiConfig();
  await readStarted.promise;
  const send = sync.syncManagedAiRuntimeConfigForSend({
    workspaceId: "ws-active",
    workspaceRoot: "/repo",
  });
  await Promise.resolve();

  assert.deepEqual(client.getConfigCalls, ["ws-active"]);
  readGate.resolve({ opencode: {} });
  await Promise.all([active, send]);
  assert.equal(client.patched.length, 1);
  const flightActions = traces
    .filter((entry) => entry.event === "managed-ai-config-sync:flight")
    .map((entry) => entry.payload.action);
  assert.deepEqual(flightActions, ["start", "join", "settle"]);
});

test("runtime config sync changes semantic flight keys and retries a failed read", async () => {
  const client = createVesloClient();
  let defaultModel = model;
  let denAuthRevision = 1;
  let gatewayAccessToken = "gateway-access-token";
  let serverWorkspaceId = "ws-active";
  let configWriteCapable = true;
  let projectReads = 0;
  let failFirstRead = true;
  const flightActions: string[] = [];
  client.getConfig = async (workspaceId) => {
    client.getConfigCalls.push(workspaceId);
    if (failFirstRead) {
      failFirstRead = false;
      throw new Error("temporary config read failure");
    }
    return { opencode: {} };
  };
  const sync = createManagedAiRuntimeConfigSync(createOptions({
    vesloServerClient: () => client,
    defaultModel: () => defaultModel,
    denAuthRevision: () => denAuthRevision,
    managedAiGatewayAccessToken: () => gatewayAccessToken,
    resolveConversationServerWorkspaceId: () => serverWorkspaceId,
    ensureConversationReadWorkspaceRegistered: async () => serverWorkspaceId,
    resolvedVesloCapabilities: () => ({
      config: { read: true, write: configWriteCapable },
      sandbox: { enabled: false, backend: "none" },
    }),
    readOpencodeConfig: async () => {
      projectReads += 1;
      return { content: "{}" };
    },
    recordManagedAiWorkflowTrace: (event, payload) => {
      if (event === "managed-ai-config-sync:flight") {
        flightActions.push(String(payload.action));
      }
    },
  }));

  await sync.syncActiveWorkspaceManagedAiConfig();
  await sync.syncActiveWorkspaceManagedAiConfig();
  denAuthRevision += 1;
  await sync.syncActiveWorkspaceManagedAiConfig();
  gatewayAccessToken = "gateway-access-token-next";
  await sync.syncActiveWorkspaceManagedAiConfig();
  serverWorkspaceId = "ws-mapped";
  await sync.syncActiveWorkspaceManagedAiConfig();
  defaultModel = { providerID: "codex_oauth", modelID: "gpt-5.1" };
  await sync.syncActiveWorkspaceManagedAiConfig();
  configWriteCapable = false;
  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(client.getConfigCalls, [
    "ws-active",
    "ws-active",
    "ws-active",
    "ws-active",
    "ws-mapped",
    "ws-mapped",
  ]);
  assert.equal(projectReads, 1, "a changed config source must start its own project-config sync");
  assert.ok(flightActions.includes("reject"), "a failed config read must release its flight for retry");
});

test("a stale config sync cannot patch after a newer fingerprint completes", async () => {
  const client = createVesloClient();
  const firstRead = createDeferred<{ opencode?: Record<string, unknown> | null }>();
  const secondRead = createDeferred<{ opencode?: Record<string, unknown> | null }>();
  const firstStarted = createDeferred<void>();
  const secondStarted = createDeferred<void>();
  let currentProfile = profile;
  let readCount = 0;
  client.getConfig = async (workspaceId) => {
    client.getConfigCalls.push(workspaceId);
    readCount += 1;
    if (readCount === 1) {
      firstStarted.resolve();
      return await firstRead.promise;
    }
    secondStarted.resolve();
    return await secondRead.promise;
  };
  const sync = createManagedAiRuntimeConfigSync(createOptions({
    vesloServerClient: () => client,
    managedAiAccess: () => currentProfile,
  }));

  const first = sync.syncActiveWorkspaceManagedAiConfig();
  await firstStarted.promise;
  currentProfile = {
    ...profile,
    effectiveModel: { providerID: "codex_oauth", modelID: "gpt-5.1" },
    updatedAt: "2026-07-16T01:00:00.000Z",
  };
  const second = sync.syncActiveWorkspaceManagedAiConfig();
  await secondStarted.promise;
  secondRead.resolve({ opencode: {} });
  await second;
  firstRead.resolve({ opencode: {} });
  await first;

  assert.equal(client.patched.length, 1);
  assert.match(JSON.stringify(client.patched[0]?.payload.opencode ?? {}), /gpt-5\.1/);
});

test("runtime config sync writes managed provider config through project file path without reloading", async () => {
  const writes: Array<{ scope: string; root: string; content: string }> = [];
  const reloads: string[] = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => null,
      vesloServerStatus: () => "disconnected",
      resolvedVesloCapabilities: () => ({ config: { read: false, write: false } }),
      writeOpencodeConfig: async (scope, root, content) => {
        writes.push({ scope, root, content });
        return { ok: true, stdout: "", stderr: "" };
      },
      markReloadRequired: (_scope, change) => reloads.push(change.action),
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.scope, "project");
  assert.equal(writes[0]?.root, "/repo");
  assert.match(writes[0]?.content ?? "", /VESLO_OPENCODE_SERVER_CLIENT_TOKEN/);
  assert.match(writes[0]?.content ?? "", /127\.0\.0\.1:34116/);
  assert.deepEqual(reloads, ["updated"]);
});

test("runtime config sync writes managed provider config through Veslo server config path", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      vesloServerWorkspaceId: () => "ws-active",
      activeWorkspaceDisplay: () => ({
        id: "app-active",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
        vesloWorkspaceId: "ws-active",
      }),
      activeWorkspaceId: () => "app-active",
      resolveConversationServerWorkspaceId: () => "ws-active",
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "ws-active";
      },
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(registrations, []);
  assert.deepEqual(client.getConfigCalls, ["ws-active"]);
  assert.equal(client.patched.length, 1);
  assert.equal(client.patched[0]?.workspaceId, "ws-active");
  assert.equal(
    (((client.patched[0]?.payload.opencode?.provider as Record<string, unknown>)?.codex_oauth as Record<string, unknown>)
      ?.options as Record<string, unknown>)?.apiKey,
    VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  );
});

test("runtime config sync does not require a gateway bearer to write local provider routing", async () => {
  const client = createVesloClient();
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      managedAiGatewayAccessToken: () => "",
      denGatewayAccessToken: () => "",
      vesloServerWorkspaceId: () => "ws-active",
      resolveConversationServerWorkspaceId: () => "ws-active",
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(client.getConfigCalls, ["ws-active"]);
  assert.equal(client.patched.length, 1);
  const content = JSON.stringify(client.patched[0]?.payload.opencode ?? {});
  assert.equal(content.includes("x-veslo-gateway-token"), false);
  assert.equal(
    hasUsableManagedAiRuntimeConfig({
      content,
      providerId: profile.providerId,
      gatewayBaseUrl: "http://127.0.0.1:34116",
      serverClientToken: "local-client-token",
      workspaceId: "ws-active",
    }),
    true,
  );
  assert.equal(
    (((client.patched[0]?.payload.opencode?.provider as Record<string, unknown>)?.codex_oauth as Record<string, unknown>)
      ?.options as Record<string, unknown>)?.apiKey,
    VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  );
});

test("send preflight sync writes managed config for the snapshotted target workspace", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      activeWorkspaceDisplay: () => ({
        id: "app-active",
        workspaceType: "local",
        path: "/repo/active",
        directory: "/repo/active",
      }),
      activeWorkspaceId: () => "app-active",
      activeWorkspacePath: () => "/repo/active",
      workspaces: () => [
        { id: "app-active", workspaceType: "local", path: "/repo/active", directory: "/repo/active" },
        { id: "app-target", workspaceType: "local", path: "/repo/target", directory: "/repo/target" },
      ],
      resolveConversationServerWorkspaceId: (workspaceId) =>
        workspaceId === "app-active" ? "ws-active" : null,
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "server-target";
      },
    }),
  );

  await sync.syncManagedAiRuntimeConfigForSend({
    workspaceId: "app-target",
    workspaceRoot: "/repo/target",
    directory: "/repo/target",
  });

  assert.deepEqual(registrations, [{ workspaceId: "app-target", workspaceRoot: "/repo/target" }]);
  assert.deepEqual(client.getConfigCalls, ["server-target"]);
  assert.equal(client.patched.length, 1);
  assert.equal(client.patched[0]?.workspaceId, "server-target");
  assert.equal(
    (((client.patched[0]?.payload.opencode?.provider as Record<string, unknown>)?.codex_oauth as Record<string, unknown>)
      ?.options as Record<string, unknown>)?.apiKey,
    VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  );
});

test("runtime config sync registers local workspace before using fallback app id", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      activeWorkspaceDisplay: () => ({
        id: "app-local",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      }),
      activeWorkspaceId: () => "app-local",
      resolveConversationServerWorkspaceId: () => "app-local",
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "server-local";
      },
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(registrations, [{ workspaceId: "app-local", workspaceRoot: "/repo" }]);
  assert.deepEqual(client.getConfigCalls, ["server-local"]);
  assert.equal(client.patched[0]?.workspaceId, "server-local");
});

test("runtime config sync does not use fallback app id when local registration fails", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const fileWrites: Array<{ root: string; content: string }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      activeWorkspaceDisplay: () => ({
        id: "app-local",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      }),
      activeWorkspaceId: () => "app-local",
      resolveConversationServerWorkspaceId: () => "app-local",
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "";
      },
      writeOpencodeConfig: async (_scope, root, content) => {
        fileWrites.push({ root, content });
        return { ok: true, stdout: "", stderr: "" };
      },
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(registrations, [{ workspaceId: "app-local", workspaceRoot: "/repo" }]);
  assert.deepEqual(client.getConfigCalls, []);
  assert.deepEqual(client.patched, []);
  assert.equal(fileWrites[0]?.root, "/repo");
});

test("runtime config check registers local workspace before reading server config", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      activeWorkspaceDisplay: () => ({
        id: "app-local",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      }),
      activeWorkspaceId: () => "app-local",
      resolveConversationServerWorkspaceId: () => "app-local",
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "server-local";
      },
    }),
  );

  await sync.hasUsableManagedAiRuntimeConfigForSend({
    workspaceId: "app-local",
    workspaceRoot: "/repo",
    directory: "/repo",
  });

  assert.deepEqual(registrations, [{ workspaceId: "app-local", workspaceRoot: "/repo" }]);
  assert.deepEqual(client.getConfigCalls, ["server-local"]);
});

test("runtime config check does not read server config with fallback app id when local registration fails", async () => {
  const client = createVesloClient();
  const registrations: Array<{ workspaceId: string; workspaceRoot?: string | null }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      activeWorkspaceDisplay: () => ({
        id: "app-local",
        workspaceType: "local",
        path: "/repo",
        directory: "/repo",
      }),
      activeWorkspaceId: () => "app-local",
      resolveConversationServerWorkspaceId: () => "app-local",
      ensureConversationReadWorkspaceRegistered: async (_client, workspaceId, workspaceRoot) => {
        registrations.push({ workspaceId, workspaceRoot });
        return "";
      },
    }),
  );

  const ok = await sync.hasUsableManagedAiRuntimeConfigForSend({
    workspaceId: "app-local",
    workspaceRoot: "/repo",
    directory: "/repo",
  });

  assert.equal(ok, false);
  assert.deepEqual(registrations, [{ workspaceId: "app-local", workspaceRoot: "/repo" }]);
  assert.deepEqual(client.getConfigCalls, []);
});

test("inactive workspace heal marks unauthorized workspaces for the current token", async () => {
  const client = createVesloClient();
  const errors: string[] = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      reportError: (_error, scope) => errors.push(scope),
    }),
  );

  await sync.healInactiveManagedAiWorkspaceConfigs();
  await sync.healInactiveManagedAiWorkspaceConfigs();

  assert.deepEqual(errors, []);
  assert.deepEqual(client.getConfigCalls, ["ws-private"]);
  assert.deepEqual(client.patched, []);
});

test("inactive workspace heal keeps config tracking across managed access metadata refresh", async () => {
  const patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }> = [];
  const getConfigCalls: string[] = [];
  const effects: Array<() => void> = [];
  let currentProfile: ManagedAiAccessProfile = profile;
  const client: ManagedAiRuntimeConfigVesloClient = {
    baseUrl: "http://127.0.0.1:34115",
    token: "veslo-token",
    getConfig: async (workspaceId) => {
      getConfigCalls.push(workspaceId);
      return { opencode: {} };
    },
    patchConfig: async (workspaceId, payload) => {
      patched.push({ workspaceId, payload });
      return { ok: true };
    },
    listWorkspaces: async () => ({
      items: [
        { id: "ws-active", workspaceType: "local" },
        { id: "ws-inactive", workspaceType: "local" },
      ],
    }),
  };
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      effect: (fn) => {
        effects.push(fn);
      },
      vesloServerClient: () => client,
      managedAiAccess: () => currentProfile,
      vesloServerWorkspaceId: () => "ws-active",
      resolveConversationServerWorkspaceId: () => "ws-active",
    }),
  );
  const runResetEffect = () => {
    const resetEffect = effects[0];
    if (!resetEffect) throw new Error("managed AI reset effect was not registered");
    resetEffect();
  };

  runResetEffect();
  await sync.healInactiveManagedAiWorkspaceConfigs();

  currentProfile = {
    ...currentProfile,
    updatedAt: "2026-07-01T10:01:00.000Z",
  };
  runResetEffect();
  await sync.healInactiveManagedAiWorkspaceConfigs();

  assert.deepEqual(getConfigCalls, ["ws-inactive"]);
  assert.equal(patched.length, 1);

  currentProfile = { ...currentProfile, updatedAt: "2026-07-01T10:02:00.000Z" };
  runResetEffect();
  await sync.healInactiveManagedAiWorkspaceConfigs();

  assert.deepEqual(getConfigCalls, ["ws-inactive"]);
  assert.equal(patched.length, 1);
});

test("inactive workspace heal skips server scans while a send or run is active", async () => {
  for (const scenario of [
    { name: "send", anyActiveRuns: false, sendPromptInFlight: true },
    { name: "run", anyActiveRuns: true, sendPromptInFlight: false },
  ]) {
    const client = createVesloClient();
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const sync = createManagedAiRuntimeConfigSync(
      createOptions({
        vesloServerClient: () => client,
        anyActiveRuns: () => scenario.anyActiveRuns,
        sendPromptInFlight: () => scenario.sendPromptInFlight,
        recordManagedAiWorkflowTrace: (event, payload) => traces.push({ event, payload }),
      }),
    );

    await sync.healInactiveManagedAiWorkspaceConfigs();

    assert.equal(client.listCalls, 0, `${scenario.name} must not list workspaces`);
    assert.deepEqual(client.getConfigCalls, [], `${scenario.name} must not read inactive configs`);
    assert.deepEqual(client.patched, [], `${scenario.name} must not patch inactive configs`);
    assert.deepEqual(traces, [{
      event: "managed-baseurl.heal:skip",
      payload: {
        reason: "active-send-or-run",
        anyActiveRuns: scenario.anyActiveRuns,
        sendPromptInFlight: scenario.sendPromptInFlight,
      },
    }]);
  }
});

test("server config sync does not churn after a write when the next server read is stale", async () => {
  const client = createVesloClient();
  const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const readTime = Date.parse("2026-07-07T08:00:00.000Z");
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      vesloServerWorkspaceId: () => "ws-active",
      resolveConversationServerWorkspaceId: () => "ws-active",
      now: () => readTime,
      recordManagedAiWorkflowTrace: (event, payload) => traces.push({ event, payload }),
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();
  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.equal(client.patched.length, 1);
  assert.deepEqual(client.getConfigCalls, ["ws-active", "ws-active"]);
  const decisions = traces.filter((entry) => entry.event === "managed-ai-config-sync:managed-decision");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0]?.payload.decision, "write-managed-config");
  assert.equal(decisions[0]?.payload.configSource, "veslo-server-config");
  assert.equal(decisions[0]?.payload.vesloWorkspaceId, "ws-active");
  assert.equal(decisions[0]?.payload.readTimestamp, "2026-07-07T08:00:00.000Z");
  assert.equal(decisions[0]?.payload.cachedSnapshotMatches, false);
  assert.equal(decisions[0]?.payload.redactedServerConfigMatches, false);

  assert.equal(decisions[1]?.payload.decision, "skip");
  assert.equal(decisions[1]?.payload.reason, "managed-config-current");
  assert.equal(decisions[1]?.payload.configSource, "veslo-server-config");
  assert.equal(decisions[1]?.payload.vesloWorkspaceId, "ws-active");
  assert.equal(decisions[1]?.payload.readTimestamp, "2026-07-07T08:00:00.000Z");
  assert.equal(decisions[1]?.payload.cachedSnapshotMatches, true);
  assert.equal(decisions[1]?.payload.redactedServerConfigMatches, true);
  assert.equal(decisions[1]?.payload.compareSource, "last-known-snapshot");
});

test("inactive workspace heal does not require a gateway bearer to write local provider routing", async () => {
  const patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }> = [];
  const getConfigCalls: string[] = [];
  const client: ManagedAiRuntimeConfigVesloClient = {
    baseUrl: "http://127.0.0.1:34115",
    token: "veslo-token",
    getConfig: async (workspaceId) => {
      getConfigCalls.push(workspaceId);
      return { opencode: {} };
    },
    patchConfig: async (workspaceId, payload) => {
      patched.push({ workspaceId, payload });
      return { ok: true };
    },
    listWorkspaces: async () => ({
      items: [
        { id: "ws-active", workspaceType: "local" },
        { id: "ws-inactive", workspaceType: "local" },
      ],
    }),
  };
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      managedAiGatewayAccessToken: () => "",
      denGatewayAccessToken: () => "",
      vesloServerWorkspaceId: () => "ws-active",
      resolveConversationServerWorkspaceId: () => "ws-active",
    }),
  );

  await sync.healInactiveManagedAiWorkspaceConfigs();

  assert.deepEqual(getConfigCalls, ["ws-inactive"]);
  assert.equal(patched.length, 1);
  assert.equal(patched[0]?.workspaceId, "ws-inactive");
  assert.equal(
    (((patched[0]?.payload.opencode?.provider as Record<string, unknown>)?.codex_oauth as Record<string, unknown>)
      ?.options as Record<string, unknown>)?.apiKey,
    VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  );
});

test("inactive workspace heal does not apply active WSL bridge routing to other workspaces", async () => {
  const client = createVesloClient();
  const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      resolvedVesloCapabilities: () => ({
        config: { read: true, write: true },
        sandbox: { enabled: true, backend: "windows-wsl2" },
      }),
      activeVesloServerRoutingInfo: () => ({
        baseUrl: "http://127.0.0.1:34115",
        engineUrl: "http://172.20.0.1:34116",
        clientToken: "local-client-token",
        hostToken: "local-host-token",
      }),
      engine: () => ({ running: true, runtime: "direct", childKind: "wsl", projectDir: "/repo" }),
      recordManagedAiWorkflowTrace: (event, payload) => traces.push({ event, payload }),
    }),
  );

  await sync.healInactiveManagedAiWorkspaceConfigs();

  assert.deepEqual(client.getConfigCalls, []);
  assert.deepEqual(client.patched, []);
  assert.deepEqual(traces, [
    {
      event: "managed-baseurl.heal:skip",
      payload: {
        reason: "workspace-scoped-engine-routing",
        activeWorkspaceId: "ws-active",
        resolvedBaseUrl: "http://127.0.0.1:34115",
        resolvedEngineBaseUrl: "http://172.20.0.1:34116",
      },
    },
  ]);
});
