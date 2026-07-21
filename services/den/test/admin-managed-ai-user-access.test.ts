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

function createAiAccess() {
  return {
    id: "ai_access_user_123",
    userId: "user_123",
    enabled: true,
    provider: "openai",
    credentialId: "cred_openai_123",
    updatedAt: "2026-04-10T10:05:00.000Z",
  }
}

function createAvailableCredentials() {
  return [
    { id: "cred_codex_123", name: "Shared Codex A", provider: "codex_oauth" },
    { id: "cred_codex_456", name: "Shared Codex B", provider: "codex_oauth" },
  ]
}

function createAdminCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred_codex_123",
    name: "Shared Codex A",
    provider: "codex_oauth",
    type: "oauth",
    state: "healthy",
    scope: "platform:codex_oauth",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-10T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  }
}

test("GET /admin/api/users/:userId/ai-access returns the stored ai access policy", async () => {
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
        aiAccess: {
          async getUserAiAccess(userId: string) {
            assert.equal(userId, "user_123")
            return {
              ...createAiAccess(),
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                id: "cred_codex_123",
                name: "Shared Codex A",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
              {
                id: "cred_codex_456",
                name: "Shared Codex B",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus() {
            return {
              available: true,
              source: "codex_exec_no_rate_limits",
              label: "Codex OK, limits unknown",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: null,
                weekly: null,
              },
            }
          },
        },
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: createAiAccess(),
      availableCredentials: createAvailableCredentials(),
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/users/:userId/ai-access does not mutate Codex assignments during compatibility reads", async () => {
  const session = createSession()
  const upserts: unknown[] = []
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
        aiAccess: {
          async getUserAiAccess(userId: string) {
            assert.equal(userId, "user_123")
            return {
              id: "ai_access_user_123",
              userId,
              enabled: true,
              provider: "codex_oauth",
              credentialId: "cred_old",
              defaultModel: "gpt-5.5",
              allowedModels: ["gpt-5.5"],
              assignmentOrigin: "admin_assigned",
              createdAt: new Date("2026-05-07T08:00:00.000Z"),
              updatedAt: new Date("2026-05-07T08:00:00.000Z"),
            }
          },
          async upsertUserAiAccess(input) {
            upserts.push(input)
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: null,
              allowedModels: [],
              assignmentOrigin: input.assignmentOrigin,
              createdAt: new Date("2026-05-07T08:00:00.000Z"),
              updatedAt: new Date("2026-05-07T09:00:00.000Z"),
            }
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async getCredentialRecordById(credentialId: string) {
            if (credentialId === "cred_old") {
              return createAdminCredential({
                id: "cred_old",
                name: "Shared Michal CODEX",
                state: "unhealthy",
              })
            }
            if (credentialId === "cred_new") {
              return createAdminCredential({
                id: "cred_new",
                name: "Share Vaclav CODEX - new",
                state: "healthy",
              })
            }
            return null
          },
          async listAdminCredentials() {
            return [
              createAdminCredential({
                id: "cred_old",
                name: "Shared Michal CODEX",
                state: "unhealthy",
              }),
              createAdminCredential({
                id: "cred_new",
                name: "Share Vaclav CODEX - new",
                state: "healthy",
              }),
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus(input) {
            return {
              available: input.credentialId === "cred_new",
              source: input.credentialId === "cred_new" ? "codex_exec_no_rate_limits" : "unavailable",
              label: input.credentialId === "cred_new" ? "Codex OK, limits unknown" : "Codex unavailable",
              detail: input.credentialId === "cred_new" ? null : "invalid_grant",
              checkedAt: "2026-05-07T09:00:00.000Z",
              limits: input.credentialId === "cred_new"
                ? {
                    fiveHour: null,
                    weekly: null,
                  }
                : undefined,
            }
          },
        },
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.aiAccess.credentialId, "cred_old")
    assert.deepEqual(upserts, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects legacy editor routing fields", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess(input) {
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: null,
              allowedModels: [],
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                id: "cred_codex_123",
                name: "Shared Codex A",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus() {
            return {
              available: true,
              source: "codex_exec_no_rate_limits",
              label: "Codex OK, limits unknown",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: null,
                weekly: null,
              },
            }
          },
        },
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const legacyResponse = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    })
    assert.equal(legacyResponse.status, 400)
    assert.deepEqual(await legacyResponse.json(), { error: "user_ai_access_routing_not_supported" })

    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "user_ai_access_routing_not_supported" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/users/:userId/ai-access hides exhausted Codex credentials", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            return {
              ...createAiAccess(),
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                id: "cred_codex_available",
                name: "Shared Codex Available",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 1,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
              {
                id: "cred_codex_exhausted",
                name: "Shared Codex Exhausted",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus(input) {
            return {
              available: true,
              source: "codex_exec_rate_limits",
              label: "Codex limits available",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: input.credentialId === "cred_codex_exhausted"
                  ? {
                      label: "5h",
                      usedPercent: 100,
                      windowMinutes: 300,
                      resetAt: "2026-04-28T11:00:00.000Z",
                    }
                  : null,
                weekly: null,
              },
            }
          },
        },
        now: () => new Date("2026-04-28T10:00:00.000Z"),
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`)

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).availableCredentials, [
      { id: "cred_codex_available", name: "Shared Codex Available", provider: "codex_oauth" },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/users/:userId/ai-access hides Codex credentials when no status provider is available", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            return {
              ...createAiAccess(),
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                id: "cred_codex_unprobed",
                name: "Shared Codex Unprobed",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: null,
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`)

    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).availableCredentials, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects client-supplied Anthropic routing", async () => {
  const session = createSession()
  const auditCalls: Array<{
    actorUserId?: string | null
    action: string
    entityType: string
    entityId: string
    result: "ok" | "warning" | "error"
    summary?: string | null
  }> = []
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess(input) {
            assert.deepEqual(input, {
              userId: "user_123",
              enabled: true,
              provider: "anthropic",
              credentialId: "cred_anthropic_123",
              assignmentOrigin: "admin_assigned",
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: null,
              allowedModels: [],
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
          },
        },
        alerts: {
          async listAlerts() {
            return []
          },
        },
        audit: {
          async recordEvent(input) {
            auditCalls.push(input)
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
        body: JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialId: "cred_anthropic_123",
        }),
      })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "user_ai_access_routing_not_supported" })
    assert.deepEqual(auditCalls, [])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects client-supplied Codex routing", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess(input) {
            assert.deepEqual(input, {
              userId: "user_123",
              enabled: true,
              provider: "codex_oauth",
              credentialId: "cred_codex_123",
              assignmentOrigin: "admin_assigned",
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: null,
              allowedModels: [],
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createAdminCredential()]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus() {
            return {
              available: true,
              source: "codex_exec_no_rate_limits",
              label: "Codex OK, limits unknown",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: null,
                weekly: null,
              },
            }
          },
        },
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "user_ai_access_routing_not_supported" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects client-supplied OpenAI-compatible provider", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return []
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "openai_compatible",
        credentialId: null,
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "user_ai_access_routing_not_supported",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects even healthy client-supplied credentials", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess(input) {
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: null,
              allowedModels: [],
              createdAt: new Date("2026-04-10T10:00:00.000Z"),
              updatedAt: new Date("2026-04-10T10:05:00.000Z"),
            }
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              createAdminCredential({
                id: "cred_custom_1",
                name: "Custom OpenAI-Compatible",
                provider: "openai_compatible",
                type: "api_key",
                scope: "platform:openai_compatible",
              }),
            ]
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "openai_compatible",
        credentialId: "cred_custom_1",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "user_ai_access_routing_not_supported" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects routing before provider credential validation", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [createAdminCredential({ id: "cred_codex_healthy", name: "Shared Codex Healthy" })]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus() {
            return {
              available: true,
              source: "codex_exec_no_rate_limits",
              label: "Codex OK, limits unknown",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: null,
                weekly: null,
              },
            }
          },
        },
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "openai_compatible",
        credentialId: "cred_codex_healthy",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "user_ai_access_routing_not_supported",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects routing before credential health validation", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              createAdminCredential({
                id: "cred_custom_unhealthy",
                name: "Unhealthy OpenAI-Compatible",
                provider: "openai_compatible",
                type: "api_key",
                state: "unhealthy",
                scope: "platform:openai_compatible",
              }),
            ]
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "openai_compatible",
        credentialId: "cred_custom_unhealthy",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "user_ai_access_routing_not_supported",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects routing before Codex capacity validation", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess() {
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
          async listEvents() {
            return []
          },
        },
        credentials: {
          async listAdminCredentials() {
            return [
              {
                id: "cred_codex_exhausted",
                name: "Shared Codex Exhausted",
                provider: "codex_oauth",
                type: "oauth",
                state: "healthy",
                scope: "platform:codex_oauth",
                activeLeases: 0,
                alertCount: 0,
                lastRefreshAt: "2026-04-10T10:00:00.000Z",
                lastFailureAt: null,
                totalTokens: 0,
                nextRotationAt: null,
                linkedAlertIds: [],
              },
            ]
          },
        } as any,
        leases: {} as any,
        secrets: {} as any,
        usage: {} as any,
        codexStatusProvider: {
          async getStatus() {
            return {
              available: true,
              source: "codex_exec_rate_limits",
              label: "Codex limits available",
              detail: null,
              checkedAt: "2026-04-28T10:00:00.000Z",
              limits: {
                fiveHour: {
                  label: "5h",
                  usedPercent: 100,
                  windowMinutes: 300,
                  resetAt: "2026-04-28T11:00:00.000Z",
                },
                weekly: null,
              },
            }
          },
        },
        now: () => new Date("2026-04-28T10:00:00.000Z"),
      }),
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_exhausted",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "user_ai_access_routing_not_supported",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects provider fields regardless of credential presence", async () => {
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
        aiAccess: {
          async getUserAiAccess() {
            throw new Error("unused")
          },
          async upsertUserAiAccess() {
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "user_ai_access_routing_not_supported",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
