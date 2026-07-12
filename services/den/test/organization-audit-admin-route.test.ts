import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"

process.env.DATABASE_URL ||= "mysql://root:root@127.0.0.1:3306/veslo_test"
process.env.BETTER_AUTH_SECRET ||= "organization-audit-test-secret-32-chars"
const adminRuntime = await import("../src/http/admin-runtime.js")

function responseStub() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
}

test("organization audit route returns the authorized DEN source projection", async () => {
  const calls: Array<{ organizationId: string; limit: string | undefined }> = []
  const app = express()
  app.use(createAdminRouter({
    async listOrganizationAudit(req) {
      calls.push({ organizationId: req.params.orgId, limit: typeof req.query.limit === "string" ? req.query.limit : undefined })
      return {
        events: [{
          id: "den_audit_1",
          timestamp: "2026-07-12T10:00:00.000Z",
          actor: "user_admin_1",
          action: "admin.billing.plan.updated",
          entityType: "organization",
          entityId: "org_1",
          result: "ok" as const,
          summary: "admin.billing.plan.updated",
          changedFields: [],
        }],
      }
    },
  }))
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/organizations/org_1/audit?limit=25`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      events: [{
        id: "den_audit_1",
        timestamp: "2026-07-12T10:00:00.000Z",
        actor: "user_admin_1",
        action: "admin.billing.plan.updated",
        entityType: "organization",
        entityId: "org_1",
        result: "ok",
        summary: "admin.billing.plan.updated",
        changedFields: [],
      }],
    })
    assert.deepEqual(calls, [{ organizationId: "org_1", limit: "25" }])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("DEN organization audit dependency authorizes and requests a hard-bounded organization query", async () => {
  const createDeps = (adminRuntime as Record<string, unknown>).createOrganizationAuditAdminRouteDeps
  assert.equal(typeof createDeps, "function")

  const calls: Array<{ organizationId: string; limit: number }> = []
  const deps = (createDeps as (input: unknown) => {
    listOrganizationAudit(req: unknown, res: unknown): Promise<unknown>
  })({
    async requireOrganizationAccess() {
      return { organization: { id: "org_authorized" } }
    },
    store: {
      async listEvents(input: { organizationId: string; limit: number }) {
        calls.push(input)
        return [{
          id: "audit_real_actor",
          organizationId: "org_authorized",
          actorUserId: "user_real_admin",
          action: "org.member.added",
          createdAt: new Date("2026-07-12T11:00:00.000Z"),
          payload: { invitationToken: "must-not-leak" },
        }]
      },
    },
  })
  const res = responseStub()
  const result = await deps.listOrganizationAudit({
    params: { orgId: "org_authorized" },
    query: { limit: "999" },
  }, res)

  assert.deepEqual(calls, [{ organizationId: "org_authorized", limit: 100 }])
  assert.deepEqual(result, {
    events: [{
      id: "audit_real_actor",
      timestamp: "2026-07-12T11:00:00.000Z",
      actor: "user_real_admin",
      action: "org.member.added",
      entityType: "organization",
      entityId: "org_authorized",
      result: "ok",
      summary: "org.member.added",
      changedFields: [],
    }],
  })
  assert.equal(JSON.stringify(result).includes("invitationToken"), false)
})

test("DEN organization audit dependency does not query before organization authorization", async () => {
  const createDeps = (adminRuntime as Record<string, unknown>).createOrganizationAuditAdminRouteDeps
  assert.equal(typeof createDeps, "function")
  let listCalls = 0
  const deps = (createDeps as (input: unknown) => {
    listOrganizationAudit(req: unknown, res: unknown): Promise<unknown>
  })({
    async requireOrganizationAccess(_req: unknown, res: ReturnType<typeof responseStub>) {
      res.status(403).json({ error: "organization_forbidden" })
      return null
    },
    store: {
      async listEvents() {
        listCalls += 1
        return []
      },
    },
  })
  const res = responseStub()
  const result = await deps.listOrganizationAudit({ params: { orgId: "org_forbidden" }, query: {} }, res)

  assert.equal(result, null)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: "organization_forbidden" })
  assert.equal(listCalls, 0)
})
