import assert from "node:assert/strict"
import test from "node:test"
import {
  provisionVerifiedSignupUser,
  runSignupAfterUserCreateSideEffects,
} from "../src/auth/signup-gate.js"
import { SignupOrganizationDomainConflictError } from "../src/auth/signup-organization.js"
import { OrganizationAdminRepositoryError } from "../src/org-admin/repository.js"

test("verification provisions organization domain and trial before managed AI", async () => {
  const calls: string[] = []

  const result = await provisionVerifiedSignupUser({
    user: {
      id: "user_1",
      name: "User One",
      email: "owner@team.example.com",
      emailVerified: true,
    },
    createMembershipId: () => "membership_1",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("membership should not be activated")
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      return "org_1"
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_1",
  })
  assert.deepEqual(calls, ["organization-domain-trial", "ai-access"])
})

test("verified user-create reuses an existing active membership instead of bootstrapping another organization", async () => {
  const calls: string[] = []

  const result = await runSignupAfterUserCreateSideEffects({
    user: {
      id: "user_existing",
      name: "Existing User",
      email: "existing@team.example.com",
      emailVerified: true,
    },
    name: "Existing User",
    inviteToken: null,
    createMembershipId: () => "membership_unused",
    findExistingOrganizationId: async () => "org_existing",
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      calls.push("membership")
      throw new Error("membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_existing",
  })
  assert.deepEqual(calls, ["ai-access"])
})

test("unverified provisioner defers without touching organizations or managed AI", async () => {
  const calls: string[] = []
  const result = await provisionVerifiedSignupUser({
    user: {
      id: "user_unverified",
      name: "Unverified User",
      email: "user@team.example.com",
      emailVerified: false,
    },
    createMembershipId: () => {
      calls.push("membership-id")
      return "membership_unused"
    },
    findExistingOrganizationId: async () => {
      calls.push("find-membership")
      return null
    },
    resolveEnabledOrganizationDomainForEmail: async () => {
      calls.push("resolve-domain")
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      calls.push("membership")
      throw new Error("membership should not be activated")
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      return "org_unused"
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
  })

  assert.deepEqual(result, {
    awaitingEmailVerification: true,
    activatedOrganizationMembership: false,
    organizationId: null,
  })
  assert.deepEqual(calls, [])
})

test("membership activated before verification receives managed AI only after verification", async () => {
  let activeOrganizationId: string | null = null
  const calls: string[] = []
  const dependencies = {
    createMembershipId: () => "membership_1",
    findExistingOrganizationId: async () => activeOrganizationId,
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_1",
      orgId: "org_existing",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_existing", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input: {
      membershipId: string
      orgId: string
      userId: string
      role: "member" | "organization_admin"
    }) => {
      calls.push("membership")
      activeOrganizationId = input.orgId
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active" as const,
        createdAt: new Date("2026-07-21T08:00:00.000Z"),
      }
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async () => {
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  }

  const pending = await runSignupAfterUserCreateSideEffects({
    ...dependencies,
    user: {
      id: "user_1",
      email: "user@team.example.com",
      emailVerified: false,
    },
    name: "User One",
    inviteToken: null,
  })
  assert.equal(pending.awaitingEmailVerification, true)
  assert.deepEqual(calls, ["membership"])

  const verified = await provisionVerifiedSignupUser({
    ...dependencies,
    user: {
      id: "user_1",
      name: "User One",
      email: "user@team.example.com",
      emailVerified: true,
    },
  })
  assert.deepEqual(verified, {
    awaitingEmailVerification: false,
    activatedOrganizationMembership: true,
    organizationId: "org_existing",
  })
  assert.deepEqual(calls, ["membership", "ai-access"])
})

test("invite accepted before verification receives managed AI only after verification", async () => {
  let activeOrganizationId: string | null = null
  const calls: string[] = []
  const dependencies = {
    createMembershipId: () => "membership_invited",
    findExistingOrganizationId: async () => activeOrganizationId,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("domain membership should not be activated")
    },
    acceptOrganizationInvite: async (input: { tokenHash: string; userId: string; email: string }) => {
      calls.push("invite")
      activeOrganizationId = "org_invited"
      return {
        invite: {
          id: "invite_1",
          orgId: "org_invited",
          email: input.email,
          role: "member" as const,
          status: "accepted" as const,
          tokenHash: input.tokenHash,
          invitedByUserId: "admin_1",
          acceptedByUserId: input.userId,
          expiresAt: null,
          acceptedAt: new Date("2026-07-21T08:00:00.000Z"),
          revokedAt: null,
          createdAt: new Date("2026-07-20T08:00:00.000Z"),
          updatedAt: new Date("2026-07-21T08:00:00.000Z"),
        },
        membership: {
          id: "membership_invited",
          orgId: "org_invited",
          userId: input.userId,
          role: "member" as const,
          status: "active" as const,
          createdAt: new Date("2026-07-21T08:00:00.000Z"),
        },
      }
    },
    ensureSignupOrganization: async () => {
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  }

  const pending = await runSignupAfterUserCreateSideEffects({
    ...dependencies,
    user: {
      id: "user_invited",
      email: "invited@other.example.com",
      emailVerified: false,
    },
    name: "Invited User",
    inviteToken: "raw_invite_token",
  })
  assert.equal(pending.awaitingEmailVerification, true)
  assert.deepEqual(calls, ["invite"])

  await provisionVerifiedSignupUser({
    ...dependencies,
    user: {
      id: "user_invited",
      name: "Invited User",
      email: "invited@other.example.com",
      emailVerified: true,
    },
  })
  assert.deepEqual(calls, ["invite", "ai-access"])
})

test("trusted verified social creation provisions immediately", async () => {
  const calls: string[] = []
  const result = await runSignupAfterUserCreateSideEffects({
    user: {
      id: "user_social",
      email: "owner@social.example.com",
      emailVerified: true,
    },
    name: "Social Owner",
    inviteToken: null,
    createMembershipId: () => "membership_social",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      return "org_social"
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  })

  assert.equal(result.awaitingEmailVerification, false)
  assert.equal(result.organizationId, "org_social")
  assert.deepEqual(calls, ["organization-domain-trial", "ai-access"])
})

test("verified provisioning retry does not create duplicate organization domain trial or access", async () => {
  let activeOrganizationId: string | null = null
  const organizations = new Set<string>()
  const accessUsers = new Set<string>()

  const input = {
    user: {
      id: "user_retry",
      name: "Retry User",
      email: "retry@team.example.com",
      emailVerified: true,
    },
    createMembershipId: () => "membership_retry",
    findExistingOrganizationId: async () => activeOrganizationId,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("membership should not be activated")
    },
    ensureSignupOrganization: async () => {
      organizations.add("org_retry")
      activeOrganizationId = "org_retry"
      return "org_retry"
    },
    assignManagedAiAccess: async (userId: string) => {
      accessUsers.add(userId)
      return true
    },
  }

  await provisionVerifiedSignupUser(input)
  await provisionVerifiedSignupUser(input)

  assert.deepEqual([...organizations], ["org_retry"])
  assert.deepEqual([...accessUsers], ["user_retry"])
})

test("verified provisioning recovers a concurrent signup domain claim by joining the winner", async () => {
  let domainLookups = 0
  const calls: string[] = []

  const result = await provisionVerifiedSignupUser({
    user: {
      id: "user_loser",
      name: "User Loser",
      email: "loser@team.example.com",
      emailVerified: true,
    },
    createMembershipId: () => "membership_loser",
    findExistingOrganizationId: async () => null,
    resolveEnabledOrganizationDomainForEmail: async () => {
      domainLookups += 1
      if (domainLookups === 1) {
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
      calls.push(`membership:${input.orgId}`)
      return {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
        status: "active",
        createdAt: new Date("2026-07-21T08:00:00.000Z"),
      }
    },
    ensureSignupOrganization: async () => {
      calls.push("organization-domain-trial")
      throw new SignupOrganizationDomainConflictError("team.example.com")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
      return true
    },
  })

  assert.equal(result.organizationId, "org_winner")
  assert.deepEqual(calls, ["organization-domain-trial", "membership:org_winner", "ai-access"])
})
