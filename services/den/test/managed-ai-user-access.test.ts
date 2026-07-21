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
const { SessionPolicyRejectionError } = await import("../src/http/email-verification.js")

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

test("GET /api/me/ai-access returns gateway effectiveModel and ignores legacy model columns", async () => {
  let repairCalls = 0
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
          return createAiAccessRecord({ provider: "codex_oauth", credentialId: "cred_legacy" })
        },
      },
      autoAssignedCodexCredentialRotation: {
        async repairCodexAccess(input) {
          repairCalls += 1
          return input.aiAccess
        },
      },
      modelPolicy: {
        async getPolicy() {
          return {
            activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
          }
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
        provider: "codex_oauth",
        credentialId: "cred_legacy",
        effectiveModel: { provider: "codex_oauth", model: "gpt-5.4" },
        updatedAt: "2026-04-10T10:05:00.000Z",
      },
    })
    assert.equal(repairCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /api/me/ai-access fails explicitly when gateway policy compatibility data is unavailable", async () => {
  let repairCalls = 0
  const app = express()
  app.use(express.json())
  app.use(
    createUserCredentialsRouter({
      sessionResolver: {
        async resolveSession(token: string) {
          return { token, user: { id: "user_123", email: "user@example.test" } }
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccessRecord({ provider: "codex_oauth", credentialId: "cred_legacy" })
        },
      },
      autoAssignedCodexCredentialRotation: {
        async repairCodexAccess(input) {
          repairCalls += 1
          return input.aiAccess
        },
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: { authorization: "Bearer den_token_123" },
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "platform_model_policy_not_configured" })
    assert.equal(repairCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /api/me/ai-access preserves an email-verification-required session rejection", async () => {
  const app = express()
  app.use(
    createUserCredentialsRouter({
      sessionResolver: {
        async resolveSession() {
          throw new SessionPolicyRejectionError({
            status: 403,
            body: {
              error: "email_verification_required",
              message: "Verify your email to continue.",
              email: "user@example.com",
            },
          })
        },
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: { authorization: "Bearer den_token_123" },
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: "email_verification_required",
      message: "Verify your email to continue.",
      email: "user@example.com",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
