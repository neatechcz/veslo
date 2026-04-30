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
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
    updatedAt: "2026-04-10T10:05:00.000Z",
  }
}

function createAvailableCredentials() {
  return [
    { id: "cred_codex_123", name: "Shared Codex A" },
    { id: "cred_codex_456", name: "Shared Codex B" },
  ]
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

test("PUT /admin/api/users/:userId/ai-access returns available codex credentials for the editor", async () => {
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
              defaultModel: input.defaultModel,
              allowedModels: input.allowedModels,
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...createAiAccess(),
        userId: "user_123",
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      },
      availableCredentials: [{ id: "cred_codex_123", name: "Shared Codex A" }],
    })
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
      { id: "cred_codex_available", name: "Shared Codex Available" },
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

test("PUT /admin/api/users/:userId/ai-access persists the admin managed policy", async () => {
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
              defaultModel: "claude-3-7-sonnet",
              allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: input.defaultModel,
              allowedModels: input.allowedModels,
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
          defaultModel: "claude-3-7-sonnet",
          allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
        }),
      })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...createAiAccess(),
        userId: "user_123",
        provider: "anthropic",
        credentialId: "cred_anthropic_123",
        defaultModel: "claude-3-7-sonnet",
        allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
      },
    })
    assert.deepEqual(auditCalls, [
      {
        actorUserId: "admin@example.test",
        action: "user.ai_access.update",
        entityType: "user",
        entityId: "user_123",
        result: "ok",
        summary: "Updated AI access for user user_123.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access accepts codex_oauth provider", async () => {
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
              defaultModel: "gpt-5.4",
              allowedModels: ["gpt-5.4"],
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
              credentialId: input.credentialId,
              defaultModel: input.defaultModel,
              allowedModels: input.allowedModels,
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
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...createAiAccess(),
        userId: "user_123",
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects exhausted codex_oauth credentials", async () => {
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "ineligible_ai_access_credential_id",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("PUT /admin/api/users/:userId/ai-access rejects enabled codex_oauth without credentialId", async () => {
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "invalid_ai_access_credential_id",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
