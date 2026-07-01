import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedAiAccessProfile } from "../../lib/ai-access.js";
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
  defaultModel: model,
  allowedModels: ["gpt-5"],
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function createVesloClient(): ManagedAiRuntimeConfigVesloClient & {
  patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }>;
  getConfigCalls: string[];
  listCalls: number;
} {
  const patched: Array<{ workspaceId: string; payload: { opencode?: Record<string, unknown> } }> = [];
  const getConfigCalls: string[] = [];
  return {
    baseUrl: "http://127.0.0.1:34115",
    token: "veslo-token",
    patched,
    getConfigCalls,
    listCalls: 0,
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
          defaultModel: profile.defaultModel.modelID,
          allowedModels: profile.allowedModels,
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
  const sync = createManagedAiRuntimeConfigSync(
    createOptions({
      vesloServerClient: () => client,
      vesloServerWorkspaceId: () => "ws-active",
    }),
  );

  await sync.syncActiveWorkspaceManagedAiConfig();

  assert.deepEqual(client.getConfigCalls, ["ws-active"]);
  assert.equal(client.patched.length, 1);
  assert.equal(client.patched[0]?.workspaceId, "ws-active");
  assert.equal(
    (((client.patched[0]?.payload.opencode?.provider as Record<string, unknown>)?.codex_oauth as Record<string, unknown>)
      ?.options as Record<string, unknown>)?.apiKey,
    VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE,
  );
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
