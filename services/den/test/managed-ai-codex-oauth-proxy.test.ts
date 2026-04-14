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
    id: "cred_codex_1",
    name: null,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_codex_1",
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
    provider: "codex_oauth",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
  }
}

test("codex_oauth proxy forwards through the worker transport with a sticky lease", async () => {
  const recordUsageCalls: RecordUsageInput[] = []
  const leaseScopes: Array<{
    ownerUserId: string
    bindingOwnerUserId?: string
    provider: string
    sessionId: string
  }> = []
  const transportBodies: unknown[] = []

  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
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
            "binding_codex_primary",
            createCredentialRecord({
              id: "cred_codex_1",
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
            id: "lease_codex_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_codex_primary",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in codex proxy test")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker route")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be reached in codex proxy test")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in codex proxy test")
        },
      },
      codexOAuthTransport: {
        async chatCompletions(input: { body: unknown }) {
          transportBodies.push(input.body)
          return {
            status: 200,
            headers: {
              "x-request-id": "codex_req_usage_1",
            },
            body: {
              id: "chatcmpl_codex_usage_1",
              object: "chat.completion",
              model: "gpt-5.4",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: null,
            },
          }
        },
      },
    } as never),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_codex_usage_1",
      object: "chat.completion",
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: null,
    })
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
        provider: "codex_oauth",
        sessionId: "session_codex_1",
      },
    ])
    assert.deepEqual(transportBodies, [
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      },
    ])
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_usage_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_1",
        credentialId: "cred_codex_1",
        bindingId: "binding_codex_primary",
        model: "gpt-5.4",
        inputTokens: undefined,
        outputTokens: undefined,
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})
