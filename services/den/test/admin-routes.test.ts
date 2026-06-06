import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"
import { errorMiddleware } from "../src/http/errors.js"

function buildSession() {
  return {
    user: {
      id: "user_admin_1",
      email: "vaclav.soukup@neatec.cz",
      emailVerified: false,
      name: "Václav Soukup",
    },
    platformAdmin: true,
    activeOrgId: "org_1",
    organizations: [
      {
        id: "org_1",
        name: "Personal",
        slug: "personal",
        ownerUserId: "user_admin_1",
        role: "owner" as const,
      },
    ],
  }
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  }
}

test("admin router exposes disable/enable/delete user actions", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRouter({
      async getSessionSnapshot() {
        return buildSession()
      },
      async disableUser() {
        return {
          id: "user_123",
          name: "Blocked User",
          email: "blocked@example.com",
          emailVerified: true,
          platformAdmin: false,
          disabled: true,
          memberships: [],
        }
      },
      async enableUser() {
        return {
          id: "user_123",
          name: "Blocked User",
          email: "blocked@example.com",
          emailVerified: true,
          platformAdmin: false,
          disabled: false,
          memberships: [],
        }
      },
      async deleteUser(_req, res) {
        res.status(204).end()
        return { ok: true }
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const disableResponse = await fetch(`http://127.0.0.1:${port}/users/user_123/disable`, {
      method: "POST",
    })
    assert.equal(disableResponse.status, 200)
    assert.deepEqual(await disableResponse.json(), {
      user: {
        id: "user_123",
        name: "Blocked User",
        email: "blocked@example.com",
        emailVerified: true,
        platformAdmin: false,
        disabled: true,
        memberships: [],
      },
    })

    const enableResponse = await fetch(`http://127.0.0.1:${port}/users/user_123/enable`, {
      method: "POST",
    })
    assert.equal(enableResponse.status, 200)
    assert.deepEqual(await enableResponse.json(), {
      user: {
        id: "user_123",
        name: "Blocked User",
        email: "blocked@example.com",
        emailVerified: true,
        platformAdmin: false,
        disabled: false,
        memberships: [],
      },
    })

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/users/user_123`, {
      method: "DELETE",
    })
    assert.equal(deleteResponse.status, 204)
    assert.equal(await deleteResponse.text(), "")
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin router exposes organization, member, domain, and invite endpoints", async () => {
  const calls: string[] = []
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRouter({
      async getSessionSnapshot() {
        return buildSession()
      },
      async listOrganizations() {
        calls.push("listOrganizations")
        return {
          organizations: [{
            id: "org_1",
            name: "Personal",
            slug: "personal",
            ownerUserId: "user_admin_1",
            seatLimit: 10,
          }],
        }
      },
      async getOrganization(req) {
        calls.push(`getOrganization:${req.params.orgId}`)
        return {
          organization: {
            id: req.params.orgId,
            name: "Personal",
            slug: "personal",
            ownerUserId: "user_admin_1",
            seatLimit: 10,
          },
        }
      },
      async updateOrganization(req) {
        calls.push(`updateOrganization:${req.params.orgId}:${req.body.seatLimit}`)
        return {
          organization: {
            id: req.params.orgId,
            name: "Personal",
            slug: "personal",
            ownerUserId: "user_admin_1",
            seatLimit: req.body.seatLimit,
          },
        }
      },
      async listOrganizationMembers(req) {
        calls.push(`listMembers:${req.params.orgId}`)
        return {
          members: [{
            membershipId: "membership_1",
            userId: "user_member_1",
            name: "Member User",
            email: "member@example.com",
            role: "member" as const,
            createdAt: "2026-06-06T08:00:00.000Z",
          }],
        }
      },
      async updateOrganizationMember(req) {
        calls.push(`updateMember:${req.params.orgId}:${req.params.memberId}:${req.body.role}`)
        return {
          member: {
            membershipId: req.params.memberId,
            userId: "user_member_1",
            name: "Member User",
            email: "member@example.com",
            role: req.body.role,
            createdAt: "2026-06-06T08:00:00.000Z",
          },
        }
      },
      async deleteOrganizationMember(req) {
        calls.push(`deleteMember:${req.params.orgId}:${req.params.memberId}`)
        return { ok: true }
      },
      async listOrganizationDomains(req) {
        calls.push(`listDomains:${req.params.orgId}`)
        return {
          domains: [{
            id: "domain_1",
            orgId: req.params.orgId,
            domain: "example.com",
            enabled: true,
            selfSignupEnabled: false,
          }],
        }
      },
      async createOrganizationDomain(req) {
        calls.push(`createDomain:${req.params.orgId}:${req.body.domain}`)
        return {
          domain: {
            id: "domain_2",
            orgId: req.params.orgId,
            domain: req.body.domain,
            enabled: true,
            selfSignupEnabled: req.body.selfSignupEnabled === true,
          },
        }
      },
      async updateOrganizationDomain(req) {
        calls.push(`updateDomain:${req.params.orgId}:${req.params.domainId}:${req.body.enabled}`)
        return {
          domain: {
            id: req.params.domainId,
            orgId: req.params.orgId,
            domain: "example.com",
            enabled: req.body.enabled === true,
            selfSignupEnabled: false,
          },
        }
      },
      async deleteOrganizationDomain(req) {
        calls.push(`deleteDomain:${req.params.orgId}:${req.params.domainId}`)
        return { ok: true }
      },
      async listOrganizationInvites(req) {
        calls.push(`listInvites:${req.params.orgId}`)
        return {
          invites: [{
            id: "invite_1",
            orgId: req.params.orgId,
            email: "invited@example.com",
            role: "member" as const,
            status: "pending" as const,
            invitedByUserId: "user_admin_1",
            acceptedByUserId: null,
            expiresAt: null,
            acceptedAt: null,
            revokedAt: null,
            createdAt: "2026-06-06T08:00:00.000Z",
            updatedAt: "2026-06-06T08:00:00.000Z",
          }],
        }
      },
      async createOrganizationInvite(req) {
        calls.push(`createInvite:${req.params.orgId}:${req.body.email}`)
        return {
          invite: {
            id: "invite_2",
            orgId: req.params.orgId,
            email: req.body.email,
            role: "member" as const,
            status: "pending" as const,
            invitedByUserId: "user_admin_1",
            acceptedByUserId: null,
            expiresAt: null,
            acceptedAt: null,
            revokedAt: null,
            createdAt: "2026-06-06T08:00:00.000Z",
            updatedAt: "2026-06-06T08:00:00.000Z",
          },
          inviteToken: "invite_token_once",
        }
      },
      async revokeOrganizationInvite(req) {
        calls.push(`revokeInvite:${req.params.orgId}:${req.params.inviteId}`)
        return {
          invite: {
            id: req.params.inviteId,
            orgId: req.params.orgId,
            email: "invited@example.com",
            role: "member" as const,
            status: "revoked" as const,
            invitedByUserId: "user_admin_1",
            acceptedByUserId: null,
            expiresAt: null,
            acceptedAt: null,
            revokedAt: "2026-06-06T08:10:00.000Z",
            createdAt: "2026-06-06T08:00:00.000Z",
            updatedAt: "2026-06-06T08:10:00.000Z",
          },
        }
      },
    }),
  )

  const { server, baseUrl } = await listen(app)

  try {
    const listResponse = await fetch(`${baseUrl}/organizations`)
    assert.equal(listResponse.status, 200)
    assert.deepEqual(await listResponse.json(), {
      organizations: [{
        id: "org_1",
        name: "Personal",
        slug: "personal",
        ownerUserId: "user_admin_1",
        seatLimit: 10,
      }],
    })

    const getResponse = await fetch(`${baseUrl}/organizations/org_1`)
    assert.equal(getResponse.status, 200)
    assert.equal((await getResponse.json()).organization.id, "org_1")

    const patchResponse = await fetch(`${baseUrl}/organizations/org_1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatLimit: 25 }),
    })
    assert.equal(patchResponse.status, 200)
    assert.equal((await patchResponse.json()).organization.seatLimit, 25)

    const membersResponse = await fetch(`${baseUrl}/organizations/org_1/members`)
    assert.equal(membersResponse.status, 200)
    assert.equal((await membersResponse.json()).members[0].membershipId, "membership_1")

    const memberPatchResponse = await fetch(`${baseUrl}/organizations/org_1/members/membership_1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "organization_admin" }),
    })
    assert.equal(memberPatchResponse.status, 200)
    assert.equal((await memberPatchResponse.json()).member.role, "organization_admin")

    const memberDeleteResponse = await fetch(`${baseUrl}/organizations/org_1/members/membership_1`, {
      method: "DELETE",
    })
    assert.equal(memberDeleteResponse.status, 204)

    const domainsResponse = await fetch(`${baseUrl}/organizations/org_1/domains`)
    assert.equal(domainsResponse.status, 200)
    assert.equal((await domainsResponse.json()).domains[0].domain, "example.com")

    const domainCreateResponse = await fetch(`${baseUrl}/organizations/org_1/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "new.example.com", selfSignupEnabled: true }),
    })
    assert.equal(domainCreateResponse.status, 201)
    assert.equal((await domainCreateResponse.json()).domain.domain, "new.example.com")

    const domainPatchResponse = await fetch(`${baseUrl}/organizations/org_1/domains/domain_1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(domainPatchResponse.status, 200)
    assert.equal((await domainPatchResponse.json()).domain.enabled, false)

    const domainDeleteResponse = await fetch(`${baseUrl}/organizations/org_1/domains/domain_1`, {
      method: "DELETE",
    })
    assert.equal(domainDeleteResponse.status, 204)

    const invitesResponse = await fetch(`${baseUrl}/organizations/org_1/invites`)
    assert.equal(invitesResponse.status, 200)
    const invitesPayload = await invitesResponse.json()
    assert.equal(invitesPayload.invites[0].id, "invite_1")
    assert.equal("inviteToken" in invitesPayload.invites[0], false)
    assert.equal("tokenHash" in invitesPayload.invites[0], false)

    const inviteCreateResponse = await fetch(`${baseUrl}/organizations/org_1/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invited@example.com" }),
    })
    assert.equal(inviteCreateResponse.status, 201)
    assert.deepEqual(await inviteCreateResponse.json(), {
      invite: {
        id: "invite_2",
        orgId: "org_1",
        email: "invited@example.com",
        role: "member",
        status: "pending",
        invitedByUserId: "user_admin_1",
        acceptedByUserId: null,
        expiresAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: "2026-06-06T08:00:00.000Z",
        updatedAt: "2026-06-06T08:00:00.000Z",
      },
      inviteToken: "invite_token_once",
    })

    const revokeResponse = await fetch(`${baseUrl}/organizations/org_1/invites/invite_1/revoke`, {
      method: "POST",
    })
    assert.equal(revokeResponse.status, 200)
    assert.equal((await revokeResponse.json()).invite.status, "revoked")

    assert.deepEqual(calls, [
      "listOrganizations",
      "getOrganization:org_1",
      "updateOrganization:org_1:25",
      "listMembers:org_1",
      "updateMember:org_1:membership_1:organization_admin",
      "deleteMember:org_1:membership_1",
      "listDomains:org_1",
      "createDomain:org_1:new.example.com",
      "updateDomain:org_1:domain_1:false",
      "deleteDomain:org_1:domain_1",
      "listInvites:org_1",
      "createInvite:org_1:invited@example.com",
      "revokeInvite:org_1:invite_1",
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin router forwards async dependency failures to error middleware", async () => {
  const app = express()
  const unhandledRejections: unknown[] = []
  const onUnhandledRejection = (error: unknown) => {
    unhandledRejections.push(error)
  }

  process.on("unhandledRejection", onUnhandledRejection)
  app.use(
    createAdminRouter({
      async getSessionSnapshot() {
        throw new Error("admin dependency failed")
      },
    }),
  )
  app.use(errorMiddleware)

  const { server, baseUrl } = await listen(app)
  try {
    const signal = AbortSignal.timeout(250)
    const response = await fetch(`${baseUrl}/session`, { signal }).catch((error: unknown) => error)

    assert.ok(response instanceof Response, "expected error middleware response before the request timeout")
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "internal_error" })
    assert.deepEqual(unhandledRejections, [])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
    server.close()
    await once(server, "close")
  }
})
