import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
})

const { createManagedAiAdminUiRouter } = await import("../src/managed-ai/http/admin.js")

function createSession() {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  }
}

function createCredentialRecord() {
  return {
    id: "cred_platform_openai_oauth_1",
    name: "Shared OpenAI OAuth",
    provider: "openai",
    type: "oauth",
    state: "healthy",
    scope: "platform:openai",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-10T14:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}

test("POST /admin/api/credentials/openai/oauth/start returns an authorize url with a server-signed state", async () => {
  const calls: Array<{ state: string }> = []
  const app = express()
  app.use(express.json())
  app.use(
    createManagedAiAdminUiRouter({
      async getAdminSession() {
        return createSession()
      },
      openAiOAuth: {
        async startAuthorization(input) {
          calls.push(input)
          return {
            authorizeUrl: `https://auth.openai.com/oauth/authorize?state=${encodeURIComponent(input.state)}`,
          }
        },
        async exchangeCode() {
          throw new Error("unused")
        },
        async refreshToken() {
          throw new Error("unused")
        },
      },
      alerts: {
        async listAlerts() {
          return []
        },
      },
      audit: {
        async recordEvent() {
          return
        },
      },
      credentials: {
        async listAdminCredentials() {
          return []
        },
      } as any,
      secrets: {} as any,
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/openai/oauth/start`, {
      method: "POST",
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(typeof payload.state, "string")
    assert.match(payload.authorizeUrl, /auth\.openai\.com/)
    assert.match(payload.authorizeUrl, new RegExp(encodeURIComponent(payload.state)))
    assert.deepEqual(calls, [{ state: payload.state }])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials/openai/oauth/exchange persists the platform OAuth credential", async () => {
  const calls = {
    secrets: [] as Array<{
      kind: string
      accessToken: string
      refreshToken: string
      expiresAt: string
    }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
    audit: [] as Array<{ actorUserId?: string | null; action: string; entityId: string }>,
  }

  const app = express()
  app.use(express.json())
  app.use(
    createManagedAiAdminUiRouter({
      async getAdminSession() {
        return createSession()
      },
      openAiOAuth: {
        async startAuthorization(input) {
          return {
            authorizeUrl: `https://auth.openai.com/oauth/authorize?state=${encodeURIComponent(input.state)}`,
          }
        },
        async exchangeCode(input) {
          assert.equal(input.code, "openai_code_123")
          return {
            accessToken: "openai_access_token",
            refreshToken: "openai_refresh_token",
            expiresAt: "2026-04-10T16:00:00.000Z",
          }
        },
        async refreshToken() {
          throw new Error("unused")
        },
      },
      alerts: {
        async listAlerts() {
          return []
        },
      },
      audit: {
        async recordEvent(input) {
          calls.audit.push(input)
        },
      },
      credentials: {
        async listAdminCredentials() {
          return [createCredentialRecord()]
        },
        async createPlatformCredential(input) {
          calls.credentials.push(input)
          return {
            id: "cred_platform_openai_oauth_1",
            ownerUserId: input.ownerUserId,
            provider: input.provider,
            credentialType: input.credentialType,
            state: "healthy",
            secretRef: input.secretRef,
            name: input.name,
            createdAt: new Date("2026-04-10T14:00:00.000Z"),
            updatedAt: new Date("2026-04-10T14:00:00.000Z"),
            lastFailureAt: null,
          }
        },
      } as any,
      secrets: {
        async put(secret) {
          calls.secrets.push(secret)
          return { secretRef: "secret_openai_oauth_1" }
        },
      } as any,
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const startResponse = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/openai/oauth/start`, {
      method: "POST",
    })
    const startPayload = await startResponse.json()

    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/openai/oauth/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: "openai_code_123",
        state: startPayload.state,
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credential: createCredentialRecord(),
    })
    assert.deepEqual(calls.secrets, [
      {
        kind: "openai_oauth",
        accessToken: "openai_access_token",
        refreshToken: "openai_refresh_token",
        expiresAt: "2026-04-10T16:00:00.000Z",
      },
    ])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:openai",
        provider: "openai",
        credentialType: "oauth",
        secretRef: "secret_openai_oauth_1",
        name: "Shared OpenAI OAuth",
      },
    ])
    assert.deepEqual(calls.audit, [
      {
        actorUserId: "admin@example.test",
        action: "credential.openai_oauth.connect",
        entityType: "credential",
        entityId: "cred_platform_openai_oauth_1",
        result: "ok",
        summary: "Connected shared OpenAI OAuth credential cred_platform_openai_oauth_1.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})
