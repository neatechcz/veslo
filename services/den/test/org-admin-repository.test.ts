import assert from "node:assert/strict"
import test from "node:test"
import {
  OrganizationAdminRepositoryError,
  createOrganizationAdminRepository,
  type OrganizationAdminDataStore,
  type OrganizationAdminDomainRecord,
  type OrganizationAdminInviteRecord,
  type OrganizationAdminMembershipRecord,
  type OrganizationAdminOrganizationRecord,
} from "../src/org-admin/repository.js"

function assertErrorCode(error: unknown, code: OrganizationAdminRepositoryError["code"]) {
  assert.ok(error instanceof OrganizationAdminRepositoryError)
  assert.equal(error.code, code)
}

function createMemoryRepository(input: {
  organizations?: OrganizationAdminOrganizationRecord[]
  domains?: OrganizationAdminDomainRecord[]
  memberships?: OrganizationAdminMembershipRecord[]
  invites?: OrganizationAdminInviteRecord[]
} = {}) {
  const organizations = [...(input.organizations ?? [])]
  const domains = [...(input.domains ?? [])]
  const memberships = [...(input.memberships ?? [])]
  const invites = [...(input.invites ?? [])]
  let nextInvite = 1
  let nextMembership = 1

  const store: OrganizationAdminDataStore = {
    async findOrganizationById(orgId) {
      return organizations.find((entry) => entry.id === orgId) ?? null
    },
    async findDomainByDomain(domain) {
      return domains.find((entry) => entry.domain === domain) ?? null
    },
    async countActiveOrganizationSeats(orgId) {
      return memberships.filter((entry) => entry.orgId === orgId && entry.status === "active").length
    },
    async insertInvite(invite) {
      const now = new Date("2026-06-06T08:00:00.000Z")
      const created: OrganizationAdminInviteRecord = {
        id: `invite_${nextInvite++}`,
        role: "member",
        status: "pending",
        acceptedByUserId: null,
        expiresAt: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
        ...invite,
      }
      invites.push(created)
      return created
    },
    async findInviteByTokenHash(tokenHash) {
      return invites.find((entry) => entry.tokenHash === tokenHash) ?? null
    },
    async createOrActivateMembership(input) {
      const existing = memberships.find((entry) => entry.orgId === input.orgId && entry.userId === input.userId)
      if (existing) {
        existing.role = input.role
        existing.status = "active"
        return existing
      }
      const created: OrganizationAdminMembershipRecord = {
        id: `membership_${nextMembership++}`,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      }
      memberships.push(created)
      return created
    },
    async markInviteAccepted(input) {
      const invite = invites.find((entry) => entry.id === input.inviteId && entry.status === "pending")
      if (!invite) return null
      invite.status = "accepted"
      invite.acceptedByUserId = input.acceptedByUserId
      invite.acceptedAt = input.acceptedAt
      invite.updatedAt = input.acceptedAt
      return invite
    },
    async listOrganizationMembers(orgId) {
      return memberships.filter((entry) => entry.orgId === orgId)
    },
    async listOrganizationInvites(orgId) {
      return invites.filter((entry) => entry.orgId === orgId)
    },
    async listOrganizationDomains(orgId) {
      return domains.filter((entry) => entry.orgId === orgId)
    },
    async transaction(callback) {
      return callback(store)
    },
  }

  return {
    invites,
    memberships,
    repository: createOrganizationAdminRepository(store),
  }
}

test("enabled domain resolves organization by normalized email domain", async () => {
  const { repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 10 }],
    domains: [{
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: true,
      selfSignupEnabled: true,
    }],
  })

  const domain = await repository.resolveEnabledOrganizationDomainForEmail(" User@Neatech.CZ ")

  assert.equal(domain.orgId, "org_1")
  assert.equal(domain.domain, "neatech.cz")
})

test("disabled domain does not permit self-signup", async () => {
  const { repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 10 }],
    domains: [{
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: false,
      selfSignupEnabled: true,
    }],
  })

  await assert.rejects(
    repository.resolveEnabledOrganizationDomainForEmail("user@neatech.cz"),
    (error) => {
      assertErrorCode(error, "domain_not_allowed")
      return true
    },
  )
})

test("no domain returns domain_not_allowed", async () => {
  const { repository } = createMemoryRepository()

  await assert.rejects(
    repository.resolveEnabledOrganizationDomainForEmail("user@example.test"),
    (error) => {
      assertErrorCode(error, "domain_not_allowed")
      return true
    },
  )
})

test("active seat count blocks activation at the organization limit", async () => {
  const { repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 1 }],
    memberships: [
      {
        id: "membership_active",
        orgId: "org_1",
        userId: "user_active",
        role: "member",
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      },
      {
        id: "membership_disabled",
        orgId: "org_1",
        userId: "user_disabled",
        role: "member",
        status: "disabled",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      },
    ],
  })

  assert.equal(await repository.countActiveOrganizationSeats("org_1"), 1)
  await assert.rejects(
    repository.assertCanActivateOrganizationSeat("org_1"),
    (error) => {
      assertErrorCode(error, "seat_limit_reached")
      return true
    },
  )
})

test("invite activation checks seat limit at activation time", async () => {
  const { memberships, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 1 }],
  })
  await repository.createOrganizationInvite({
    orgId: "org_1",
    email: " Invited@Neatech.CZ ",
    role: "member",
    tokenHash: "token_1",
    invitedByUserId: "admin_1",
  })
  memberships.push({
    id: "membership_filled",
    orgId: "org_1",
    userId: "user_existing",
    role: "member",
    status: "active",
    createdAt: new Date("2026-06-06T08:00:00.000Z"),
  })

  await assert.rejects(
    repository.acceptOrganizationInvite({
      tokenHash: "token_1",
      userId: "user_invited",
      now: new Date("2026-06-06T08:10:00.000Z"),
    }),
    (error) => {
      assertErrorCode(error, "seat_limit_reached")
      return true
    },
  )
})

test("invite cannot be accepted twice", async () => {
  const { invites, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
  })
  const invite = await repository.createOrganizationInvite({
    orgId: "org_1",
    email: " Invited@Neatech.CZ ",
    role: "organization_admin",
    tokenHash: "token_1",
    invitedByUserId: "admin_1",
  })

  assert.equal(invite.email, "invited@neatech.cz")
  const accepted = await repository.acceptOrganizationInvite({
    tokenHash: "token_1",
    userId: "user_invited",
    now: new Date("2026-06-06T08:10:00.000Z"),
  })

  assert.equal(accepted.invite.status, "accepted")
  assert.equal(accepted.membership.role, "organization_admin")
  assert.equal(invites[0].acceptedByUserId, "user_invited")
  await assert.rejects(
    repository.acceptOrganizationInvite({
      tokenHash: "token_1",
      userId: "user_invited",
      now: new Date("2026-06-06T08:11:00.000Z"),
    }),
    (error) => {
      assertErrorCode(error, "invite_already_used")
      return true
    },
  )
})
