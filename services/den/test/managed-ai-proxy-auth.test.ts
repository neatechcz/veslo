import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createProxyRouter } = await import("../src/managed-ai/http/proxy.js")

function createProxyApp() {
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
          assert.fail("lease broker should not be reached in proxy auth tests")
        },
        async handleUpstreamFailure() {
          assert.fail("failure handler should not be reached in proxy auth tests")
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not be reached in proxy auth tests")
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be reached in proxy auth tests")
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be reached in proxy auth tests")
        },
      },
    } as never),
  )
  return app
}

test("provider proxy rejects requests without bearer auth", async () => {
  const server = createProxyApp().listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_auth_1",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("provider proxy rejects requests without x-veslo-session-id", async () => {
  const server = createProxyApp().listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "missing_session_id" })
  } finally {
    server.close()
    await once(server, "close")
  }
})
