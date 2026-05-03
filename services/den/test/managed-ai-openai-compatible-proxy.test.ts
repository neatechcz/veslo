import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import type { UserAiAccessPolicyRecord } from "../src/managed-ai/access/repository.js"
import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  MarkCredentialStateInput,
} from "../src/managed-ai/credentials/repository.js"
import type { StoredSecret } from "../src/managed-ai/credentials/secret-store.js"
import type { OpenAiCompatibleTransportInput } from "../src/managed-ai/providers/transport.js"
import { ProviderTransportError } from "../src/managed-ai/providers/transport.js"
import type { RecordUsageInput } from "../src/managed-ai/usage/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")
const { OpenAiCompatibleTransport } = await import("../src/managed-ai/providers/openai-compatible-transport.js")

class TestCredentialRepository implements CredentialRepository {
  constructor(
    private readonly recordsByBindingId: Map<string, CredentialRecord>,
    private readonly bindingsByCredentialId: Map<string, CredentialBinding>,
  ) {}

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

  async getBindingByCredentialId(credentialId: string): Promise<CredentialBinding | null> {
    return this.bindingsByCredentialId.get(credentialId) ?? null
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null
  }

  async markCredentialState(_input: MarkCredentialStateInput): Promise<void> {}
}

function createCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_custom_1",
    name: "Custom provider",
    ownerUserId: "platform:openai_compatible",
    provider: "openai_compatible",
    credentialType: "api_key",
    state: "healthy",
    secretRef: "secret_custom_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  }
}

function createBinding(overrides: Partial<CredentialBinding> = {}): CredentialBinding {
  return {
    id: "binding_custom_1",
    ownerUserId: "platform:openai_compatible",
    provider: "openai_compatible",
    credentialRecordId: "cred_custom_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    ...overrides,
  }
}

function createAiAccess(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "openai_compatible",
    credentialId: "cred_custom_1",
    defaultModel: "custom-model",
    allowedModels: ["custom-model"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
    ...overrides,
  }
}

function createProxyApp(input: {
  aiAccess?: UserAiAccessPolicyRecord
  bindingsByCredentialId?: Map<string, CredentialBinding>
  recordsByBindingId?: Map<string, CredentialRecord>
  secret?: StoredSecret
  transport?: {
    chatCompletions(input: OpenAiCompatibleTransportInput): Promise<{ status: number; body: unknown; headers?: Record<string, string> }>
  }
  recordUsageCalls?: RecordUsageInput[]
  leaseScopes?: unknown[]
}) {
  const binding = createBinding()
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
          return input.aiAccess ?? createAiAccess()
        },
      },
      credentials: new TestCredentialRepository(
        input.recordsByBindingId ?? new Map([[binding.id, createCredentialRecord()]]),
        input.bindingsByCredentialId ?? new Map([["cred_custom_1", binding]]),
      ),
      secrets: {
        async put() {
          return { secretRef: "secret_unused" }
        },
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_custom_1")
          return input.secret ?? {
            kind: "openai_compatible_api_key",
            apiKey: "sk-custom",
            baseUrl: "https://custom.example.test/v1",
          }
        },
        async replace() {},
      },
      usageRepository: {
        async recordUsage(recordInput: RecordUsageInput) {
          input.recordUsageCalls?.push(recordInput)
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
          input.leaseScopes?.push(scope)
          return {
            id: "lease_custom_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_custom_1",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run for openai-compatible proxy")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for openai-compatible proxy")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not run for openai-compatible proxy")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not run for openai-compatible proxy")
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          assert.fail("codex oauth transport should not run for openai-compatible proxy")
        },
      },
      openAiCompatibleTransport: input.transport ?? {
        async chatCompletions() {
          assert.fail("test must provide openai-compatible transport")
        },
      },
    } as never),
  )
  return app
}

async function requestChatCompletions(app: express.Express, body: Record<string, unknown> = {
  model: "custom-model",
  messages: [{ role: "user", content: "hello" }],
}) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    return await fetch(`http://127.0.0.1:${port}/providers/openai_compatible/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_custom_1",
        "x-veslo-owner-user-id": "attacker_supplied_user",
      },
      body: JSON.stringify(body),
    })
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("openai-compatible proxy forwards assigned credential requests and records usage", async () => {
  const transportCalls: OpenAiCompatibleTransportInput[] = []
  const recordUsageCalls: RecordUsageInput[] = []
  const leaseScopes: unknown[] = []
  const requestBody = {
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
  }

  const response = await requestChatCompletions(
    createProxyApp({
      recordUsageCalls,
      leaseScopes,
      transport: {
        async chatCompletions(input: OpenAiCompatibleTransportInput) {
          transportCalls.push(input)
          return {
            status: 200,
            headers: {
              "x-upstream-request-id": "custom_req_usage_1",
            },
            body: {
              id: "chatcmpl_custom_1",
              object: "chat.completion",
              model: "custom-model",
              usage: {
                prompt_tokens: 13,
                completion_tokens: 8,
              },
            },
          }
        },
      },
    }),
    requestBody,
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: "chatcmpl_custom_1",
    object: "chat.completion",
    model: "custom-model",
    usage: {
      prompt_tokens: 13,
      completion_tokens: 8,
    },
  })
  assert.deepEqual(transportCalls, [
    {
      apiKey: "sk-custom",
      baseUrl: "https://custom.example.test/v1",
      body: requestBody,
    },
  ])
  assert.deepEqual(leaseScopes, [
    {
      ownerUserId: "user_gateway",
      bindingOwnerUserId: "platform:openai_compatible",
      requiredBindingId: "binding_custom_1",
      provider: "openai_compatible",
      sessionId: "session_custom_1",
    },
  ])
  assert.deepEqual(recordUsageCalls, [
    {
      requestId: "custom_req_usage_1",
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
  ])
})

test("openai-compatible proxy rejects requests when provider assignment does not match the route", async () => {
  const response = await requestChatCompletions(
    createProxyApp({
      aiAccess: createAiAccess({
        provider: "openai",
        credentialId: "cred_openai_1",
        defaultModel: "gpt-4o-mini",
        allowedModels: ["gpt-4o-mini"],
      }),
    }),
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    },
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: "provider_not_assigned" })
})

test("openai-compatible proxy rejects assignments without a credential id", async () => {
  const response = await requestChatCompletions(
    createProxyApp({
      aiAccess: createAiAccess({ credentialId: null }),
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "assigned_credential_unavailable" })
})

test("openai-compatible proxy rejects stored secrets with the wrong kind", async () => {
  const response = await requestChatCompletions(
    createProxyApp({
      secret: {
        kind: "api_key",
        apiKey: "sk-not-custom",
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "invalid_custom_provider_config" })
})

test("openai-compatible proxy sanitizes upstream error bodies that may echo secrets", async () => {
  const response = await requestChatCompletions(
    createProxyApp({
      transport: {
        async chatCompletions() {
          throw new ProviderTransportError("upstream rejected request", {
            statusCode: 401,
            body: {
              error: {
                message: "request failed with Authorization: Bearer sk-custom",
                headers: {
                  authorization: "Bearer sk-custom",
                },
              },
            },
          })
        },
      },
    }),
  )

  const responseText = await response.text()
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(responseText), { error: "openai_compatible_upstream_error" })
  assert.equal(responseText.includes("sk-custom"), false)
  assert.equal(responseText.includes("Authorization"), false)
})

test("openai-compatible transport appends chat completions path and sends bearer auth", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const transport = new OpenAiCompatibleTransport(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ id: "chatcmpl_transport_1" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "transport_req_1",
      },
    })
  })

  const result = await transport.chatCompletions({
    apiKey: "sk-custom",
    baseUrl: "https://custom.example.test/v1///",
    body: { model: "custom-model" },
  })

  assert.deepEqual(calls, [
    {
      url: "https://custom.example.test/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-custom",
        },
        body: JSON.stringify({ model: "custom-model" }),
      },
    },
  ])
  assert.deepEqual(result, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "transport_req_1",
    },
    body: {
      id: "chatcmpl_transport_1",
    },
  })
})

test("openai-compatible transport throws provider transport error with upstream body and headers", async () => {
  const transport = new OpenAiCompatibleTransport(async () => new Response(
    JSON.stringify({ error: { message: "bad key" } }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "x-request-id": "transport_req_error_1",
      },
    },
  ))

  await assert.rejects(
    () => transport.chatCompletions({
      apiKey: "sk-custom",
      baseUrl: "https://custom.example.test/v1",
      body: { model: "custom-model" },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ProviderTransportError, true)
      assert.equal((error as ProviderTransportError).message, "openai_compatible_upstream_401")
      assert.equal((error as ProviderTransportError).statusCode, 401)
      assert.deepEqual((error as ProviderTransportError).body, { error: { message: "bad key" } })
      assert.deepEqual((error as ProviderTransportError).headers, {
        "content-type": "application/json",
        "x-request-id": "transport_req_error_1",
      })
      return true
    },
  )
})

test("openai-compatible transport preserves non-OK status when JSON body is malformed", async () => {
  const transport = new OpenAiCompatibleTransport(async () => new Response(
    "{not-json",
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-request-id": "transport_req_malformed_1",
      },
    },
  ))

  await assert.rejects(
    () => transport.chatCompletions({
      apiKey: "sk-custom",
      baseUrl: "https://custom.example.test/v1",
      body: { model: "custom-model" },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ProviderTransportError, true)
      assert.equal((error as ProviderTransportError).message, "openai_compatible_upstream_503")
      assert.equal((error as ProviderTransportError).statusCode, 503)
      assert.equal((error as ProviderTransportError).body, "{not-json")
      assert.deepEqual((error as ProviderTransportError).headers, {
        "content-type": "application/json",
        "x-request-id": "transport_req_malformed_1",
      })
      return true
    },
  )
})
