import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { CredentialRecord, CredentialRepository, MarkCredentialStateInput } from "../src/credentials/repository.js";
import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import { createApp, type AppDependencies } from "../src/index.js";
import type { RecordUsageInput } from "../src/usage/repository.js";

class TestCredentialRepository implements CredentialRepository {
  constructor(private readonly recordsByBindingId: Map<string, CredentialRecord>) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record;
      }
    }

    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.recordsByBindingId.values()).map((record) => record.id);
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null;
  }

  async markCredentialState(_input: MarkCredentialStateInput): Promise<void> {}
}

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_1",
    ownerUserId: "user_gateway",
    provider: "openai",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_1",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  };
}

function createGatewaySessions() {
  return {
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
  };
}

function createUsageApp(input: {
  credentials: CredentialRepository;
  recordUsageCalls: RecordUsageInput[];
}) {
  return createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: input.credentials,
      usageRepository: {
        async recordUsage(event: RecordUsageInput) {
          input.recordUsageCalls.push(event);
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope: { ownerUserId: string; provider: string; sessionId: string }) {
          return {
            id: `lease_${scope.provider}`,
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: scope.provider === "openai" ? "binding_openai_primary" : "binding_anthropic_primary",
          };
        },
        async handleUpstreamFailure() {
          assert.fail("upstream failure handler should not be reached in usage tests");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth(input: { bindingId: string }) {
          return input.bindingId.includes("anthropic")
            ? { kind: "api-key" as const, value: "sk-ant-test" }
            : { kind: "oauth" as const, value: "oauth-openai-test" };
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          assert.deepEqual(input.upstreamAuth, {
            kind: "oauth",
            value: "oauth-openai-test",
          });
          return {
            status: 200,
            headers: {
              "x-upstream-request-id": "openai_req_usage_1",
            },
            body: {
              id: "chatcmpl_usage_1",
              object: "chat.completion",
              model: "gpt-4o-mini",
              usage: {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
              },
            },
          };
        },
      },
      anthropicTransport: {
        async messages(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          assert.deepEqual(input.upstreamAuth, {
            kind: "api-key",
            value: "sk-ant-test",
          });
          return {
            status: 200,
            body: {
              id: "msg_usage_1",
              type: "message",
              model: "claude-3-7-sonnet",
              usage: {
                input_tokens: 5,
                output_tokens: 13,
              },
            },
          };
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });
}

test("successful openai proxy requests record usage with credential and token details", async () => {
  const recordUsageCalls: RecordUsageInput[] = [];
  const app = createUsageApp({
    recordUsageCalls,
    credentials: new TestCredentialRepository(
      new Map([
        [
          "binding_openai_primary",
          createCredentialRecord({
            id: "cred_openai_1",
            provider: "openai",
            credentialType: "oauth",
          }),
        ],
      ]),
    ),
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
        "x-veslo-session-id": "session_openai_usage_1",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "openai_req_usage_1",
        ownerUserId: "user_gateway",
        orgId: null,
        provider: "openai",
        sessionId: "session_openai_usage_1",
        credentialId: "cred_openai_1",
        bindingId: "binding_openai_primary",
        model: "gpt-4o-mini",
        inputTokens: 11,
        outputTokens: 7,
        cachedTokens: 0,
        totalTokens: 18,
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("successful anthropic proxy requests record usage with body-derived request ids", async () => {
  const recordUsageCalls: RecordUsageInput[] = [];
  const app = createUsageApp({
    recordUsageCalls,
    credentials: new TestCredentialRepository(
      new Map([
        [
          "binding_anthropic_primary",
          createCredentialRecord({
            id: "cred_anthropic_1",
            provider: "anthropic",
            credentialType: "api_key",
          }),
        ],
      ]),
    ),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_anthropic_usage_1",
      },
      body: JSON.stringify({
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "msg_usage_1",
        ownerUserId: "user_gateway",
        provider: "anthropic",
        sessionId: "session_anthropic_usage_1",
        credentialId: "cred_anthropic_1",
        bindingId: "binding_anthropic_primary",
        model: "claude-3-7-sonnet",
        inputTokens: 5,
        outputTokens: 13,
        cachedTokens: 0,
        totalTokens: 18,
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
