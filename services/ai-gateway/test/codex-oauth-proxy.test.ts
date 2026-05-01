import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import type { UserAiAccessPolicyRecord } from "../src/access/repository.js"
import { getPlatformCredentialOwnerUserId } from "../src/credentials/platform-owner.js"
import type { CredentialBinding, CredentialRecord } from "../src/credentials/repository.js"
import { createApp } from "../src/index.js"
import { ProviderTransportError } from "../src/providers/transport.js"
import type { RecordUsageInput } from "../src/usage/repository.js"

function createCredentialRecord(): CredentialRecord {
  return {
    id: "cred_codex_1",
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_codex_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    lastFailureAt: null,
  }
}

function createAiAccess(): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_1",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
  }
}

function createCredentialBinding(): CredentialBinding {
  return {
    id: "binding_codex_primary",
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialRecordId: "cred_codex_1",
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    updatedAt: new Date("2026-04-10T00:00:00.000Z"),
  }
}

async function withMutedConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = originalConsoleError
  }
}

test("codex_oauth proxy forwards through the worker transport with a sticky lease", async () => {
  const recordUsageCalls: RecordUsageInput[] = []
  const leaseScopes: Array<{
    ownerUserId: string
    bindingOwnerUserId?: string
    requiredBindingId?: string
    provider: string
    sessionId: string
  }> = []
  const transportBodies: unknown[] = []
  const transportAuthJson: Array<string | null | undefined> = []
  const secretAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "proxy-refresh-token" },
  })

  const app = createApp({
    proxy: {
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
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_codex_1")
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: secretAuthJson,
          }
        },
      },
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
        async chatCompletions(input: { body: unknown; authJson?: string | null }) {
          transportBodies.push(input.body)
          transportAuthJson.push(input.authJson)
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
              usage: {
                prompt_tokens: 30,
                completion_tokens: 9,
                total_tokens: 39,
                prompt_tokens_details: {
                  cached_tokens: 21,
                },
              },
            },
          }
        },
      },
    } as never,
  })

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
    assert.equal((await response.json()).choices[0].message.content, "ok")
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
        requiredBindingId: "binding_codex_primary",
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
    assert.deepEqual(transportAuthJson, [secretAuthJson])
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_usage_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_1",
        credentialId: "cred_codex_1",
        bindingId: "binding_codex_primary",
        model: "gpt-5.4",
        inputTokens: 30,
        outputTokens: 9,
        cachedTokens: 21,
        totalTokens: 39,
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy records usage metadata from streaming worker responses", async () => {
  const recordUsageCalls: RecordUsageInput[] = []

  const app = createApp({
    proxy: {
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
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId() {
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get() {
          return {
            kind: "codex_auth_json",
            authJson: "{}",
          }
        },
      },
      usageRepository: {
        async recordUsage(input: RecordUsageInput) {
          recordUsageCalls.push(input)
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
          return {
            id: "lease_codex_1",
            ownerUserId: scope.ownerUserId,
            provider: scope.provider,
            sessionId: scope.sessionId,
            activeBindingId: "binding_codex_primary",
          }
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in streaming usage test")
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
        async chatCompletions() {
          return {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": "codex_req_stream_usage_1",
            },
            body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            usage: {
              inputTokens: 17,
              outputTokens: 6,
              cachedTokens: 11,
              totalTokens: 23,
            },
          }
        },
      },
    } as never,
  })

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_stream_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_stream_usage_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_stream_1",
        credentialId: "cred_codex_1",
        bindingId: "binding_codex_primary",
        model: "gpt-5.4",
        inputTokens: 17,
        outputTokens: 6,
        cachedTokens: 11,
        totalTokens: 23,
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy rewrites unresolved opencode session placeholders to a user-scoped lease id", async () => {
  const leaseScopes: Array<{
    ownerUserId: string
    bindingOwnerUserId?: string
    requiredBindingId?: string
    provider: string
    sessionId: string
  }> = []

  const app = createApp({
    proxy: {
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
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_codex_1")
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                id_token: "id_token",
                access_token: "access_token",
                refresh_token: "refresh_token",
                account_id: "account_id",
              },
            }),
          }
        },
      },
      usageRepository: {
        async recordUsage() {},
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
        async chatCompletions() {
          return {
            status: 200,
            body: {
              id: "chatcmpl_codex_usage_2",
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
    } as never,
  })

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, "ok")
    assert.deepEqual(leaseScopes, [
      {
        ownerUserId: "user_gateway",
        bindingOwnerUserId: getPlatformCredentialOwnerUserId("codex_oauth"),
        requiredBindingId: "binding_codex_primary",
        provider: "codex_oauth",
        sessionId:
          "veslo_fallback_codex_oauth_" +
          createHash("sha256").update("user_gateway").update("\0").update("codex_oauth").digest("hex").slice(0, 16),
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy returns structured runtime incompatibility failures for authenticated callers", async () => {
  const app = createApp({
    proxy: {
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
          return {
            ...createAiAccess(),
            allowedModels: ["gpt-5.4", "gpt-5.5"],
          }
        },
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_codex_1")
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                id_token: "id_token",
                access_token: "access_token",
                refresh_token: "refresh_token",
                account_id: "account_id",
              },
            }),
          }
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when the worker transport fails")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
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
        async chatCompletions() {
          throw new ProviderTransportError("codex_runtime_incompatible", {
            statusCode: 502,
            code: "codex_runtime_incompatible",
            body: {
              error: {
                code: "codex_runtime_incompatible",
                type: "runtime_incompatible",
                message:
                  "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.",
              },
            },
          })
        },
      },
    } as never,
  })

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
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: {
        code: "codex_runtime_incompatible",
        type: "runtime_incompatible",
        message:
          "The Codex runtime bundled with Veslo is too old for gpt-5.5. Update Veslo to a build with the current veslo-code/Codex runtime, then retry.",
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy preserves transport failures with colliding exhaustion messages", async () => {
  const app = createApp({
    proxy: {
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
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_codex_1")
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: "{}",
          }
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when the worker transport fails")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease(scope) {
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
        async chatCompletions() {
          throw new ProviderTransportError("no_eligible_codex_credentials:transport_collision", {
            statusCode: 429,
            code: "codex_transport_rate_limited",
            body: {
              error: {
                code: "codex_transport_rate_limited",
                type: "rate_limit",
                message: "Codex transport rate limited.",
              },
            },
          })
        },
      },
    } as never,
  })

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_transport_collision_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), {
      error: {
        code: "codex_transport_rate_limited",
        type: "rate_limit",
        message: "Codex transport rate limited.",
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy returns no eligible credential when the assigned credential is exhausted", async () => {
  const app = createApp({
    proxy: {
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
        async upsertUserAiAccess() {
          throw new Error("unused")
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId(bindingId: string) {
          assert.equal(bindingId, "binding_codex_primary")
          return createCredentialRecord()
        },
        async getBindingByCredentialId(credentialId: string) {
          assert.equal(credentialId, "cred_codex_1")
          return createCredentialBinding()
        },
        async markCredentialState() {},
      },
      secrets: {
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_codex_1")
          return {
            kind: "codex_auth_json",
            authJson: "{}",
          }
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when no Codex credential is eligible")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          throw new Error("no_eligible_codex_credentials:assigned_credential_exhausted")
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
        async chatCompletions() {
          assert.fail("codex transport should not run when no Codex credential is eligible")
        },
      },
    } as never,
  })

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await withMutedConsoleError(async () =>
      fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-access-token",
          "content-type": "application/json",
          "x-veslo-session-id": "session_codex_exhausted_1",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: "no_eligible_codex_credentials",
      reason: "no_eligible_binding",
      provider: "codex_oauth",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy returns all credentials exhausted when auto-selectable credentials are exhausted", async () => {
  const app = createApp({
    proxy: {
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
      credentials: {
        async getCredentialRecordById() {
          return null
        },
        async listHealthyCredentialRecordIds() {
          return []
        },
        async getCredentialRecordByBindingId() {
          assert.fail("assigned credential lookup should not run for auto-selection")
        },
        async getBindingByCredentialId() {
          assert.fail("assigned binding lookup should not run for auto-selection")
        },
        async markCredentialState() {},
      },
      secrets: {
        async get() {
          assert.fail("secret store should not run when auto-selection fails")
        },
      },
      usageRepository: {
        async recordUsage() {
          assert.fail("usage should not be recorded when all Codex credentials are exhausted")
        },
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          throw new Error("no_eligible_codex_credentials:all_codex_credentials_exhausted")
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
        async chatCompletions() {
          assert.fail("codex transport should not run when all Codex credentials are exhausted")
        },
      },
    } as never,
  })

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await withMutedConsoleError(async () =>
      fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-access-token",
          "content-type": "application/json",
          "x-veslo-session-id": "session_codex_exhausted_2",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: "no_eligible_codex_credentials",
      reason: "all_codex_credentials_exhausted",
      provider: "codex_oauth",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
