import assert from "node:assert/strict"
import test from "node:test"
import {
  provisionVerifiedSignupUser,
  runSignupAfterUserCreateSideEffects,
} from "../src/auth/signup-gate.js"
import { SignupOrganizationDomainConflictError } from "../src/auth/signup-organization.js"
import { OrganizationAdminRepositoryError } from "../src/org-admin/repository.js"

const runWithoutConcurrency = async <T>(_userId: string, operation: () => Promise<T>) => operation()

function createUserProvisioningLock() {
  const pending = new Map<string, Promise<void>>()
  return async <T>(userId: string, operation: () => Promise<T>) => {
    const previous = pending.get(userId) ?? Promise.resolve()
    let release = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    pending.set(userId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (pending.get(userId) === queued) {
        pending.delete(userId)
      }
    }
  }
}

test("verification provisions organization domain and trial before managed AI", async () => {
  const calls: string[] = []

  const result = await provisionVerifiedSignupUser({
    user: {
      id: "user_1",
      name: "User One",
      email: "owner@team.example.com",
      emailVerified: true,
    },
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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

test("lock acquisition failure after domain membership activation preserves the auth user for recovery", async () => {
  const lockError = new Error("signup_user_provisioning_lock_unavailable")
  const calls: string[] = []

  await assert.rejects(runSignupAfterUserCreateSideEffects({
    user: {
      id: "user_domain_lock_failure",
      email: "member@team.example.com",
      emailVerified: true,
    },
    name: "Domain Member",
    inviteToken: null,
    runWithUserProvisioningLock: async () => {
      calls.push("lock:acquire")
      throw lockError
    },
    createMembershipId: () => "membership_domain_lock_failure",
    findExistingOrganizationId: async () => "org_team",
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_team",
      orgId: "org_team",
      domain: "team.example.com",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_team", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (input) => {
      calls.push("membership:active")
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
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  }), lockError)

  assert.deepEqual(calls, ["membership:active", "lock:acquire"])
})

test("lock release failure after invite activation preserves the auth user for recovery", async () => {
  const releaseError = new Error("signup_user_provisioning_lock_release_failed")
  const calls: string[] = []
  let activeOrganizationId: string | null = null

  await assert.rejects(runSignupAfterUserCreateSideEffects({
    user: {
      id: "user_invite_release_failure",
      email: "invited@other.example.com",
      emailVerified: true,
    },
    name: "Invited Member",
    inviteToken: "invite_token",
    runWithUserProvisioningLock: async (_userId, operation) => {
      calls.push("lock:acquired")
      await operation()
      calls.push("lock:release")
      throw releaseError
    },
    createMembershipId: () => "membership_invite_release_failure",
    findExistingOrganizationId: async () => activeOrganizationId,
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("domain membership should not be activated")
    },
    acceptOrganizationInvite: async (input) => {
      calls.push("invite:accepted")
      activeOrganizationId = "org_invited"
      return {
        invite: {
          id: "invite_release_failure",
          orgId: "org_invited",
          email: input.email,
          role: "member",
          status: "accepted",
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
          id: "membership_invite_release_failure",
          orgId: "org_invited",
          userId: input.userId,
          role: "member",
          status: "active",
          createdAt: new Date("2026-07-21T08:00:00.000Z"),
        },
      }
    },
    ensureSignupOrganization: async () => {
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async () => {
      calls.push("ai-access")
    },
    cleanupCreatedAuthUser: async () => {
      calls.push("cleanup")
    },
  }), releaseError)

  assert.deepEqual(calls, ["invite:accepted", "lock:acquired", "lock:release"])
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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
    runWithUserProvisioningLock: runWithoutConcurrency,
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

test("concurrent verified provisioning for one user creates only one membership", async () => {
  let activeOrganizationId: string | null = null
  const memberships: Array<{ orgId: string; role: string }> = []
  const aiAccessUsers = new Set<string>()
  const runWithUserProvisioningLock = createUserProvisioningLock()
  const input = {
    user: {
      id: "user_concurrent",
      name: "Concurrent User",
      email: "user@existing.example.com",
      emailVerified: true,
    },
    runWithUserProvisioningLock,
    createMembershipId: () => `membership_${memberships.length + 1}`,
    findExistingOrganizationId: async () => {
      const snapshot = activeOrganizationId
      await new Promise<void>((resolve) => setImmediate(resolve))
      return snapshot
    },
    resolveEnabledOrganizationDomainForEmail: async () => ({
      id: "domain_existing",
      orgId: "org_existing",
      domain: "existing.example.com",
      enabled: true,
      selfSignupEnabled: true,
      organization: { id: "org_existing", seatLimit: 10 },
    }),
    createOrActivateOrganizationMembership: async (membership: {
      membershipId: string
      orgId: string
      userId: string
      role: "member" | "organization_admin"
    }) => {
      memberships.push({ orgId: membership.orgId, role: membership.role })
      activeOrganizationId = membership.orgId
      return {
        id: membership.membershipId,
        orgId: membership.orgId,
        userId: membership.userId,
        role: membership.role,
        status: "active" as const,
        createdAt: new Date("2026-07-21T08:00:00.000Z"),
      }
    },
    ensureSignupOrganization: async () => {
      throw new Error("organization should not be created")
    },
    assignManagedAiAccess: async (userId: string) => {
      aiAccessUsers.add(userId)
      return true
    },
  }

  const results = await Promise.all([
    provisionVerifiedSignupUser(input),
    provisionVerifiedSignupUser(input),
  ])

  assert.deepEqual(results.map((entry) => entry.organizationId), ["org_existing", "org_existing"])
  assert.deepEqual(memberships, [{ orgId: "org_existing", role: "member" }])
  assert.deepEqual([...aiAccessUsers], ["user_concurrent"])
})

test("concurrent verified first-user provisioning preserves one organization admin membership", async () => {
  let activeOrganizationId: string | null = null
  const organizations: string[] = []
  const memberships: Array<{ orgId: string; role: string }> = []
  const aiAccessUsers = new Set<string>()
  const runWithUserProvisioningLock = createUserProvisioningLock()
  const input = {
    user: {
      id: "user_concurrent_founder",
      name: "Concurrent Founder",
      email: "founder@new.example.com",
      emailVerified: true,
    },
    runWithUserProvisioningLock,
    createMembershipId: () => `membership_${memberships.length + 1}`,
    findExistingOrganizationId: async () => {
      const snapshot = activeOrganizationId
      await new Promise<void>((resolve) => setImmediate(resolve))
      return snapshot
    },
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("existing domain membership should not be activated")
    },
    ensureSignupOrganization: async () => {
      const orgId = `org_${organizations.length + 1}`
      organizations.push(orgId)
      memberships.push({ orgId, role: "organization_admin" })
      activeOrganizationId = orgId
      return orgId
    },
    assignManagedAiAccess: async (userId: string) => {
      aiAccessUsers.add(userId)
      return true
    },
  }

  const results = await Promise.all([
    provisionVerifiedSignupUser(input),
    provisionVerifiedSignupUser(input),
  ])

  assert.deepEqual(results.map((entry) => entry.organizationId), ["org_1", "org_1"])
  assert.deepEqual(organizations, ["org_1"])
  assert.deepEqual(memberships, [{ orgId: "org_1", role: "organization_admin" }])
  assert.deepEqual([...aiAccessUsers], ["user_concurrent_founder"])
})

test("domain conflict recovery reuses a concurrently created admin membership without downgrading it", async () => {
  let activeOrganizationId: string | null = null
  let role = "organization_admin"
  let domainLookups = 0
  const membershipWrites: string[] = []

  const result = await provisionVerifiedSignupUser({
    user: {
      id: "user_founder",
      name: "Founder",
      email: "founder@team.example.com",
      emailVerified: true,
    },
    runWithUserProvisioningLock: createUserProvisioningLock(),
    createMembershipId: () => "membership_founder",
    findExistingOrganizationId: async () => activeOrganizationId,
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
    createOrActivateOrganizationMembership: async (membership) => {
      membershipWrites.push(membership.role)
      role = membership.role
      return {
        id: membership.membershipId,
        orgId: membership.orgId,
        userId: membership.userId,
        role: membership.role,
        status: "active",
        createdAt: new Date("2026-07-21T08:00:00.000Z"),
      }
    },
    ensureSignupOrganization: async () => {
      activeOrganizationId = "org_winner"
      throw new SignupOrganizationDomainConflictError("team.example.com")
    },
    assignManagedAiAccess: async () => true,
  })

  assert.equal(result.organizationId, "org_winner")
  assert.equal(role, "organization_admin")
  assert.deepEqual(membershipWrites, [])
})
