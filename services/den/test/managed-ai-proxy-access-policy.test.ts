import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import type { UserAiAccessPolicyRecord } from "../src/managed-ai/access/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")

function createAiAccess(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_gateway",
    userId: "user_gateway",
    enabled: true,
    provider: "anthropic",
    defaultModel: "claude-3-7-sonnet",
    allowedModels: ["claude-3-7-sonnet"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:00:00.000Z"),
    ...overrides,
  }
}

function createPolicyApp(aiAccess: UserAiAccessPolicyRecord | null) {
  const app = express()
  app.use(express.json())
  app.use(
    createProxyRouter({
      gatewaySessions: {
        async resolveSession() {
          return {
            token: "gateway-access-token",
            user: {
              id: "user_gateway",
              email: "gateway@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return aiAccess
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
          return null
        },
        async markCredentialState() {},
      },
      usageRepository: {
        async recordUsage() {},
      },
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run for rejected policy requests")
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not run for rejected policy requests")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for rejected policy requests")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not run for anthropic policy tests")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not run for rejected policy requests")
        },
      },
    } as never),
  )
  return app
}

test("anthropic proxy rejects requests when provider assignment does not match the route", async () => {
  const server = createPolicyApp(
    createAiAccess({
      provider: "openai",
      defaultModel: "gpt-4o-mini",
      allowedModels: ["gpt-4o-mini"],
    }),
  ).listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_1",
      },
      body: JSON.stringify({
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "provider_not_assigned" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("anthropic proxy rejects requests when the requested model is not allowed", async () => {
  const server = createPolicyApp(createAiAccess()).listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
        "x-veslo-session-id": "session_policy_2",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "model_not_allowed" })
  } finally {
    server.close()
    await once(server, "close")
  }
})
