import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import type { UserAiAccessPolicyRecord } from "../src/managed-ai/access/repository.js"
import type {
  CredentialRecord,
  CredentialRepository,
  MarkCredentialStateInput,
} from "../src/managed-ai/credentials/repository.js"
import type { UpstreamAuth } from "../src/managed-ai/credentials/token-broker.js"
import type { RecordUsageInput } from "../src/managed-ai/usage/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { getPlatformCredentialOwnerUserId } = await import("../src/managed-ai/credentials/platform-owner.js")
const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")

class TestCredentialRepository implements CredentialRepository {
  constructor(private readonly recordsByBindingId: Map<string, CredentialRecord>) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record
      }
    }
    return null
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.recordsByBindingId.values()).map((record) => record.id)
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null
  }

  async markCredentialState(_input: MarkCredentialStateInput): Promise<void> {}
}

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_openai_1",
    name: null,
    ownerUserId: "platform:openai",
    provider: "openai",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_openai_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  }
}

function createAiAccess(): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "openai",
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
  }
}

test("successful proxy requests record usage against the resolved gateway user", async () => {
  const recordUsageCalls: RecordUsageInput[] = []
  const leaseScopes: Array<{
    ownerUserId: string
    bindingOwnerUserId?: string
    provider: string
    sessionId: string
  }> = []

  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      denInferenceMode: "legacy_rollback",
      gatewaySessions: {
        async resolveSession(token: string) {
          assert.equal(token, "gateway-access-token")
          return {
            token,
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, "user_gateway")
          return createAiAccess()
        },
      },
      credentials: new TestCredentialRepository(
        new Map([
          [
            "binding_openai_primary",
            createCredentialRecord({
              id: "cred_openai_1",
            }),
          ],
        ]),
      ),
      usageRepository: {
        async recordUsage(input: RecordUsageInput) {
          recordUsageCalls.push(input)
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
          leaseScopes.push(scope)
          return {
            id: "lease_openai_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_openai_primary",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in usage test")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth" as const, value: "oauth-openai-test" }
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          assert.deepEqual(input.upstreamAuth, {
            kind: "oauth",
            value: "oauth-openai-test",
          })
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
              },
            },
          }
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in openai usage test")
        },
      },
    } as never),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_usage_1",
        "x-veslo-owner-user-id": "attacker_supplied_user",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: getPlatformCredentialOwnerUserId("openai"),
        provider: "openai",
        sessionId: "session_usage_1",
      },
    ])
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "openai_req_usage_1",
        ownerUserId: "user_gateway",
        orgId: null,
        provider: "openai",
        sessionId: "session_usage_1",
        credentialId: "cred_openai_1",
        bindingId: "binding_openai_primary",
        model: "gpt-4o-mini",
        inputTokens: 11,
        outputTokens: 7,
        cachedTokens: 0,
        totalTokens: 18,
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})
