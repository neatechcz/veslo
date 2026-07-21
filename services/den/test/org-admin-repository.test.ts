import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  OrganizationAdminRepositoryError,
  createOrganizationAdminRepository,
  extractAffectedRows,
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
  operations?: string[]
  beforeMarkInviteAccepted?: (invites: OrganizationAdminInviteRecord[]) => void | Promise<void>
} = {}) {
  const organizations = [...(input.organizations ?? [])]
  const domains = [...(input.domains ?? [])]
  const memberships = [...(input.memberships ?? [])]
  const invites = [...(input.invites ?? [])]
  const operations = input.operations ?? []
  const beforeMarkInviteAccepted = input.beforeMarkInviteAccepted
  let nextInvite = 1
  let nextMembership = 1

  const store: OrganizationAdminDataStore = {
    async lockOrganizationForSeatActivation(orgId) {
      operations.push(`lock:${orgId}`)
    },
    async findOrganizationById(orgId) {
      return organizations.find((entry) => entry.id === orgId) ?? null
    },
    async findDomainByDomain(domain) {
      return domains.find((entry) => entry.domain === domain) ?? null
    },
    async countActiveOrganizationSeats(orgId) {
      operations.push(`count:${orgId}`)
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
      const invite = invites.find((entry) => entry.tokenHash === tokenHash)
      return invite ? { ...invite } : null
    },
    async createOrActivateMembership(input) {
      operations.push(`activate:${input.orgId}:${input.userId}`)
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
      await beforeMarkInviteAccepted?.(invites)
      const invite = invites.find((entry) =>
        entry.id === input.inviteId &&
        entry.status === "pending" &&
        entry.tokenHash === input.expectedTokenHash)
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
    operations,
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

test("shared membership activation enforces seat limits", async () => {
  const { repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 1 }],
    memberships: [{
      id: "membership_active",
      orgId: "org_1",
      userId: "user_active",
      role: "member",
      status: "active",
      createdAt: new Date("2026-06-06T08:00:00.000Z"),
    }],
  })

  await assert.rejects(
    repository.createOrActivateOrganizationMembership({
      membershipId: "membership_new",
      orgId: "org_1",
      userId: "user_new",
      role: "member",
    }),
    (error) => {
      assertErrorCode(error, "seat_limit_reached")
      return true
    },
  )
})

test("shared membership activation locks organization before counting seats and activating", async () => {
  const { operations, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
  })

  await repository.createOrActivateOrganizationMembership({
    membershipId: "membership_new",
    orgId: "org_1",
    userId: "user_new",
    role: "member",
  })

  assert.deepEqual(operations, [
    "lock:org_1",
    "count:org_1",
    "activate:org_1:user_new",
  ])
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

test("invite acceptance loses atomically when resend rotates the token after lookup", async () => {
  let rotated = false
  const { invites, memberships, operations, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
    invites: [{
      id: "invite_1",
      orgId: "org_1",
      email: "invited@neatech.cz",
      role: "member",
      status: "pending",
      tokenHash: "old_token_hash",
      invitedByUserId: "admin_1",
      acceptedByUserId: null,
      expiresAt: null,
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date("2026-06-06T08:00:00.000Z"),
      updatedAt: new Date("2026-06-06T08:00:00.000Z"),
    }],
    beforeMarkInviteAccepted(activeInvites) {
      if (rotated) return
      rotated = true
      activeInvites[0]!.tokenHash = "new_token_hash"
      activeInvites[0]!.updatedAt = new Date("2026-06-06T08:05:00.000Z")
    },
  })

  await assert.rejects(
    repository.acceptOrganizationInvite({
      tokenHash: "old_token_hash",
      userId: "user_invited",
      email: "invited@neatech.cz",
      now: new Date("2026-06-06T08:10:00.000Z"),
    }),
    (error) => {
      assertErrorCode(error, "invite_not_found")
      return true
    },
  )

  assert.equal(invites[0]!.status, "pending")
  assert.equal(invites[0]!.tokenHash, "new_token_hash")
  assert.deepEqual(memberships, [])
  assert.equal(operations.some((operation) => operation.startsWith("activate:")), false)

  const accepted = await repository.acceptOrganizationInvite({
    tokenHash: "new_token_hash",
    userId: "user_invited",
    email: "invited@neatech.cz",
    now: new Date("2026-06-06T08:11:00.000Z"),
  })

  assert.equal(accepted.invite.status, "accepted")
  assert.equal(accepted.membership.userId, "user_invited")
  assert.equal(memberships.length, 1)
})

test("invite acceptance rejects mismatched signup email before consuming token", async () => {
  const { invites, memberships, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
  })
  await repository.createOrganizationInvite({
    orgId: "org_1",
    email: "invited@neatech.cz",
    role: "member",
    tokenHash: "token_1",
    invitedByUserId: "admin_1",
  })

  await assert.rejects(
    repository.acceptOrganizationInvite({
      tokenHash: "token_1",
      userId: "user_other",
      email: "other@neatech.cz",
      now: new Date("2026-06-06T08:10:00.000Z"),
    }),
    (error) => {
      assertErrorCode(error, "invite_not_found")
      return true
    },
  )

  assert.equal(invites[0].status, "pending")
  assert.deepEqual(memberships, [])
})

test("signup invite resolution requires pending invite for matching email", async () => {
  const { repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
  })
  await repository.createOrganizationInvite({
    orgId: "org_1",
    email: "Invited@Neatech.CZ",
    tokenHash: "token_1",
    invitedByUserId: "admin_1",
    expiresAt: new Date("2026-06-06T09:00:00.000Z"),
  })

  const invite = await repository.resolveValidOrganizationInviteForSignup({
    email: " invited@neatech.cz ",
    tokenHash: "token_1",
    now: new Date("2026-06-06T08:30:00.000Z"),
  })

  assert.equal(invite.orgId, "org_1")
  await assert.rejects(
    repository.resolveValidOrganizationInviteForSignup({
      email: "other@neatech.cz",
      tokenHash: "token_1",
      now: new Date("2026-06-06T08:30:00.000Z"),
    }),
    (error) => {
      assertErrorCode(error, "invite_not_found")
      return true
    },
  )
})

test("invite acceptance locks organization before counting seats and activating", async () => {
  const { operations, repository } = createMemoryRepository({
    organizations: [{ id: "org_1", seatLimit: 2 }],
  })
  await repository.createOrganizationInvite({
    orgId: "org_1",
    email: "invited@neatech.cz",
    role: "member",
    tokenHash: "token_1",
    invitedByUserId: "admin_1",
  })

  await repository.acceptOrganizationInvite({
    tokenHash: "token_1",
    userId: "user_invited",
    now: new Date("2026-06-06T08:10:00.000Z"),
  })

  assert.deepEqual(operations, [
    "lock:org_1",
    "count:org_1",
    "activate:org_1:user_invited",
  ])
})

test("production invite acceptance CAS requires the token hash read at lookup", () => {
  const source = readFileSync(new URL("../src/org-admin/repository.ts", import.meta.url), "utf8")
  const acceptSource = source.match(/async acceptOrganizationInvite[\s\S]*?listOrganizationMembers\(orgId\)/)?.[0] ?? ""
  const markAcceptedSource = source.match(/async markInviteAccepted[\s\S]*?async listOrganizationMembers/)?.[0] ?? ""

  assert.match(acceptSource, /expectedTokenHash:\s*invite\.tokenHash/)
  assert.match(markAcceptedSource, /eq\(OrganizationInviteTable\.token_hash,\s*input\.expectedTokenHash\)/)
})

test("extractAffectedRows handles common MySQL mutation results", () => {
  assert.equal(extractAffectedRows([{ affectedRows: 1 }]), 1)
  assert.equal(extractAffectedRows({ affectedRows: 0 }), 0)
  assert.equal(extractAffectedRows(undefined), null)
})

test("HTTP organization member creation routes through shared activation policy", () => {
  const source = readFileSync(new URL("../src/http/orgs.ts", import.meta.url), "utf8")
  assert.match(source, /createOrActivateOrganizationMembership/)
  assert.doesNotMatch(source, /db\.insert\(OrgMembershipTable\)\.values/)
})

test("admin runtime organization assignment routes through shared activation policy", () => {
  const source = readFileSync(new URL("../src/http/admin-runtime.ts", import.meta.url), "utf8")
  assert.match(source, /createOrActivateOrganizationMembership/)
  assert.doesNotMatch(source, /db\.insert\(OrgMembershipTable\)\.values/)
})
