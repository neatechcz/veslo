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
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
    updatedAt: "2026-04-10T10:05:00.000Z",
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      aiAccess: createAiAccess(),
    })
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
              defaultModel: "claude-3-7-sonnet",
              allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
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
              defaultModel: "gpt-5.4",
              allowedModels: ["gpt-5.4"],
            })
            return {
              id: "ai_access_user_123",
              userId: input.userId,
              enabled: input.enabled,
              provider: input.provider,
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
