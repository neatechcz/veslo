import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { UserAiAccessPolicyRecord } from "../src/access/repository.js";
import { getPlatformCredentialOwnerUserId } from "../src/credentials/platform-owner.js";
import type { CredentialRecord } from "../src/credentials/repository.js";
import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import { createApp, type AppDependencies } from "../src/index.js";
import type { PlatformModelPolicyRecord } from "../src/model-policy/repository.js";
import { allowManagedAiEntitlement } from "./support/managed-ai-entitlement.js";

const GATEWAY_AUTH_HEADER = {
  authorization: "Bearer gateway-access-token",
};

function createGatewaySessionUser() {
  return {
    token: "gateway-access-token",
    user: {
      id: "user_gateway",
      email: "gateway@example.test",
    },
  };
}

function createAiAccess(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "openai",
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini"],
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
    updatedAt: new Date("2026-04-08T10:00:00.000Z"),
    ...overrides,
  };
}

function createModelPolicy(provider: "openai" | "anthropic" | "codex_oauth" | "openai_compatible", model: string) {
  return {
    async getPolicy() {
      return {
        id: "platform" as const,
        enabledModels: [{ provider, model }],
        activeModel: { provider, model },
        createdAt: new Date("2026-07-12T08:00:00.000Z"),
        updatedAt: new Date("2026-07-12T08:00:00.000Z"),
      };
    },
    async replacePolicy() {
      throw new Error("unused");
    },
  };
}

function createCredentialRecord(bindingId: string, provider: "openai" | "anthropic"): CredentialRecord {
  return {
    id: `cred_${bindingId}`,
    ownerUserId: "user_gateway",
    provider,
    credentialType: provider === "openai" ? "oauth" : "api_key",
    state: "healthy",
    secretRef: `secret_${bindingId}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastFailureAt: null,
  };
}

function createPolicyBoundaryApp(input: {
  getPolicy: () => Promise<PlatformModelPolicyRecord | null>;
  aiAccessByUser?: Record<string, UserAiAccessPolicyRecord>;
  modelCalls?: Array<{ userId: string; body: Record<string, unknown> }>;
  leaseCalls?: string[];
}) {
  let currentUserId = "";
  return createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession(token: string) {
          currentUserId = token === "gateway-user-two" ? "user_two" : "user_one";
          return {
            token,
            user: { id: currentUserId, email: `${currentUserId}@example.test` },
          };
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          return input.aiAccessByUser?.[userId] ?? createAiAccess({
            id: `ai_access_${userId}`,
            userId,
            provider: "openai",
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: {
        getPolicy: input.getPolicy,
        async replacePolicy() {
          throw new Error("unused");
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          return createCredentialRecord(bindingId, "openai");
        },
        async markCredentialState() {},
      },
      usageRepository: { async recordUsage() {} },
      leaseBroker: {
        async getOrCreateActiveLease() {
          input.leaseCalls?.push(currentUserId);
          return {
            id: `lease_${currentUserId}`,
            ownerUserId: currentUserId,
            provider: "openai" as const,
            sessionId: `session_${currentUserId}`,
            activeBindingId: `binding_${currentUserId}`,
          };
        },
        async handleUpstreamFailure() {
          throw new Error("unused");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth" as const, value: "oauth-live" };
        },
      },
      openAiTransport: {
        async chatCompletions(request: { body: Record<string, unknown> }) {
          input.modelCalls?.push({ userId: currentUserId, body: request.body });
          return {
            status: 200,
            body: { id: `response_${currentUserId}`, model: request.body.model },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          throw new Error("anthropic transport should not run");
        },
      },
    } as any,
  });
}

async function requestOpenAi(app: ReturnType<typeof createApp>, input: {
  token?: string;
  path?: string;
  body?: Record<string, unknown>;
}) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${input.path ?? "/providers/openai/v1/chat/completions"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token ?? "gateway-user-one"}`,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_boundary",
      },
      body: JSON.stringify(input.body ?? { messages: [] }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("provider proxy rejects prompt requests when no ai access policy is assigned", async () => {
  const app = createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession() {
          return createGatewaySessionUser();
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return null;
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: createModelPolicy("openai", "gpt-5.4"),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId() {
          return null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run without ai access");
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run without ai access");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run without ai access");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("transport should not run without ai access");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("transport should not run without ai access");
        },
      },
    } as any,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_1",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "ai_access_not_configured" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy rejects prompt requests when the assigned provider does not match the route", async () => {
  const app = createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession() {
          return createGatewaySessionUser();
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccess({
            provider: "anthropic",
            defaultModel: "claude-3-7-sonnet",
            allowedModels: ["claude-3-7-sonnet"],
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: createModelPolicy("openai", "gpt-5.4"),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId() {
          return null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run for provider mismatch");
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run for provider mismatch");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for provider mismatch");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("transport should not run for provider mismatch");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("transport should not run for provider mismatch");
        },
      },
    } as any,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_2",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "provider_not_assigned" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy rejects a requested model that is not allowed by user access", async () => {
  const app = createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession() {
          return createGatewaySessionUser();
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccess({
            provider: "openai",
            defaultModel: "gpt-4o-mini",
            allowedModels: ["gpt-4o-mini"],
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: createModelPolicy("openai", "gpt-4o-mini"),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId() {
          return null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run for model mismatch");
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run for model mismatch");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for model mismatch");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("transport should not run for model mismatch");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("transport should not run for model mismatch");
        },
      },
    } as any,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_3",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "model_not_allowed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy applies the user access default model when the request omits model", async () => {
  const openAiCalls: Array<{ upstreamAuth: UpstreamAuth; body: Record<string, unknown> }> = [];
  const leaseScopes: Array<{
    ownerUserId: string;
    bindingOwnerUserId?: string;
    provider: string;
    sessionId: string;
  }> = [];

  const app = createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession() {
          return createGatewaySessionUser();
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccess({
            provider: "openai",
            defaultModel: "gpt-4o-mini",
            allowedModels: [],
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: createModelPolicy("openai", "gpt-5.4"),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          return bindingId === "binding_openai_primary"
            ? createCredentialRecord("binding_openai_primary", "openai")
            : null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
          leaseScopes.push(scope);
          return {
            id: "lease_openai_primary",
            ownerUserId: "user_gateway",
            provider: "openai",
            sessionId: "session_policy_4",
            activeBindingId: "binding_openai_primary",
          };
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run in the happy path");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth", value: "oauth_token_live" };
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: Record<string, unknown> }) {
          openAiCalls.push(input);
          return {
            status: 200,
            body: {
              id: "chatcmpl_policy_4",
              object: "chat.completion",
              model: String(input.body.model),
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not run for openai test");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_4",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_policy_4",
      object: "chat.completion",
      model: "gpt-4o-mini",
    });
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: getPlatformCredentialOwnerUserId("openai"),
        provider: "openai",
        sessionId: "session_policy_4",
      },
    ]);
    assert.equal(openAiCalls.length, 1);
    assert.equal(openAiCalls[0]?.body.model, "gpt-4o-mini");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("desktop-compatible provider proxy alias applies the user access default model", async () => {
  const openAiCalls: Array<{ upstreamAuth: UpstreamAuth; body: Record<string, unknown> }> = [];

  const app = createApp({
    proxy: {
      managedAiEntitlement: allowManagedAiEntitlement,
      gatewaySessions: {
        async resolveSession() {
          return createGatewaySessionUser();
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccess({
            provider: "openai",
            defaultModel: "gpt-4o-mini",
            allowedModels: [],
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicy: createModelPolicy("openai", "gpt-5.4"),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          return bindingId === "binding_openai_alias"
            ? createCredentialRecord("binding_openai_alias", "openai")
            : null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          return {
            id: "lease_openai_alias",
            ownerUserId: "user_gateway",
            provider: "openai",
            sessionId: "session_policy_alias",
            activeBindingId: "binding_openai_alias",
          };
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run in the happy path");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth", value: "oauth_token_alias" };
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: Record<string, unknown> }) {
          openAiCalls.push(input);
          return {
            status: 200,
            body: {
              id: "chatcmpl_policy_alias",
              object: "chat.completion",
              model: String(input.body.model),
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not run for openai test");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/ai-gateway/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_alias",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_policy_alias",
      object: "chat.completion",
      model: "gpt-4o-mini",
    });
    assert.equal(openAiCalls.length, 1);
    assert.equal(openAiCalls[0]?.body.model, "gpt-4o-mini");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy does not require platform model policy for runtime calls", async () => {
  const modelCalls: Array<{ userId: string; body: Record<string, unknown> }> = [];
  const app = createPolicyBoundaryApp({
    async getPolicy() {
      return null;
    },
    modelCalls,
  });

  const response = await requestOpenAi(app, {});

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: "response_user_one", model: "gpt-4o-mini" });
  assert.deepEqual(modelCalls, [
    { userId: "user_one", body: { messages: [], model: "gpt-4o-mini" } },
  ]);
});

test("provider proxy ignores platform model policy read failures on runtime calls", async () => {
  const modelCalls: Array<{ userId: string; body: Record<string, unknown> }> = [];
  const app = createPolicyBoundaryApp({
    async getPolicy() {
      throw new Error("database unavailable");
    },
    modelCalls,
  });

  const response = await requestOpenAi(app, {});

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: "response_user_one", model: "gpt-4o-mini" });
  assert.deepEqual(modelCalls, [
    { userId: "user_one", body: { messages: [], model: "gpt-4o-mini" } },
  ]);
});

test("every provider route and desktop alias rejects a route that does not match assigned user provider", async () => {
  const leaseCalls: string[] = [];
  const app = createPolicyBoundaryApp({
    getPolicy: createModelPolicy("openai", "gpt-5.4").getPolicy,
    leaseCalls,
  });

  for (const path of [
    "/providers/anthropic/v1/messages",
    "/providers/codex_oauth/v1/chat/completions",
    "/providers/openai_compatible/v1/chat/completions",
    "/ai-gateway/providers/anthropic/v1/messages",
    "/ai-gateway/providers/codex_oauth/v1/chat/completions",
    "/ai-gateway/providers/openai_compatible/v1/chat/completions",
  ]) {
    const response = await requestOpenAi(app, { path });
    assert.equal(response.status, 403, path);
    assert.deepEqual(response.body, { error: "provider_not_assigned" }, path);
  }
  assert.deepEqual(leaseCalls, []);
});

test("two enabled users receive their assigned user access model fields", async () => {
  const modelCalls: Array<{ userId: string; body: Record<string, unknown> }> = [];
  const app = createPolicyBoundaryApp({
    async getPolicy() {
      assert.fail("runtime call should not read platform policy");
      return createModelPolicy("openai", "gpt-5.4").getPolicy();
    },
    aiAccessByUser: {
      user_one: createAiAccess({
        id: "ai_access_user_one",
        userId: "user_one",
        defaultModel: "historical-model-one",
        allowedModels: ["historical-model-one"],
      }),
      user_two: createAiAccess({
        id: "ai_access_user_two",
        userId: "user_two",
        defaultModel: "historical-model-two",
        allowedModels: ["historical-model-two"],
      }),
    },
    modelCalls,
  });

  const first = await requestOpenAi(app, { token: "gateway-user-one" });
  const second = await requestOpenAi(app, { token: "gateway-user-two" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(modelCalls, [
    { userId: "user_one", body: { messages: [], model: "historical-model-one" } },
    { userId: "user_two", body: { messages: [], model: "historical-model-two" } },
  ]);
});
