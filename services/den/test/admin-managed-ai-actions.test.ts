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

function createCredential(id: string, state: "revoked" | "draining") {
  return {
    id,
    name: `Credential ${id}`,
    provider: "openai",
    type: "oauth",
    state,
    scope: "platform:openai",
    activeLeases: 2,
    alertCount: 1,
    lastRefreshAt: "2026-04-03T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 321,
    nextRotationAt: null,
    linkedAlertIds: ["alert_health_1"],
  }
}

function createAlert(id: string, status: "acknowledged" | "resolved") {
  return {
    id,
    title: "Provider rate limits increasing",
    severity: "high",
    source: "provider-rate-limit",
    status,
    credentialId: "cred_openai_1",
    affectedSessions: 3,
    firstSeenAt: "2026-04-03T10:00:00.000Z",
    lastSeenAt: "2026-04-03T10:05:00.000Z",
    owner: "admin@example.test",
    runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
  }
}

test("POST /admin/api/credentials actions forward to the managed ai handler", async () => {
  const session = createSession()
  const credentialCalls: Array<{ action: string; credentialId: string }> = []
  const auditCalls: Array<{
    actorUserId?: string | null
    action: string
    entityType: string
    entityId: string
    result: "ok" | "warning" | "error"
    summary?: string | null
  }> = []
  let credentialState: "revoked" | "draining" = "draining"
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
            return [createAlert("alert_health_1", "acknowledged")]
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
        credentials: {
          async listAdminCredentials() {
            return [createCredential("cred_openai_1", credentialState)]
          },
          async revokeCredential(credentialId: string) {
            credentialCalls.push({ action: "revoke", credentialId })
            credentialState = "revoked"
            return true
          },
          async drainCredential(credentialId: string) {
            credentialCalls.push({ action: "drain", credentialId })
            credentialState = "draining"
            return true
          },
          async rotateCredential(credentialId: string) {
            credentialCalls.push({ action: "rotate", credentialId })
            credentialState = "draining"
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
    const baseUrl = `http://127.0.0.1:${port}/admin/api/credentials/cred_openai_1`
    const revokeResponse = await fetch(`${baseUrl}/revoke`, { method: "POST" })
    assert.equal(revokeResponse.status, 200)
    assert.deepEqual(await revokeResponse.json(), {
      credential: createCredential("cred_openai_1", "revoked"),
    })

    const drainResponse = await fetch(`${baseUrl}/drain`, { method: "POST" })
    assert.equal(drainResponse.status, 200)
    assert.deepEqual(await drainResponse.json(), {
      credential: createCredential("cred_openai_1", "draining"),
    })

    const rotateResponse = await fetch(`${baseUrl}/rotate`, { method: "POST" })
    assert.equal(rotateResponse.status, 200)
    assert.deepEqual(await rotateResponse.json(), {
      credential: createCredential("cred_openai_1", "draining"),
    })

    assert.deepEqual(credentialCalls, [
      { action: "revoke", credentialId: "cred_openai_1" },
      { action: "drain", credentialId: "cred_openai_1" },
      { action: "rotate", credentialId: "cred_openai_1" },
    ])
    assert.deepEqual(auditCalls, [
      {
        actorUserId: "admin@example.test",
        action: "credential.revoke",
        entityType: "credential",
        entityId: "cred_openai_1",
        result: "warning",
        summary: "Revoked credential cred_openai_1.",
      },
      {
        actorUserId: "admin@example.test",
        action: "credential.drain",
        entityType: "credential",
        entityId: "cred_openai_1",
        result: "warning",
        summary: "Draining credential cred_openai_1 for new assignments.",
      },
      {
        actorUserId: "admin@example.test",
        action: "credential.rotate",
        entityType: "credential",
        entityId: "cred_openai_1",
        result: "ok",
        summary: "Rotated active routes off credential cred_openai_1.",
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("POST /admin/api/alerts actions forward to the managed ai handler", async () => {
  const session = createSession()
  const calls: Array<{ action: string; alertId: string; actorUserId?: string | null }> = []
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
            return [createAlert("alert_health_1", "acknowledged")]
          },
          async acknowledgeAlert(input) {
            calls.push({ action: "acknowledge", alertId: input.alertId, actorUserId: input.actorUserId })
            return createAlert(input.alertId, "acknowledged")
          },
          async resolveAlert(input) {
            calls.push({ action: "resolve", alertId: input.alertId, actorUserId: input.actorUserId })
            return createAlert(input.alertId, "resolved")
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
    const baseUrl = `http://127.0.0.1:${port}/admin/api/alerts/alert_health_1`
    const acknowledgeResponse = await fetch(`${baseUrl}/acknowledge`, { method: "POST" })
    assert.equal(acknowledgeResponse.status, 200)
    assert.deepEqual(await acknowledgeResponse.json(), {
      alert: createAlert("alert_health_1", "acknowledged"),
    })

    const resolveResponse = await fetch(`${baseUrl}/resolve`, { method: "POST" })
    assert.equal(resolveResponse.status, 200)
    assert.deepEqual(await resolveResponse.json(), {
      alert: createAlert("alert_health_1", "resolved"),
    })

    assert.deepEqual(calls, [
      { action: "acknowledge", alertId: "alert_health_1", actorUserId: "admin@example.test" },
      { action: "resolve", alertId: "alert_health_1", actorUserId: "admin@example.test" },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})
