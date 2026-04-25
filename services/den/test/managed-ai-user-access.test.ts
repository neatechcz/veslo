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

const { createUserCredentialsRouter } = await import("../src/managed-ai/http/user-credentials.js")

function createAiAccessRecord(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_123",
    userId: "user_123",
    enabled: true,
    provider: "openai",
    credentialId: null,
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini"],
    createdAt: new Date("2026-04-10T10:00:00.000Z"),
    updatedAt: new Date("2026-04-10T10:05:00.000Z"),
    ...overrides,
  }
}

test("GET /api/me/ai-access returns the authenticated user's managed ai access", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createUserCredentialsRouter({
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, "den_token_123")
          return {
            token,
            user: {
              id: "user_123",
              email: "user@example.test",
            },
          }
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, "user_123")
          return createAiAccessRecord()
        },
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: {
        authorization: "Bearer den_token_123",
      },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: {
        id: "ai_access_user_123",
        userId: "user_123",
        enabled: true,
        provider: "openai",
        credentialId: null,
        defaultModel: "gpt-4o-mini",
        allowedModels: ["gpt-4o-mini"],
        updatedAt: "2026-04-10T10:05:00.000Z",
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
