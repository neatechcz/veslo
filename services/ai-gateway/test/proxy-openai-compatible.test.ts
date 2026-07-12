import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { CredentialBinding, CredentialRecord } from "../src/credentials/repository.js";
import type { StoredSecret } from "../src/credentials/secret-store.js";
import { ProviderTransportError } from "../src/providers/transport.js";
import { createApp } from "../src/index.js";

const GATEWAY_AUTH_HEADER = {
  authorization: "Bearer gateway-access-token",
};

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_custom_1",
    name: "Custom provider",
    ownerUserId: "platform:openai_compatible",
    provider: "openai_compatible",
    credentialType: "api_key",
    state: "healthy",
    secretRef: "secret_custom_1",
    createdAt: new Date("2026-05-03T08:00:00.000Z"),
    updatedAt: new Date("2026-05-03T08:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  };
}

function createBinding(overrides: Partial<CredentialBinding> = {}): CredentialBinding {
  return {
    id: "binding_custom_1",
    ownerUserId: "platform:openai_compatible",
    provider: "openai_compatible",
    credentialRecordId: "cred_custom_1",
    createdAt: new Date("2026-05-03T08:00:00.000Z"),
    updatedAt: new Date("2026-05-03T08:00:00.000Z"),
    ...overrides,
  };
}

function createProxyApp(input: {
  binding?: CredentialBinding | null;
  bindingLookupError?: Error;
  secret?: StoredSecret | null;
  transport?: { chatCompletions(transportInput: unknown): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> };
  transportCalls?: unknown[];
  recordUsageCalls?: unknown[];
  leaseScopes?: unknown[];
  recordProviderFailureCalls?: unknown[];
}) {
  const binding = input.binding === undefined ? createBinding() : input.binding;
  const credential = createCredentialRecord();
  return createApp({
    proxy: {
      modelPolicy: {
        async getPolicy() {
          return {
            id: "platform" as const,
            enabledModels: [{ provider: "openai_compatible" as const, model: "custom-model" }],
            activeModel: { provider: "openai_compatible" as const, model: "custom-model" },
            createdAt: new Date("2026-07-12T08:00:00.000Z"),
            updatedAt: new Date("2026-07-12T08:00:00.000Z"),
          };
        },
        async replacePolicy() {
          throw new Error("unused");
        },
      },
      gatewaySessions: {
        async resolveSession(token: string) {
          assert.equal(token, "gateway-access-token");
          return {
            token,
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          };
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, "user_gateway");
          return {
            id: "ai_access_user_gateway",
            userId,
            enabled: true,
            provider: "openai_compatible",
            credentialId: "cred_custom_1",
            defaultModel: "custom-model",
            allowedModels: ["custom-model"],
            createdAt: new Date("2026-05-03T08:00:00.000Z"),
            updatedAt: new Date("2026-05-03T08:00:00.000Z"),
          };
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return credential;
        },
        async listHealthyCredentialRecordIds() {
          return [credential.id];
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_custom_1");
          if (input.bindingLookupError) {
            throw input.bindingLookupError;
          }
          return binding;
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_custom_1");
          return credential;
        },
        async markCredentialState() {},
      },
      alertRepository: {
        async listAlerts() {
          return [];
        },
        async recordProviderFailure(alertInput: unknown) {
          input.recordProviderFailureCalls?.push(alertInput);
        },
      },
      secrets: {
        async put() {
          throw new Error("unused");
        },
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_custom_1");
          return input.secret === undefined ? {
            kind: "openai_compatible_api_key",
            apiKey: "sk-compatible",
            baseUrl: "https://custom.example.test/v1",
          } : input.secret;
        },
        async replace() {
          throw new Error("unused");
        },
      },
      usageRepository: {
        async recordUsage(recordInput: unknown) {
          input.recordUsageCalls?.push(recordInput);
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope: unknown) {
          input.leaseScopes?.push(scope);
          return {
            id: "lease_custom_1",
            ownerUserId: "user_gateway",
            provider: "openai_compatible",
            sessionId: "session_custom_1",
            activeBindingId: "binding_custom_1",
          };
        },
        async handleUpstreamFailure() {
          throw new Error("unused");
        },
      },
      tokenBroker: {
        async getUpstreamAuth() {
          throw new Error("token broker should not run");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          throw new Error("openai transport should not run");
        },
      },
      anthropicTransport: {
        async messages() {
          throw new Error("anthropic transport should not run");
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          throw new Error("codex transport should not run");
        },
      },
      openAiCompatibleTransport: input.transport ?? {
        async chatCompletions(transportInput: unknown) {
          input.transportCalls?.push(transportInput);
          return {
            status: 200,
            headers: {
              "x-upstream-request-id": "custom_req_1",
            },
            body: {
              id: "chatcmpl_custom_1",
              model: "custom-model",
              usage: {
                prompt_tokens: 13,
                completion_tokens: 8,
              },
            },
          };
        },
      },
    } as never,
  });
}

test("POST /providers/openai_compatible/v1/chat/completions forwards assigned custom provider requests", async () => {
  const transportCalls: unknown[] = [];
  const recordUsageCalls: unknown[] = [];
  const leaseScopes: unknown[] = [];
  const app = createProxyApp({ transportCalls, recordUsageCalls, leaseScopes });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_1",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_custom_1",
      model: "custom-model",
      usage: {
        prompt_tokens: 13,
        completion_tokens: 8,
      },
    });
    assert.deepEqual(transportCalls, [
      {
        apiKey: "sk-compatible",
        baseUrl: "https://custom.example.test/v1",
        body: {
          messages: [{ role: "user", content: "hello" }],
          model: "custom-model",
        },
      },
    ]);
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: "platform:openai_compatible",
        requiredBindingId: "binding_custom_1",
        provider: "openai_compatible",
        sessionId: "session_custom_1",
      },
    ]);
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "custom_req_1",
        ownerUserId: "user_gateway",
        orgId: null,
        provider: "openai_compatible",
        sessionId: "session_custom_1",
        credentialId: "cred_custom_1",
        bindingId: "binding_custom_1",
        model: "custom-model",
        inputTokens: 13,
        outputTokens: 8,
        cachedTokens: 0,
        totalTokens: 21,
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("openai-compatible proxy records alert when assigned credential binding is unavailable", async () => {
  const recordProviderFailureCalls: unknown[] = [];
  const app = createProxyApp({
    binding: null,
    recordProviderFailureCalls,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_missing_1",
      },
      body: JSON.stringify({
        model: "custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "assigned_credential_unavailable" });
    assert.deepEqual(recordProviderFailureCalls, [
      {
        credentialId: "cred_custom_1",
        provider: "openai_compatible",
        sessionId: "session_custom_missing_1",
        reason: "assigned_credential_unavailable",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("openai-compatible proxy returns structured failure when assigned binding lookup throws", async () => {
  const app = createProxyApp({
    bindingLookupError: new Error("binding lookup failed"),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_lookup_throw",
      },
      body: JSON.stringify({
        model: "custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "proxy_request_failed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("openai-compatible proxy sanitizes upstream error bodies", async () => {
  const recordProviderFailureCalls: unknown[] = [];
  const app = createProxyApp({
    recordProviderFailureCalls,
    transport: {
        async chatCompletions() {
          throw new ProviderTransportError("upstream rejected request with sk-compatible", {
            statusCode: 401,
            body: {
              error: "sk-compatible",
            },
          });
        },
      },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_1",
      },
      body: JSON.stringify({
        model: "custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const responseText = await response.text();
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: "openai_compatible_upstream_error" });
    assert.equal(responseText.includes("sk-compatible"), false);
    assert.deepEqual(recordProviderFailureCalls, [
      {
        credentialId: "cred_custom_1",
        provider: "openai_compatible",
        sessionId: "session_custom_1",
        reason: "authentication_error",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("openai-compatible proxy returns sanitized transport diagnostics for network failures", async () => {
  const app = createProxyApp({
    transport: {
      async chatCompletions() {
        throw new ProviderTransportError("fetch failed for https://secret-upstream.example.test/v1", {
          statusCode: 502,
          code: "openai_compatible_request_failed",
        });
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_1",
      },
      body: JSON.stringify({
        model: "custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const responseText = await response.text();
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(responseText), {
      error: "openai_compatible_request_failed",
      reason: "upstream_fetch_failed",
    });
    assert.equal(responseText.includes("secret-upstream"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});
