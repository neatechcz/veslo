import assert from "node:assert/strict"
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
        inputTokens: undefined,
        outputTokens: undefined,
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("codex_oauth proxy returns structured worker failures for authenticated callers", async () => {
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
          throw new ProviderTransportError("codex_worker_failed", {
            statusCode: 502,
            code: "codex_worker_failed",
            body: {
              error: "codex_worker_failed",
              timedOut: false,
              exitCode: 1,
              stderrTail: "Error: Please run `codex login`.\nAuthentication required.",
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
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: "codex_worker_failed",
      timedOut: false,
      exitCode: 1,
      stderrTail: "Error: Please run `codex login`.\nAuthentication required.",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
