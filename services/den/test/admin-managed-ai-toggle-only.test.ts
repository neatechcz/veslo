import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"
import { createManagedAiAdminRouteDeps } from "../src/managed-ai/http/admin.js"

function createHarness(withResolver: boolean) {
  const writes: unknown[] = []
  const session = {
    user: { id: "admin_1", email: "admin@example.test", emailVerified: true, name: "Admin" },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  }
  let resolutions = 0
  const app = express()
  app.use(express.json())
  app.use("/admin/api", createAdminRouter({
    async getSessionSnapshot() { return session },
    ...createManagedAiAdminRouteDeps({
      async getAdminSession() { return session },
      ...(withResolver
        ? {
            async resolveEnabledUserAiAccess(userId: string) {
              resolutions += 1
              return {
                userId,
                enabled: true as const,
                provider: "codex_oauth" as const,
                credentialId: "cred_server",
                assignmentOrigin: "admin_assigned" as const,
              }
            },
          }
        : {}),
      aiAccess: {
        async getUserAiAccess() { return null },
        async upsertUserAiAccess(input) {
          writes.push(input)
          return {
            id: `access_${input.userId}`,
            ...input,
            defaultModel: null,
            allowedModels: [],
            createdAt: new Date("2026-07-21T00:00:00.000Z"),
            updatedAt: new Date("2026-07-21T00:00:00.000Z"),
          }
        },
      },
      alerts: { async listAlerts() { return [] } },
      audit: { async recordEvent() {}, async listEvents() { return [] } },
      credentials: {} as never,
      leases: {} as never,
      secrets: {} as never,
      usage: {} as never,
    }),
  }))
  return { app, writes, get resolutions() { return resolutions } }
}

async function put(app: express.Express, body: Record<string, unknown>) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("legacy DEN rejects client routing before server resolution or writes", async () => {
  for (const [field, value] of [
    ["provider", "codex_oauth"],
    ["credentialId", "cred_client"],
    ["defaultModel", "gpt-client"],
    ["allowedModels", ["gpt-client"]],
    ["routing", { provider: "codex_oauth" }],
  ] as const) {
    const context = createHarness(true)
    const response = await put(context.app, { enabled: true, [field]: value })
    assert.equal(response.status, 400, field)
    assert.deepEqual(response.body, { error: "user_ai_access_routing_not_supported" }, field)
    assert.equal(context.resolutions, 0, field)
    assert.deepEqual(context.writes, [], field)
  }
})

test("legacy DEN enable fails closed without a server-side resolver", async () => {
  const context = createHarness(false)
  const response = await put(context.app, { enabled: true })
  assert.equal(response.status, 503)
  assert.deepEqual(response.body, { error: "user_ai_access_automatic_resolution_unavailable" })
  assert.deepEqual(context.writes, [])
})

test("legacy DEN resolves enable server-side and clears technical assignment on disable", async () => {
  const context = createHarness(true)
  assert.equal((await put(context.app, { enabled: true })).status, 200)
  assert.equal((await put(context.app, { enabled: false })).status, 200)
  assert.equal(context.resolutions, 1)
  assert.deepEqual(context.writes, [{
    userId: "user_123",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_server",
    assignmentOrigin: "admin_assigned",
  }, {
    userId: "user_123",
    enabled: false,
    provider: null,
    credentialId: null,
    assignmentOrigin: "admin_assigned",
  }])
})
