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
import { SignupOrganizationDomainConflictError } from "../src/auth/signup-organization.js"
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

test("missing registered domain selects organization bootstrap", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: null,
      activeSeats: 0,
      seatLimit: null,
      hasValidInvite: false,
    }),
    { ok: true, mode: "organization_bootstrap" },
  )
})

test("email signup without an enabled domain or invite selects organization bootstrap", async () => {
  const decision = await resolveEmailSignupAccess({
    email: "person@gmail.com",
    inviteToken: null,
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used for organization bootstrap")
      },
      assertCanActivateOrganizationSeat: async () => {
        throw new Error("invite seat check should not be used for organization bootstrap")
      },
      resolveValidOrganizationInviteForSignup: async () => {
        throw new Error("invite lookup should not be used for organization bootstrap")
      },
    },
  })

  assert.deepEqual(decision, { ok: true, mode: "organization_bootstrap" })
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

  assert.deepEqual(result, { activatedOrganizationMembership: true, createSignupOrganization: false })
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

  assert.deepEqual(result, { activatedOrganizationMembership: true, createSignupOrganization: false })
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

test("invite signup accepts legacy pending invites stored with raw token hashes", async () => {
  const capturedTokenHashes: string[] = []
  const decision = await resolveEmailSignupAccess({
    email: "invited@example.test",
    inviteToken: "legacy_raw_invite_token",
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used for invite signup")
      },
      assertCanActivateOrganizationSeat: async () => undefined,
      resolveValidOrganizationInviteForSignup: async (input: { email: string; tokenHash: string }) => {
        capturedTokenHashes.push(input.tokenHash)
        if (input.tokenHash !== "legacy_raw_invite_token") {
          throw new OrganizationAdminRepositoryError("invite_not_found")
        }
        return createInviteRecord({
          orgId: "org_legacy",
          email: input.email,
          role: "member",
          tokenHash: input.tokenHash,
        })
      },
    },
  })

  assert.deepEqual(decision, {
    ok: true,
    mode: "invite",
    organizationId: "org_legacy",
    role: "member",
    inviteToken: "legacy_raw_invite_token",
  })
  assert.equal(capturedTokenHashes.length, 2)
  assert.notEqual(capturedTokenHashes[0], "legacy_raw_invite_token")
  assert.equal(capturedTokenHashes[1], "legacy_raw_invite_token")
})

test("invite signup rejects submitted stored token hashes as bearer invite tokens", async () => {
  const storedTokenHash = "a".repeat(64)
  const capturedTokenHashes: string[] = []
  const decision = await resolveEmailSignupAccess({
    email: "invited@example.test",
    inviteToken: storedTokenHash,
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used for invite signup")
      },
      assertCanActivateOrganizationSeat: async () => undefined,
      resolveValidOrganizationInviteForSignup: async (input: { email: string; tokenHash: string }) => {
        capturedTokenHashes.push(input.tokenHash)
        if (input.tokenHash === storedTokenHash) {
          return createInviteRecord({
            orgId: "org_1",
            email: input.email,
            tokenHash: input.tokenHash,
          })
        }
        throw new OrganizationAdminRepositoryError("invite_not_found")
      },
    },
  })

  assert.deepEqual(decision, { ok: false, error: "domain_not_allowed" })
  assert.equal(capturedTokenHashes.length, 1)
  assert.notEqual(capturedTokenHashes[0], storedTokenHash)
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

test("post-create invite acceptance accepts legacy pending invites stored with raw token hashes", async () => {
  const acceptedTokenHashes: string[] = []
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "invited@example.test" },
    inviteToken: "legacy_raw_invite_token",
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("domain membership should not be activated")
    },
    acceptOrganizationInvite: async (acceptInput: { tokenHash: string; userId: string; email: string }) => {
      acceptedTokenHashes.push(acceptInput.tokenHash)
      if (acceptInput.tokenHash !== "legacy_raw_invite_token") {
        throw new OrganizationAdminRepositoryError("invite_not_found")
      }
      return {
        invite: createInviteRecord({
          email: acceptInput.email,
          tokenHash: acceptInput.tokenHash,
        }),
        membership: {
          id: "membership_legacy",
          orgId: "org_1",
          userId: acceptInput.userId,
          role: "member" as const,
          status: "active" as const,
          createdAt: new Date("2026-06-06T08:00:00.000Z"),
        },
      }
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: true, createSignupOrganization: false })
  assert.equal(acceptedTokenHashes.length, 2)
  assert.notEqual(acceptedTokenHashes[0], "legacy_raw_invite_token")
  assert.equal(acceptedTokenHashes[1], "legacy_raw_invite_token")
})

test("post-create invite acceptance rejects submitted stored token hashes as bearer invite tokens", async () => {
  const storedTokenHash = "b".repeat(64)
  const acceptedTokenHashes: string[] = []

  await assert.rejects(
    completeSignupAfterUserCreate({
      user: { id: "user_1", email: "invited@example.test" },
      inviteToken: storedTokenHash,
      createMembershipId: () => "membership_1",
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      createOrActivateOrganizationMembership: async () => {
        throw new Error("domain membership should not be activated")
      },
      acceptOrganizationInvite: async (acceptInput: { tokenHash: string; userId: string; email: string }) => {
        acceptedTokenHashes.push(acceptInput.tokenHash)
        if (acceptInput.tokenHash === storedTokenHash) {
          return {
            invite: createInviteRecord({
              email: acceptInput.email,
              tokenHash: acceptInput.tokenHash,
            }),
            membership: {
              id: "membership_hash",
              orgId: "org_1",
              userId: acceptInput.userId,
              role: "member" as const,
              status: "active" as const,
              createdAt: new Date("2026-06-06T08:00:00.000Z"),
            },
          }
        }
        throw new OrganizationAdminRepositoryError("invite_not_found")
      },
    }),
    (error) => {
      assert.ok(error instanceof OrganizationAdminRepositoryError)
      assert.equal(error.code, "invite_not_found")
      return true
    },
  )

  assert.equal(acceptedTokenHashes.length, 1)
  assert.notEqual(acceptedTokenHashes[0], storedTokenHash)
})

test("post-create signup without domain or invite requests organization bootstrap", async () => {
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

  assert.deepEqual(result, { activatedOrganizationMembership: false, createSignupOrganization: true })
})

test("unverified first signup defers organization bootstrap and managed AI without deleting the auth user", async () => {
  const calls: string[] = []
  const result = await runSignupAfterUserCreateSideEffects({
    user: {
      id: "user_unverified",
      email: "owner@team.example.com",
      emailVerified: false,
    },
    name: "Unverified Owner",
    inviteToken: null,
    createMembershipId: () => "membership_unverified",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      calls.push("membership")
      throw new Error("membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      calls.push("invite")
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      return "org_unverified"
    },
    assignManagedAiAccess: async () => {
      calls.push("managed-ai")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: true,
    activatedOrganizationMembership: false,
    createSignupOrganization: false,
  })
  assert.deepEqual(calls, [])
})

test("first signup bootstraps its organization before managed AI assignment", async () => {
  const calls: string[] = []
  const result = await runSignupAfterUserCreateSideEffects({
    user: { id: "user_1", email: "user@team.example.com", emailVerified: true },
    name: "User One",
    inviteToken: null,
    createMembershipId: () => "membership_1",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("existing domain membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async (userId, name, email) => {
      calls.push(`bootstrap:${userId}:${name}:${email}`)
      return "org_1"
    },
    assignManagedAiAccess: async () => {
      calls.push("managed-ai")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_1",
  })
  assert.deepEqual(calls, [
    "bootstrap:user_1:User One:user@team.example.com",
    "managed-ai",
  ])
})

test("concurrent first signup joins the organization that won the domain claim", async () => {
  let domainLookups = 0
  const calls: string[] = []
  const result = await runSignupAfterUserCreateSideEffects({
    user: { id: "user_loser", email: "user@team.example.com", emailVerified: true },
    name: "User Loser",
    inviteToken: null,
    createMembershipId: () => "membership_loser",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      domainLookups += 1
      if (domainLookups <= 2) {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      }
      return {
        id: "domain_winner",
        orgId: "org_winner",
        domain: "team.example.com",
        enabled: true,
        selfSignupEnabled: true,
        organization: { id: "org_winner", seatLimit: 10 },
      }
    },
    createOrActivateOrganizationMembership: async (input) => {
      calls.push(`member:${input.orgId}:${input.role}`)
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-07-21T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async () => {
      calls.push("bootstrap")
      throw new SignupOrganizationDomainConflictError("team.example.com")
    },
    assignManagedAiAccess: async () => {
      calls.push("managed-ai")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_winner",
  })
  assert.equal(domainLookups, 3)
  assert.deepEqual(calls, ["bootstrap", "member:org_winner:member", "managed-ai"])
})

test("concurrent conflict never re-enables a disabled or invite-only domain", async () => {
  const calls: string[] = []
  await assert.rejects(
    runSignupAfterUserCreateSideEffects({
      user: { id: "user_loser", email: "user@team.example.com", emailVerified: true },
      name: "User Loser",
      inviteToken: null,
      createMembershipId: () => "membership_loser",
      findExistingOrganizationId: async () => null,
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      createOrActivateOrganizationMembership: async () => {
        calls.push("member")
        throw new Error("disabled domain membership must not be activated")
      },
      acceptOrganizationInvite: async () => {
        throw new Error("invite should not be accepted")
      },
      ensureSignupOrganization: async () => {
        calls.push("bootstrap")
        throw new SignupOrganizationDomainConflictError("team.example.com")
      },
      assignManagedAiAccess: async () => {
        calls.push("managed-ai")
        return true
      },
      cleanupCreatedAuthUser: async (userId) => {
        calls.push(`cleanup:${userId}`)
      },
    }),
    (error) => {
      assert.ok(error instanceof OrganizationAdminRepositoryError)
      assert.equal(error.code, "domain_not_allowed")
      return true
    },
  )

  assert.deepEqual(calls, ["bootstrap", "cleanup:user_loser"])
})

test("post-create activation failure cleans up the just-created auth user before rethrowing", async () => {
  const activationError = new Error("seat activation failed")
  const calls: string[] = []

  await assert.rejects(
    runSignupAfterUserCreateSideEffects({
      user: { id: "user_1", email: "user@neatech.cz", emailVerified: true },
      name: "User One",
      inviteToken: null,
      createMembershipId: () => "membership_1",
      findExistingOrganizationId: async () => null,
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
      ensureSignupOrganization: async () => {
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
    user: { id: "user_1", email: "user@neatech.cz", emailVerified: true },
    name: "User One",
    inviteToken: null,
    createMembershipId: () => "membership_1",
    findExistingOrganizationId: async () => "org_1",
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
    ensureSignupOrganization: async () => {
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

  assert.deepEqual(result, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_1",
  })
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
