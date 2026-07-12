import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createManagedAiRuntimeEntitlementRouter } from "../src/http/managed-ai-runtime-entitlement.js"

type TestOrganization = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  membershipId: string
  role: "member"
  status: "active" | "disabled"
}

function organization(id: string, status: TestOrganization["status"] = "active"): TestOrganization {
  return {
    id,
    name: id,
    slug: id,
    ownerUserId: "owner_1",
    membershipId: `membership_${id}`,
    role: "member",
    status,
  }
}

async function withEntitlementServer(
  input: {
    organizations: TestOrganization[]
    canUseManagedAi?: boolean
    requestedOrgId?: string | null
    session?: { user: { id: string; email: null; emailVerified: true; name: null } } | null
    sessionError?: Error
    deriveError?: Error
  },
  run: (baseUrl: string, deriveCalls: string[]) => Promise<void>,
) {
  const deriveCalls: string[] = []
  const app = express()
  app.use(createManagedAiRuntimeEntitlementRouter({
    async requireSession(_req, res) {
      if (input.sessionError) throw input.sessionError
      if (input.session === null) {
        res.status(401).json({ error: "unauthorized" })
        return null
      }
      return input.session ?? {
        user: { id: "user_1", email: null, emailVerified: true, name: null },
      }
    },
    async listOrganizations(session) {
      assert.equal(session.user.id, "user_1")
      return input.organizations
    },
    readRequestedOrganizationId(req) {
      return input.requestedOrgId ?? req.header("x-veslo-org-id") ?? null
    },
    async deriveEntitlement(orgId) {
      deriveCalls.push(orgId)
      if (input.deriveError) throw input.deriveError
      return { canUseManagedAi: input.canUseManagedAi ?? true }
    },
  }))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}`, deriveCalls)
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("runtime entitlement auto-resolves one active membership and returns only the minimal projection", async () => {
  await withEntitlementServer({ organizations: [organization("org_1")] }, async (baseUrl, deriveCalls) => {
    const response = await fetch(`${baseUrl}/v1/managed-ai/entitlement`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { orgId: "org_1", canUseManagedAi: true })
    assert.deepEqual(deriveCalls, ["org_1"])
  })
})

test("runtime entitlement fails closed for ambiguous, inaccessible, and inactive org context without billing details", async () => {
  const cases = [
    {
      organizations: [organization("org_1"), organization("org_2")],
      requestedOrgId: null,
      status: 400,
      error: "org_context_required",
    },
    {
      organizations: [organization("org_1")],
      requestedOrgId: "org_other",
      status: 403,
      error: "organization_forbidden",
    },
    {
      organizations: [organization("org_1", "disabled")],
      requestedOrgId: "org_1",
      status: 403,
      error: "organization_forbidden",
    },
  ]

  for (const entry of cases) {
    await withEntitlementServer(entry, async (baseUrl, deriveCalls) => {
      const response = await fetch(`${baseUrl}/v1/managed-ai/entitlement`)
      assert.equal(response.status, entry.status)
      assert.deepEqual(await response.json(), { error: entry.error })
      assert.deepEqual(deriveCalls, [])
    })
  }
})

test("runtime entitlement returns deny decisions without exposing DEN billing state", async () => {
  await withEntitlementServer({
    organizations: [organization("org_1")],
    canUseManagedAi: false,
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/managed-ai/entitlement`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { orgId: "org_1", canUseManagedAi: false })
  })
})

test("runtime entitlement reports DEN lookup failures with a stable secret-free error", async () => {
  await withEntitlementServer({
    organizations: [organization("org_1")],
    deriveError: new Error("stripe_secret_should_not_leak"),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/managed-ai/entitlement`)
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.deepEqual(payload, { error: "managed_ai_entitlement_unavailable" })
    assert.doesNotMatch(JSON.stringify(payload), /stripe_secret_should_not_leak/)
  })
})

test("runtime entitlement reports session lookup failures with a stable secret-free error", async () => {
  await withEntitlementServer({
    organizations: [],
    sessionError: new Error("session_database_secret_should_not_leak"),
  }, async (baseUrl, deriveCalls) => {
    const response = await fetch(`${baseUrl}/v1/managed-ai/entitlement`)
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.deepEqual(payload, { error: "managed_ai_entitlement_unavailable" })
    assert.doesNotMatch(JSON.stringify(payload), /session_database_secret_should_not_leak/)
    assert.deepEqual(deriveCalls, [])
  })
})
