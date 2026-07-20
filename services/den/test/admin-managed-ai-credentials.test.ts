import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"
import { createManagedAiAdminRouteDeps } from "../src/managed-ai/http/admin.js"

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

function createCredential() {
  return {
    id: "cred_platform_openai_1",
    name: "Shared OpenAI key",
    provider: "openai",
    type: "api_key",
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

function createCodexCredential() {
  return {
    id: "cred_platform_codex_1",
    name: "Shared Codex runtime",
    provider: "codex_oauth",
    type: "oauth",
    state: "healthy",
    scope: "platform:codex_oauth",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-10T14:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}

function createCodexCredentialRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred_platform_codex_1",
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: "secret_codex_1",
    name: "Shared Codex runtime",
    createdAt: new Date("2026-04-10T14:00:00.000Z"),
    updatedAt: new Date("2026-04-10T14:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  }
}

function createOpenAiCompatibleCredential() {
  return {
    id: "cred_platform_openai_compatible_1",
    name: "Compatible key",
    provider: "openai_compatible",
    type: "api_key",
    state: "healthy",
    scope: "platform:openai_compatible",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-10T14:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}

test("POST /admin/api/credentials creates a platform credential", async () => {
  const session = createSession()
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
    audit: [] as Array<{
      actorUserId?: string | null
      action: string
      entityType: string
      entityId: string
      result: "ok" | "warning" | "error"
      summary?: string | null
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent(input) {
            calls.audit.push(input)
          },
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            return {
              id: "cred_platform_openai_1",
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
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            return { secretRef: "secret_admin_1" }
          },
        } as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openai",
        name: "Shared OpenAI key",
        secret: "sk-live-openai",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credential: createCredential(),
    })
    assert.deepEqual(calls.secrets, [{ kind: "api_key", apiKey: "sk-live-openai" }])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:openai",
        provider: "openai",
        credentialType: "api_key",
        secretRef: "secret_admin_1",
        name: "Shared OpenAI key",
      },
    ])
    assert.deepEqual(calls.audit, [
      {
        actorUserId: "admin@example.test",
        action: "credential.create",
        entityType: "credential",
        entityId: "cred_platform_openai_1",
        result: "ok",
        summary: "Created openai credential cred_platform_openai_1.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials creates an openai-compatible platform credential", async () => {
  const session = createSession()
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string; baseUrl?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {},
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createOpenAiCompatibleCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            return {
              id: "cred_platform_openai_compatible_1",
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
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            return { secretRef: "secret_compatible_1" }
          },
        } as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openai_compatible",
        name: "Compatible key",
        secret: "sk-compatible",
        baseUrl: "https://api.example.test/v1/",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credential: createOpenAiCompatibleCredential(),
    })
    assert.deepEqual(calls.secrets, [
      {
        kind: "openai_compatible_api_key",
        apiKey: "sk-compatible",
        baseUrl: "https://api.example.test/v1",
      },
    ])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:openai_compatible",
        provider: "openai_compatible",
        credentialType: "api_key",
        secretRef: "secret_compatible_1",
        name: "Compatible key",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

for (const { name, body } of [
  {
    name: "missing baseUrl",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
    },
  },
  {
    name: "malformed baseUrl",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "not a url",
    },
  },
  {
    name: "hosted HTTP baseUrl",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "http://api.example.test/v1",
    },
  },
  {
    name: "baseUrl with query string",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "https://api.example.test/v1?x=1",
    },
  },
  {
    name: "baseUrl with empty query delimiter",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "https://api.example.test/v1?",
    },
  },
  {
    name: "baseUrl with fragment",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "https://api.example.test/v1#frag",
    },
  },
  {
    name: "baseUrl with empty fragment delimiter",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "https://api.example.test/v1#",
    },
  },
  {
    name: "baseUrl with userinfo",
    body: {
      provider: "openai_compatible",
      name: "Compatible key",
      secret: "sk-compatible",
      baseUrl: "https://user:pass@api.example.test/v1",
    },
  },
]) {
  test(`POST /admin/api/credentials rejects openai-compatible credentials with ${name}`, async () => {
    const session = createSession()
    const calls = {
      secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string; baseUrl?: string }>,
      credentials: [] as Array<{
        ownerUserId: string
        provider: string
        credentialType: "api_key" | "oauth"
        secretRef: string
        name: string
      }>,
    }
    const app = express()
    app.use(express.json())
    app.use(
      "/admin/api",
      createAdminRouter({
        async getSessionSnapshot() {
          return session
        },
        ...createManagedAiAdminRouteDeps({
          async getAdminSession() {
            return session
          },
          aiAccess: {} as any,
          alerts: {
            async listAlerts() {
              return []
            },
          },
          audit: {
            async recordEvent() {},
            async listEvents() {
              return []
            },
          },
          credentials: {
            async listAdminCredentials() {
              return []
            },
            async createPlatformCredential(input) {
              calls.credentials.push(input)
              throw new Error("unreachable")
            },
          } as any,
          leases: {} as any,
          secrets: {
            async put(secret) {
              calls.secrets.push(secret)
              throw new Error("unreachable")
            },
          } as any,
          usage: {} as any,
        }),
      }),
    )

    const server = app.listen(0, "127.0.0.1")
    await once(server, "listening")

    try {
      const { port } = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })

      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: "invalid_credential_base_url" })
      assert.deepEqual(calls.secrets, [])
      assert.deepEqual(calls.credentials, [])
    } finally {
      server.close()
      await once(server, "close")
    }
  })
}

test("POST /admin/api/credentials accepts local HTTP openai-compatible baseUrl", async () => {
  const session = createSession()
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string; baseUrl?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {},
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createOpenAiCompatibleCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            return {
              id: "cred_platform_openai_compatible_1",
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
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            return { secretRef: "secret_compatible_1" }
          },
        } as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openai_compatible",
        name: "Compatible key",
        secret: "sk-compatible",
        baseUrl: "http://127.0.0.1:1234/v1/",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(calls.secrets, [
      {
        kind: "openai_compatible_api_key",
        apiKey: "sk-compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    ])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:openai_compatible",
        provider: "openai_compatible",
        credentialType: "api_key",
        secretRef: "secret_compatible_1",
        name: "Compatible key",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials accepts IPv6 loopback HTTP openai-compatible baseUrl", async () => {
  const session = createSession()
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string; baseUrl?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {},
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createOpenAiCompatibleCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            return {
              id: "cred_platform_openai_compatible_1",
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
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            return { secretRef: "secret_compatible_1" }
          },
        } as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openai_compatible",
        name: "Compatible key",
        secret: "sk-compatible",
        baseUrl: "http://[::1]:1234/v1/",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(calls.secrets, [
      {
        kind: "openai_compatible_api_key",
        apiKey: "sk-compatible",
        baseUrl: "http://[::1]:1234/v1",
      },
    ])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:openai_compatible",
        provider: "openai_compatible",
        credentialType: "api_key",
        secretRef: "secret_compatible_1",
        name: "Compatible key",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials creates a shared codex_oauth credential", async () => {
  const session = createSession()
  const codexAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "codex-id-token",
      access_token: "codex-access-token",
      refresh_token: "codex-refresh-token",
      account_id: "acct_codex_runtime",
    },
  })
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
    audit: [] as Array<{
      actorUserId?: string | null
      action: string
      entityType: string
      entityId: string
      result: "ok" | "warning" | "error"
      summary?: string | null
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent(input) {
            calls.audit.push(input)
          },
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createCodexCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            return {
              id: "cred_platform_codex_1",
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
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            return { secretRef: "secret_codex_1" }
          },
        } as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "codex_oauth",
        name: "Shared Codex runtime",
        secret: codexAuthJson,
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credential: {
        ...createCodexCredential(),
        cachedTokens: 0,
        upstreamStatus: null,
        eligibility: {
          state: "unavailable",
          reason: "No upstream status.",
          resetAt: null,
        },
      },
    })
    assert.deepEqual(calls.secrets, [{ kind: "codex_auth_json", authJson: codexAuthJson }])
    assert.deepEqual(calls.credentials, [
      {
        ownerUserId: "platform:codex_oauth",
        provider: "codex_oauth",
        credentialType: "oauth",
        secretRef: "secret_codex_1",
        name: "Shared Codex runtime",
      },
    ])
    assert.deepEqual(calls.audit, [
      {
        actorUserId: "admin@example.test",
        action: "credential.create",
        entityType: "credential",
        entityId: "cred_platform_codex_1",
        result: "ok",
        summary: "Created codex_oauth credential cred_platform_codex_1.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PATCH /admin/api/credentials/:credentialId renames a credential", async () => {
  const session = createSession()
  let credentialName = "Vaclav CODEX"
  const calls = {
    rename: [] as Array<{ credentialId: string; name: string }>,
    audit: [] as Array<{
      actorUserId?: string | null
      action: string
      entityType: string
      entityId: string
      result: "ok" | "warning" | "error"
      summary?: string | null
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent(input) {
            calls.audit.push(input)
          },
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                ...createCodexCredential(),
                name: credentialName,
              },
            ]
          },
          async renameCredential(input) {
            calls.rename.push(input)
            credentialName = input.name
            return true
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_platform_codex_1`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Václav Codex",
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credential: {
        ...createCodexCredential(),
        name: "Václav Codex",
        cachedTokens: 0,
        upstreamStatus: null,
        eligibility: {
          state: "unavailable",
          reason: "No upstream status.",
          resetAt: null,
        },
      },
    })
    assert.deepEqual(calls.rename, [
      {
        credentialId: "cred_platform_codex_1",
        name: "Václav Codex",
      },
    ])
    assert.deepEqual(calls.audit, [
      {
        actorUserId: "admin@example.test",
        action: "credential.rename",
        entityType: "credential",
        entityId: "cred_platform_codex_1",
        result: "ok",
        summary: "Renamed credential cred_platform_codex_1.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("Codex auth upload session returns a local helper command for the selected credential", async () => {
  const session = createSession()
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {},
          async listEvents() {
            return []
          },
        },
        credentials: {
          async getCredentialRecordById(credentialId) {
            return credentialId === "cred_platform_codex_1" ? createCodexCredentialRecord({ name: "Václav Codex" }) as any : null
          },
          async listAdminCredentials() {
            return [
              {
                ...createCodexCredential(),
                name: "Václav Codex",
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        now: () => new Date("2026-06-17T08:00:00.000Z"),
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/admin/api/credentials/cred_platform_codex_1/codex-auth-upload-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
    )

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.match(payload.upload.token, /^[a-f0-9]{48}$/)
    assert.equal(payload.upload.credentialId, "cred_platform_codex_1")
    assert.equal(payload.upload.credentialName, "Václav Codex")
    assert.equal(payload.upload.expiresAt, "2026-06-17T08:20:00.000Z")
    assert.equal(
      payload.upload.uploadUrl,
      `http://127.0.0.1:${port}/admin/api/credentials/codex-auth-upload/${payload.upload.token}`,
    )
    assert.match(payload.command, /node scripts\/admin\/codex-auth-upload\.mjs/)
    assert.match(payload.command, new RegExp(`--upload-url '${payload.upload.uploadUrl}'`))
    assert.match(payload.command, /--credential-id 'cred_platform_codex_1'/)
    assert.match(payload.command, /--credential-name 'Václav Codex'/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("Codex auth upload replaces the selected credential secret and rejects token reuse", async () => {
  const session = createSession()
  let currentTime = new Date("2026-06-17T08:00:00.000Z")
  const codexAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "codex-id-token",
      access_token: "codex-access-token",
      refresh_token: "codex-refresh-token",
      account_id: "acct_codex_runtime",
    },
  })
  const calls = {
    secrets: [] as Array<{ secretRef: string; secret: { kind: string; authJson?: string } }>,
    states: [] as Array<{ credentialRecordId: string; state: string; reason?: string | null }>,
    audit: [] as Array<{
      actorUserId?: string | null
      action: string
      entityType: string
      entityId: string
      result: "ok" | "warning" | "error"
      summary?: string | null
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent(input) {
            calls.audit.push(input)
          },
          async listEvents() {
            return []
          },
        },
        credentials: {
          async getCredentialRecordById(credentialId) {
            return credentialId === "cred_platform_codex_1" ? createCodexCredentialRecord({ name: "Václav Codex" }) as any : null
          },
          async listAdminCredentials() {
            return [
              {
                ...createCodexCredential(),
                name: "Václav Codex",
              },
            ]
          },
          async markCredentialState(input) {
            calls.states.push(input)
          },
        } as any,
        leases: {} as any,
        secrets: {
          async replace(secretRef, secret) {
            calls.secrets.push({ secretRef, secret })
          },
        } as any,
        usage: {} as any,
        now: () => currentTime,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const sessionResponse = await fetch(
      `http://127.0.0.1:${port}/admin/api/credentials/cred_platform_codex_1/codex-auth-upload-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
    )
    assert.equal(sessionResponse.status, 200)
    const sessionPayload = await sessionResponse.json()
    const expiringSessionResponse = await fetch(
      `http://127.0.0.1:${port}/admin/api/credentials/cred_platform_codex_1/codex-auth-upload-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
    )
    assert.equal(expiringSessionResponse.status, 200)
    const expiringSessionPayload = await expiringSessionResponse.json()
    assert.equal(sessionPayload.upload.expiresAt, "2026-06-17T08:20:00.000Z")
    assert.equal(expiringSessionPayload.upload.expiresAt, "2026-06-17T08:20:00.000Z")

    currentTime = new Date("2026-06-17T08:19:59.000Z")
    const uploadResponse = await fetch(sessionPayload.upload.uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authJson: codexAuthJson,
      }),
    })

    assert.equal(uploadResponse.status, 200)
    assert.deepEqual(await uploadResponse.json(), {
      ok: true,
      credentialId: "cred_platform_codex_1",
      credentialName: "Václav Codex",
      accountId: "acct_codex_runtime",
    })
    assert.deepEqual(calls.secrets, [
      {
        secretRef: "secret_codex_1",
        secret: {
          kind: "codex_auth_json",
          authJson: codexAuthJson,
        },
      },
    ])
    assert.deepEqual(calls.states, [
      {
        credentialRecordId: "cred_platform_codex_1",
        state: "healthy",
        reason: "codex_auth_upload",
      },
    ])
    assert.deepEqual(calls.audit, [
      {
        actorUserId: "admin@example.test",
        action: "credential.codex_auth_upload_session.create",
        entityType: "credential",
        entityId: "cred_platform_codex_1",
        result: "ok",
        summary: "Created Codex auth upload session for credential cred_platform_codex_1.",
      },
      {
        actorUserId: "admin@example.test",
        action: "credential.codex_auth_upload_session.create",
        entityType: "credential",
        entityId: "cred_platform_codex_1",
        result: "ok",
        summary: "Created Codex auth upload session for credential cred_platform_codex_1.",
      },
      {
        actorUserId: "admin@example.test",
        action: "credential.codex_auth_upload",
        entityType: "credential",
        entityId: "cred_platform_codex_1",
        result: "ok",
        summary: "Uploaded Codex auth for credential cred_platform_codex_1.",
      },
    ])

    currentTime = new Date("2026-06-17T08:20:00.000Z")
    const expiredResponse = await fetch(expiringSessionPayload.upload.uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authJson: codexAuthJson,
      }),
    })

    assert.equal(expiredResponse.status, 404)
    assert.deepEqual(await expiredResponse.json(), { error: "codex_auth_upload_session_not_found" })

    const reusedResponse = await fetch(sessionPayload.upload.uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authJson: codexAuthJson,
      }),
    })

    assert.equal(reusedResponse.status, 404)
    assert.deepEqual(await reusedResponse.json(), { error: "codex_auth_upload_session_not_found" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials rejects partial codex_oauth auth json", async () => {
  const session = createSession()
  const partialCodexAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "codex-access-token",
      refresh_token: "codex-refresh-token",
    },
  })
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey?: string; authJson?: string }>,
    credentials: [] as Array<{
      ownerUserId: string
      provider: string
      credentialType: "api_key" | "oauth"
      secretRef: string
      name: string
    }>,
  }
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {},
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createCodexCredential()]
          },
          async createPlatformCredential(input) {
            calls.credentials.push(input)
            throw new Error("unreachable")
          },
        } as any,
        leases: {} as any,
        secrets: {
          async put(secret) {
            calls.secrets.push(secret)
            throw new Error("unreachable")
          },
        } as any,
      }),
    }),
  )
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "codex_oauth",
        name: "Broken Codex runtime",
        secret: partialCodexAuthJson,
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "invalid_credential_secret" })
    assert.deepEqual(calls.secrets, [])
    assert.deepEqual(calls.credentials, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/credentials rejects empty secrets", async () => {
  const session = createSession()
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent() {
            return
          },
          async listEvents() {
            return []
          },
        },
        credentials: {} as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "anthropic",
        name: "Shared Anthropic key",
        secret: "",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "invalid_credential_secret" })
  } finally {
    server.close()
    await once(server, "close")
  }
})
