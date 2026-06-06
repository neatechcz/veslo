import assert from "node:assert/strict"
import test from "node:test"
import {
  completeSignupAfterUserCreate,
  decideSignupAccess,
  runSignupAfterUserCreateSideEffects,
  resolveEmailSignupAccess,
} from "../src/auth/signup-gate.js"
import {
  ADMIN_PROVISIONING_SIGNUP_HEADER,
  createAdminProvisioningSignupHeaders,
  isAdminProvisioningSignupRequest,
} from "../src/auth/admin-provisioning.js"
import { OrganizationAdminRepositoryError, type OrganizationAdminInviteRecord } from "../src/org-admin/repository.js"

test("enabled organization domain auto-activates when a seat is available", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 3,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: true, mode: "domain", organizationId: "org_1" },
  )
})

test("enabled organization domain blocks when seat limit is reached", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 10,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: false, error: "seat_limit_reached" },
  )
})

test("missing enabled domain requires invite", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: null,
      activeSeats: 0,
      seatLimit: null,
      hasValidInvite: false,
    }),
    { ok: false, error: "domain_not_allowed" },
  )
})

test("post-create domain signup activates membership and skips default org fallback", async () => {
  const activated: unknown[] = []
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "user@neatech.cz" },
    inviteToken: null,
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_1", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input) => {
      activated.push(input)
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted for domain signup")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: true, createDefaultOrganization: false })
  assert.deepEqual(activated, [{
    membershipId: "membership_1",
    orgId: "org_1",
    userId: "user_1",
    role: "member",
  }])
})

test("post-create domain signup ignores unrelated invite token and activates domain membership", async () => {
  const activated: unknown[] = []
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "user@neatech.cz" },
    inviteToken: "unrelated_invite_token",
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_1", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input) => {
      activated.push(input)
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("unrelated invite should not be accepted for domain signup")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: true, createDefaultOrganization: false })
  assert.deepEqual(activated, [{
    membershipId: "membership_1",
    orgId: "org_1",
    userId: "user_1",
    role: "member",
  }])
})

test("invite signup checks invite organization seat capacity before user create", async () => {
  const checkedSeats: string[] = []
  const decision = await resolveEmailSignupAccess({
    email: "invited@example.test",
    inviteToken: "invite_token_1",
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used for invite signup")
      },
      assertCanActivateOrganizationSeat: async (orgId: string) => {
        checkedSeats.push(orgId)
        throw new OrganizationAdminRepositoryError("seat_limit_reached")
      },
      resolveValidOrganizationInviteForSignup: async () => createInviteRecord({
        orgId: "org_full",
        email: "invited@example.test",
        role: "member",
        tokenHash: "invite_token_1",
      }),
    },
  })

  assert.deepEqual(decision, { ok: false, error: "seat_limit_reached" })
  assert.deepEqual(checkedSeats, ["org_full"])
})

test("invite signup resolves repository lookup with a stable hash of the raw invite token", async () => {
  const capturedTokenHashes: string[] = []
  const dependencies = {
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    countActiveOrganizationSeats: async () => {
      throw new Error("domain seat count should not be used for invite signup")
    },
    assertCanActivateOrganizationSeat: async () => undefined,
    resolveValidOrganizationInviteForSignup: async (input: { email: string; tokenHash: string }) => {
      capturedTokenHashes.push(input.tokenHash)
      return createInviteRecord({
        orgId: "org_1",
        email: input.email,
        role: "member",
        tokenHash: input.tokenHash,
      })
    },
  }

  await resolveEmailSignupAccess({
    email: "invited@example.test",
    inviteToken: "raw_invite_token_once",
    dependencies,
  })
  await resolveEmailSignupAccess({
    email: "invited@example.test",
    inviteToken: "raw_invite_token_once",
    dependencies,
  })

  assert.equal(capturedTokenHashes.length, 2)
  assert.equal(capturedTokenHashes[0], capturedTokenHashes[1])
  assert.notEqual(capturedTokenHashes[0], "raw_invite_token_once")
})

test("post-create invite acceptance receives a stable hash instead of the raw invite token", async () => {
  const acceptedTokenHashes: string[] = []
  const input = {
    user: { id: "user_1", email: "invited@example.test" },
    inviteToken: "raw_invite_token_once",
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("domain membership should not be activated")
    },
    acceptOrganizationInvite: async (acceptInput: { tokenHash: string; userId: string; email: string }) => {
      acceptedTokenHashes.push(acceptInput.tokenHash)
      return {
        invite: createInviteRecord({
          email: acceptInput.email,
          tokenHash: acceptInput.tokenHash,
        }),
        membership: {
          id: "membership_1",
          orgId: "org_1",
          userId: acceptInput.userId,
          role: "member" as const,
          status: "active" as const,
          createdAt: new Date("2026-06-06T08:00:00.000Z"),
        },
      }
    },
  }

  await completeSignupAfterUserCreate(input)
  await completeSignupAfterUserCreate(input)

  assert.equal(acceptedTokenHashes.length, 2)
  assert.equal(acceptedTokenHashes[0], acceptedTokenHashes[1])
  assert.notEqual(acceptedTokenHashes[0], "raw_invite_token_once")
})

test("social post-create without authorized signup access does not authorize default org fallback", async () => {
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "personal@example.test" },
    inviteToken: null,
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: false, createDefaultOrganization: false })
})

test("post-create activation failure cleans up the just-created auth user before rethrowing", async () => {
  const activationError = new Error("seat activation failed")
  const calls: string[] = []

  await assert.rejects(
    runSignupAfterUserCreateSideEffects({
      user: { id: "user_1", email: "user@neatech.cz" },
      name: "User One",
      inviteToken: null,
      createMembershipId: () => "membership_1",
      resolveEnabledOrganizationDomainForEmail: async () => ({
        id: "domain_1",
        orgId: "org_1",
        domain: "neatech.cz",
        enabled: true,
        selfSignupEnabled: true,
        organization: { id: "org_1", seatLimit: 10 },
      }),
      createOrActivateOrganizationMembership: async () => {
        calls.push("activate")
        throw activationError
      },
      acceptOrganizationInvite: async () => {
        throw new Error("invite should not be accepted")
      },
      ensureDefaultOrg: async () => {
        calls.push("default-org")
        throw new Error("default org should not be created")
      },
      assignManagedAiAccess: async () => {
        calls.push("managed-ai")
        return false
      },
      cleanupCreatedAuthUser: async (userId) => {
        calls.push(`cleanup:${userId}`)
      },
    }),
    activationError,
  )

  assert.deepEqual(calls, ["activate", "cleanup:user_1"])
})

test("post-create managed AI assignment runs after active membership creation succeeds", async () => {
  const calls: string[] = []

  const result = await runSignupAfterUserCreateSideEffects({
    user: { id: "user_1", email: "user@neatech.cz" },
    name: "User One",
    inviteToken: null,
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_1",
      orgId: "org_1",
      domain: "neatech.cz",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_1", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input) => {
      calls.push("activate")
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-06-06T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureDefaultOrg: async () => {
      throw new Error("default org should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("managed-ai")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: true, createDefaultOrganization: false })
  assert.deepEqual(calls, ["activate", "managed-ai"])
})

test("forged external admin provisioning header does not bypass signup authorization", () => {
  const forgedRequest = {
    headers: {
      [ADMIN_PROVISIONING_SIGNUP_HEADER]: "external-forgery",
    },
  }

  assert.equal(isAdminProvisioningSignupRequest(forgedRequest), false)
  assert.equal(isAdminProvisioningSignupRequest({ headers: createAdminProvisioningSignupHeaders() }), true)
})

function createInviteRecord(overrides: Partial<OrganizationAdminInviteRecord> = {}): OrganizationAdminInviteRecord {
  return {
    id: "invite_1",
    orgId: "org_1",
    email: "invited@example.test",
    role: "member",
    status: "pending",
    tokenHash: "invite_token_1",
    invitedByUserId: "admin_1",
    acceptedByUserId: null,
    expiresAt: null,
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-06-06T08:00:00.000Z"),
    updatedAt: new Date("2026-06-06T08:00:00.000Z"),
    ...overrides,
  }
}
