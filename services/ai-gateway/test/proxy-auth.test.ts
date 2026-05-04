import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { CredentialRecord } from "../src/credentials/repository.js";
import { createApp, type AppDependencies } from "../src/index.js";

test("provider proxy rejects requests without gateway bearer auth", async () => {
  const app = createApp({
    proxy: {
      gatewaySessions: {
        async resolveSession() {
          throw new Error("resolver should not be called without authorization");
        },
      },
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
          assert.fail("lease broker should not be reached without gateway auth");
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached without gateway auth");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not be reached without gateway auth");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("transport should not be reached without gateway auth");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("transport should not be reached without gateway auth");
        },
      },
    } as never,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_auth_1",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy accepts large model request bodies before gateway auth", async () => {
  const app = createApp({
    proxy: {
      gatewaySessions: {
        async resolveSession() {
          throw new Error("resolver should not be called without authorization");
        },
      },
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
          assert.fail("lease broker should not be reached without gateway auth");
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached without gateway auth");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not be reached without gateway auth");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("transport should not be reached without gateway auth");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("transport should not be reached without gateway auth");
        },
      },
    } as never,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const largeContext = "x".repeat(256 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_large_context_1",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: largeContext }],
      }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy uses resolved gateway user identity instead of trusting x-veslo-owner-user-id", async () => {
  const resolvedSessions: string[] = [];
  const leaseScopes: Array<{ ownerUserId: string; provider: string; sessionId: string }> = [];
  const credentialsByBindingId = new Map<string, CredentialRecord>([
    [
      "binding_openai_primary",
      {
        id: "cred_openai_primary",
        ownerUserId: "resolved_user_123",
        provider: "openai",
        credentialType: "oauth",
        state: "healthy",
        secretRef: "secret_1",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        lastFailureAt: null,
      },
    ],
  ]);

  const app = createApp({
    proxy: {
      gatewaySessions: {
        async resolveSession(token: string) {
          resolvedSessions.push(token);
          return {
            token,
            user: {
              id: "resolved_user_123",
              email: "user@example.test",
            },
          };
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
          return credentialsByBindingId.get(bindingId) ?? null;
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease(input: { ownerUserId: string; provider: string; sessionId: string }) {
          leaseScopes.push(input);
          return {
            id: "lease_proxy_auth_1",
            ownerUserId: input.ownerUserId,
            provider: input.provider,
            sessionId: input.sessionId,
            activeBindingId: "binding_openai_primary",
          };
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in the happy path");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth" as const, value: "oauth_token_live" };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          return {
            status: 200,
            body: {
              id: "chatcmpl_proxy_auth_1",
              object: "chat.completion",
              model: "gpt-4o-mini",
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in openai test");
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
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_auth_2",
        "x-veslo-owner-user-id": "attacker_supplied_user",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_proxy_auth_1",
      object: "chat.completion",
      model: "gpt-4o-mini",
    });
    assert.deepEqual(resolvedSessions, ["gateway-access-token"]);
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "resolved_user_123",
        bindingOwnerUserId: "platform:openai",
        provider: "openai",
        sessionId: "session_auth_2",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("provider proxy accepts the OpenCode gateway token header", async () => {
  const resolvedSessions: string[] = [];

  const app = createApp({
    proxy: {
      gatewaySessions: {
        async resolveSession(token: string) {
          resolvedSessions.push(token);
          return {
            token,
            user: {
              id: "resolved_user_456",
              email: "user@example.test",
            },
          };
        },
      },
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
        async getOrCreateActiveLease(input: { ownerUserId: string; provider: string; sessionId: string }) {
          return {
            id: "lease_proxy_auth_header",
            ownerUserId: input.ownerUserId,
            provider: input.provider,
            sessionId: input.sessionId,
            activeBindingId: "binding_openai_primary",
          };
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in the happy path");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth" as const, value: "oauth_token_live" };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          return {
            status: 200,
            body: {
              id: "chatcmpl_proxy_auth_header",
              object: "chat.completion",
              model: "gpt-4o-mini",
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in openai test");
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
        "content-type": "application/json",
        "x-veslo-gateway-token": "gateway-access-token",
        "x-veslo-session-id": "session_auth_header",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_proxy_auth_header",
      object: "chat.completion",
      model: "gpt-4o-mini",
    });
    assert.deepEqual(resolvedSessions, ["gateway-access-token"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
