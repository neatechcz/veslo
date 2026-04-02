import assert from "node:assert/strict";
import test from "node:test";

import { createProviderAuthModule } from "./provider-auth.js";

type GatewayProvider = "openai" | "anthropic";

type GatewayCredential = {
  id: string;
  provider: GatewayProvider;
  credentialType: "oauth" | "api_key";
  state: "healthy" | "failing" | "revoked";
  createdAt: string;
  updatedAt: string;
  lastFailureAt: string | null;
};

function createProviderAuthRuntime(overrides?: {
  gatewayCredentials?: Partial<Record<GatewayProvider, GatewayCredential[]>>;
}) {
  const providerUpdates: Array<{ data: unknown; mergedConnected?: string[] }> = [];
  const gatewayCredentials: Record<GatewayProvider, GatewayCredential[]> = {
    openai: [...(overrides?.gatewayCredentials?.openai ?? [])],
    anthropic: [...(overrides?.gatewayCredentials?.anthropic ?? [])],
  };

  const calls = {
    authSet: [] as Array<{ providerID: string; auth: unknown }>,
    oauthAuthorize: [] as Array<{ providerID: string; method: number }>,
    oauthCallback: [] as Array<{ providerID: string; method: number; code?: string }>,
    rawDelete: [] as Array<{ url: string }>,
    sessionCreate: [] as Array<{ directory?: string; title: string }>,
    sessionPrompt: [] as Array<{ sessionID: string; model: { providerID: string; modelID: string } }>,
    sessionAbort: [] as Array<{ sessionID: string }>,
    sessionDelete: [] as Array<{ sessionID: string }>,
    instanceDispose: 0,
    startOpenAiOAuth: [] as Array<{ userToken: string }>,
    finishOpenAiOAuth: [] as Array<{ userToken: string; code: string }>,
    saveAnthropicApiKey: [] as Array<{ userToken: string; apiKey: string }>,
    listGatewayCredentials: [] as Array<{ userToken: string; provider: GatewayProvider }>,
    revokeGatewayCredential: [] as Array<{ userToken: string; provider: GatewayProvider; credentialId: string }>,
    writeOpencodeConfig: [] as Array<{ scope: string; workspaceRoot: string; content: string }>,
  };

  let gatewayCredentialCounter = 100;

  const client = {
    auth: {
      set: async (input: { providerID: string; auth: unknown }) => {
        calls.authSet.push(input);
        return { data: { ok: true } };
      },
    },
    provider: {
      list: async () => ({
        data: {
          all: [
            { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: { "gpt-4o-mini": {} } },
            { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-3-5-sonnet": {} } },
            { id: "lmstudio", name: "LM Studio", env: [], models: {} },
          ],
          connected: [],
          default: {},
        },
      }),
      auth: async () => ({
        data: {
          openai: [{ type: "oauth", label: "OpenAI OAuth" }],
          anthropic: [{ type: "api", label: "API key" }],
          lmstudio: [{ type: "api", label: "Local URL (no key)" }],
        },
      }),
      oauth: {
        authorize: async (input: { providerID: string; method: number }) => {
          calls.oauthAuthorize.push(input);
          return {
            data: {
              url: "https://opencode.example.test/oauth",
              method: "code",
              instructions: "Paste the code from OpenCode.",
            },
          };
        },
        callback: async (input: { providerID: string; method: number; code?: string }) => {
          calls.oauthCallback.push(input);
          return { data: { ok: true } };
        },
      },
    },
    instance: {
      dispose: async () => {
        calls.instanceDispose += 1;
        return { data: { ok: true } };
      },
    },
    session: {
      create: async (input: { directory?: string; title: string }) => {
        calls.sessionCreate.push(input);
        return { data: { id: "sess_test" } };
      },
      prompt: async (input: { sessionID: string; model: { providerID: string; modelID: string } }) => {
        calls.sessionPrompt.push(input);
        return { data: { ok: true } };
      },
      abort: async (input: { sessionID: string }) => {
        calls.sessionAbort.push(input);
        return { data: { ok: true } };
      },
      delete: async (input: { sessionID: string }) => {
        calls.sessionDelete.push(input);
        return { data: { ok: true } };
      },
    },
    client: {
      delete: async (input: { url: string }) => {
        calls.rawDelete.push(input);
        return { data: { ok: true } };
      },
    },
  };

  const vesloServerClient = {
    baseUrl: "http://127.0.0.1:4318",
    startOpenAiOAuth: async (userToken: string) => {
      calls.startOpenAiOAuth.push({ userToken });
      return { authorizeUrl: "https://openai.example.test/oauth" };
    },
    finishOpenAiOAuth: async (userToken: string, code: string) => {
      calls.finishOpenAiOAuth.push({ userToken, code });
      const credential: GatewayCredential = {
        id: `cred_${++gatewayCredentialCounter}`,
        provider: "openai",
        credentialType: "oauth",
        state: "healthy",
        createdAt: "2026-04-02T12:00:00.000Z",
        updatedAt: "2026-04-02T12:00:00.000Z",
        lastFailureAt: null,
      };
      gatewayCredentials.openai.push(credential);
      return { credential };
    },
    saveAnthropicApiKey: async (userToken: string, apiKey: string) => {
      calls.saveAnthropicApiKey.push({ userToken, apiKey });
      const credential: GatewayCredential = {
        id: `cred_${++gatewayCredentialCounter}`,
        provider: "anthropic",
        credentialType: "api_key",
        state: "healthy",
        createdAt: "2026-04-02T12:05:00.000Z",
        updatedAt: "2026-04-02T12:05:00.000Z",
        lastFailureAt: null,
      };
      gatewayCredentials.anthropic.push(credential);
      return { credential };
    },
    listGatewayCredentials: async (userToken: string, provider: GatewayProvider) => {
      calls.listGatewayCredentials.push({ userToken, provider });
      return { credentials: [...gatewayCredentials[provider]] };
    },
    revokeGatewayCredential: async (userToken: string, provider: GatewayProvider, credentialId: string) => {
      calls.revokeGatewayCredential.push({ userToken, provider, credentialId });
      const current = gatewayCredentials[provider].find((credential) => credential.id === credentialId);
      if (current) {
        current.state = "revoked";
        current.updatedAt = "2026-04-02T12:15:00.000Z";
      }
      return {
        credential: current ?? {
          id: credentialId,
          provider,
          credentialType: provider === "openai" ? "oauth" : "api_key",
          state: "revoked",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:15:00.000Z",
          lastFailureAt: null,
        },
      };
    },
  };

  const module = createProviderAuthModule({
    getClient: () => client as never,
    getProviders: () => [
      { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: { "gpt-4o-mini": {} } },
      { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-3-5-sonnet": {} } },
      { id: "lmstudio", name: "LM Studio", env: [], models: {} },
    ] as never,
    getProviderDefaults: () => ({}),
    getProviderAuthMethods: () => ({
      openai: [{ type: "oauth", label: "OpenAI OAuth" }],
      anthropic: [{ type: "api", label: "API key" }],
      lmstudio: [{ type: "api", label: "Local URL (no key)" }],
    }),
    getWorkspaceRoot: () => "/tmp/workspace",
    setProviderAuthError: () => {},
    globalSyncSetProvider: (data: unknown) => {
      providerUpdates.push({ data });
    },
    globalSyncSetProviderMerged: (data: unknown, mergedConnected: string[]) => {
      providerUpdates.push({ data, mergedConnected });
    },
    unwrap: <T,>(result: { data?: T }) => result.data as NonNullable<T>,
    isTauriRuntime: () => true,
    readOpencodeConfig: async () => ({ content: "{\n  \"provider\": {}\n}" }),
    writeOpencodeConfig: async (scope: "project", workspaceRoot: string, content: string) => {
      calls.writeOpencodeConfig.push({ scope, workspaceRoot, content });
      return { ok: true };
    },
    getVesloServerClient: () => vesloServerClient,
    getGatewayAuthToken: () => "den_token_123",
  } as any);

  return {
    module,
    calls,
    providerUpdates,
    gatewayCredentials,
    lastMergedConnected: () => providerUpdates.at(-1)?.mergedConnected ?? [],
  };
}

test("submitProviderApiKey sends anthropic api keys to veslo server gateway api, not c.auth.set", async () => {
  const runtime = createProviderAuthRuntime();

  const result = await runtime.module.submitProviderApiKey("anthropic", "sk-ant-secret");

  assert.equal(result, "Connected anthropic");
  assert.deepEqual(runtime.calls.saveAnthropicApiKey, [{ userToken: "den_token_123", apiKey: "sk-ant-secret" }]);
  assert.equal(runtime.calls.authSet.length, 0);
  assert.equal(runtime.calls.sessionCreate.length, 0);
  assert.equal(runtime.calls.sessionPrompt.length, 0);
  assert.equal(runtime.calls.instanceDispose, 1);
  assert.equal(runtime.calls.writeOpencodeConfig.length, 1);
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"baseURL": "http:\/\/127\.0\.0\.1:\d+\/ai-gateway\/providers\/anthropic\/v1"/,
  );
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"x-veslo-gateway-token": "den_token_123"/,
  );
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"x-veslo-session-id": "\$\{OPENCODE_SESSION_ID\}"/,
  );
  assert.deepEqual(runtime.lastMergedConnected(), ["anthropic"]);
});

test("startProviderAuth sends openai oauth start to veslo server gateway api, not c.provider.oauth.authorize", async () => {
  const runtime = createProviderAuthRuntime();

  const started = await runtime.module.startProviderAuth("openai");

  assert.equal(started.methodIndex, 0);
  assert.equal(started.authorization.url, "https://openai.example.test/oauth");
  assert.equal(started.authorization.method, "code");
  assert.deepEqual(runtime.calls.startOpenAiOAuth, [{ userToken: "den_token_123" }]);
  assert.equal(runtime.calls.oauthAuthorize.length, 0);
});

test("completeProviderAuthOAuth finishes openai oauth via veslo server gateway api", async () => {
  const runtime = createProviderAuthRuntime();

  const result = await runtime.module.completeProviderAuthOAuth("openai", 0, "oauth-code-123");

  assert.equal(result, "Connected openai");
  assert.deepEqual(runtime.calls.finishOpenAiOAuth, [{ userToken: "den_token_123", code: "oauth-code-123" }]);
  assert.equal(runtime.calls.oauthCallback.length, 0);
  assert.equal(runtime.calls.instanceDispose, 1);
  assert.equal(runtime.calls.writeOpencodeConfig.length, 1);
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"baseURL": "http:\/\/127\.0\.0\.1:\d+\/ai-gateway\/providers\/openai\/v1"/,
  );
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"x-veslo-gateway-token": "den_token_123"/,
  );
  assert.match(
    runtime.calls.writeOpencodeConfig[0]?.content ?? "",
    /"x-veslo-session-id": "\$\{OPENCODE_SESSION_ID\}"/,
  );
  assert.deepEqual(runtime.lastMergedConnected(), ["openai"]);
});

test("disconnectProvider revokes gateway credentials for migrated providers", async () => {
  const runtime = createProviderAuthRuntime({
    gatewayCredentials: {
      openai: [
        {
          id: "cred_openai_1",
          provider: "openai",
          credentialType: "oauth",
          state: "healthy",
          createdAt: "2026-04-02T11:00:00.000Z",
          updatedAt: "2026-04-02T11:00:00.000Z",
          lastFailureAt: null,
        },
        {
          id: "cred_openai_2",
          provider: "openai",
          credentialType: "oauth",
          state: "healthy",
          createdAt: "2026-04-02T11:05:00.000Z",
          updatedAt: "2026-04-02T11:05:00.000Z",
          lastFailureAt: null,
        },
      ],
    },
  });

  const result = await runtime.module.disconnectProvider("openai");

  assert.equal(result, "Disconnected openai");
  assert.equal(runtime.calls.authSet.length, 0);
  assert.deepEqual(runtime.calls.revokeGatewayCredential, [
    { userToken: "den_token_123", provider: "openai", credentialId: "cred_openai_1" },
    { userToken: "den_token_123", provider: "openai", credentialId: "cred_openai_2" },
  ]);
  assert.deepEqual(runtime.lastMergedConnected(), []);
});

test("lmstudio still uses the existing local config path", async () => {
  const runtime = createProviderAuthRuntime();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: "qwen2.5-coder-14b-instruct" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const result = await runtime.module.connectLmStudioProvider("http://127.0.0.1:1234/v1");

    assert.equal(result, "Connected LM Studio (1 model)");
    assert.equal(runtime.calls.writeOpencodeConfig.length, 1);
    assert.equal(runtime.calls.writeOpencodeConfig[0]?.workspaceRoot, "/tmp/workspace");
    assert.match(runtime.calls.writeOpencodeConfig[0]?.content ?? "", /"lmstudio"/);
    assert.match(runtime.calls.writeOpencodeConfig[0]?.content ?? "", /http:\/\/127\.0\.0\.1:1234\/v1/);
    assert.equal(runtime.calls.saveAnthropicApiKey.length, 0);
    assert.equal(runtime.calls.startOpenAiOAuth.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
