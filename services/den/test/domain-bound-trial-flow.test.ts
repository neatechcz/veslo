import assert from "node:assert/strict"
import test from "node:test"

import {
  provisionVerifiedSignupUser,
  runSignupAfterUserCreateSideEffects,
} from "../src/auth/signup-gate.js"
import {
  AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  createAutomaticOrganizationTrialService,
  type AutomaticOrganizationTrialGrant,
  type AutomaticOrganizationTrialStore,
} from "../src/billing/automatic-organization-trial.js"
import {
  createOrganizationDomainMutationService,
  type OrganizationDomainMutationRecord,
  type OrganizationDomainMutationScope,
  type OrganizationDomainMutationStore,
} from "../src/org-admin/domain-mutations.js"
import {
  createOrganizationDomainVerifier,
  type OrganizationDomainMemberEvidenceCandidate,
} from "../src/org-admin/domain-verification.js"
import { normalizeEmailDomain } from "../src/org-admin/policy.js"
import { OrganizationAdminRepositoryError } from "../src/org-admin/repository.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_test",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { createEnsureSignupOrganization } = await import("../src/orgs.js")

const NOW = new Date("2026-07-21T08:00:00.000Z")
const EXPECTED_EXPIRY = new Date("2026-08-04T08:00:00.000Z")

type WorkflowMember = OrganizationDomainMemberEvidenceCandidate & {
  id: string
  role: "member" | "organization_admin"
}

type WorkflowTrial = {
  source: "manual_trial"
  expiresAt: Date
}

type WorkflowState = {
  organizations: Map<string, { id: string; name: string; seatLimit: number | null }>
  members: Map<string, WorkflowMember>
  domains: Map<string, OrganizationDomainMutationRecord>
  claims: Map<string, string>
  trials: Map<string, WorkflowTrial>
  automaticTrialHistory: Set<string>
  grants: AutomaticOrganizationTrialGrant[]
}

function emptyState(): WorkflowState {
  return {
    organizations: new Map(),
    members: new Map(),
    domains: new Map(),
    claims: new Map(),
    trials: new Map(),
    automaticTrialHistory: new Set(),
    grants: [],
  }
}

function cloneState(state: WorkflowState): WorkflowState {
  return {
    organizations: new Map([...state.organizations].map(([id, organization]) => [id, { ...organization }])),
    members: new Map([...state.members].map(([id, member]) => [id, { ...member }])),
    domains: new Map([...state.domains].map(([id, domain]) => [id, { ...domain }])),
    claims: new Map(state.claims),
    trials: new Map([...state.trials].map(([orgId, trial]) => [orgId, {
      ...trial,
      expiresAt: new Date(trial.expiresAt),
    }])),
    automaticTrialHistory: new Set(state.automaticTrialHistory),
    grants: state.grants.map((grant) => ({
      ...grant,
      manualAccessExpiresAt: new Date(grant.manualAccessExpiresAt),
    })),
  }
}

class InMemoryDomainTrialWorkflowStore implements OrganizationDomainMutationStore {
  state = emptyState()

  async findById(orgId: string, domainId: string) {
    const domain = this.state.domains.get(domainId)
    return domain?.orgId === orgId ? { ...domain } : null
  }

  async findByDomain(domain: string) {
    const normalizedDomain = domain.trim().toLowerCase()
    const match = [...this.state.domains.values()]
      .find((entry) => entry.domain === normalizedDomain)
    return match ? { ...match } : null
  }

  async transaction<T>(run: (scope: OrganizationDomainMutationScope) => Promise<T>) {
    return this.runTransaction(async (working) => {
      const verifier = createOrganizationDomainVerifier({
        async listMembers(orgId) {
          return [...working.members.values()]
            .filter((member) => member.orgId === orgId)
            .map((member) => ({ ...member }))
        },
      })
      const scope: OrganizationDomainMutationScope = {
        async lockOrganization(orgId) {
          if (!working.organizations.has(orgId)) {
            throw new Error("organization_not_found")
          }
        },
        async findById(orgId, domainId) {
          const domain = working.domains.get(domainId)
          return domain?.orgId === orgId ? { ...domain } : null
        },
        requireVerifiedMember(orgId, domain) {
          return verifier.requireVerifiedMember(orgId, domain)
        },
        async insert(record) {
          working.domains.set(record.id, { ...record })
        },
        async update(orgId, domainId, update) {
          const current = working.domains.get(domainId)
          if (current?.orgId === orgId) {
            working.domains.set(domainId, { ...current, ...update })
          }
        },
        async synchronizeTrial(orgId) {
          await createAutomaticOrganizationTrialService({
            store: automaticTrialStoreFor(working),
            now: () => NOW,
          }).ensureTrial(orgId)
        },
      }
      return run(scope)
    })
  }

  async createOrganizationMembershipDomainAndTrial(input: {
    orgId: string
    membershipId: string
    domainId: string
    userId: string
    name: string
    slug: string
    domain: string
  }) {
    await this.runTransaction(async (working) => {
      working.organizations.set(input.orgId, {
        id: input.orgId,
        name: input.name,
        seatLimit: null,
      })
      working.members.set(input.membershipId, {
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        email: `${input.userId}@${input.domain}`,
        emailVerified: true,
        membershipStatus: "active",
        role: "organization_admin",
      })
      working.domains.set(input.domainId, {
        id: input.domainId,
        orgId: input.orgId,
        domain: input.domain,
        enabled: true,
        selfSignupEnabled: true,
      })
      await createAutomaticOrganizationTrialService({
        store: automaticTrialStoreFor(working),
        now: () => NOW,
      }).ensureTrial(input.orgId)
    })
  }

  addOrganization(id: string, name: string) {
    this.state.organizations.set(id, { id, name, seatLimit: null })
  }

  addVerifiedMember(input: { id: string; orgId: string; userId: string; email: string }) {
    this.state.members.set(input.id, {
      ...input,
      emailVerified: true,
      membershipStatus: "active",
      role: "member",
    })
  }

  removeDomain(domainId: string) {
    this.state.domains.delete(domainId)
  }

  findActiveOrganizationId(userId: string) {
    return [...this.state.members.values()]
      .find((member) => member.userId === userId && member.membershipStatus === "active")
      ?.orgId ?? null
  }

  resolveEnabledDomain(email: string) {
    const emailDomain = normalizeEmailDomain(email)
    const domain = [...this.state.domains.values()].find((entry) => (
      entry.domain === emailDomain && entry.enabled && entry.selfSignupEnabled
    ))
    const organization = domain ? this.state.organizations.get(domain.orgId) : null
    if (!domain || !organization) {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    }
    return {
      ...domain,
      organization: { id: organization.id, seatLimit: organization.seatLimit },
    }
  }

  private async runTransaction<T>(operation: (working: WorkflowState) => Promise<T>) {
    const working = cloneState(this.state)
    const result = await operation(working)
    this.state = working
    return result
  }
}

function automaticTrialStoreFor(state: WorkflowState): AutomaticOrganizationTrialStore {
  return {
    async listOrganizationIds() {
      return [...state.organizations.keys()]
    },
    async grantOrSyncDomainTrial(input) {
      const domains = [...new Set([...state.domains.values()]
        .filter((domain) => domain.orgId === input.orgId)
        .map((domain) => domain.domain.trim().toLowerCase()))].sort()
      if (domains.length === 0) {
        return { granted: false }
      }

      const hasExistingTrial = state.trials.has(input.orgId)
        || state.automaticTrialHistory.has(input.orgId)
      const hasForeignClaim = domains.some((domain) => {
        const owner = state.claims.get(domain)
        return owner !== undefined && owner !== input.orgId
      })
      if (hasExistingTrial) {
        if (hasForeignClaim) {
          return { granted: false }
        }
        for (const domain of domains) {
          state.claims.set(domain, input.orgId)
        }
        return { granted: false }
      }

      if (domains.some((domain) => state.claims.has(domain))) {
        return { granted: false }
      }

      for (const domain of domains) {
        state.claims.set(domain, input.orgId)
      }
      state.trials.set(input.orgId, {
        source: input.source,
        expiresAt: new Date(input.manualAccessExpiresAt),
      })
      state.automaticTrialHistory.add(input.orgId)
      state.grants.push({
        ...input,
        manualAccessExpiresAt: new Date(input.manualAccessExpiresAt),
      })
      return { granted: true }
    },
  }
}

function sequentialIds(...ids: string[]) {
  return () => {
    const id = ids.shift()
    assert.ok(id, "unexpected id request")
    return id
  }
}

test("verified signup and later domain transfer consume one immutable domain-bound trial", async () => {
  const store = new InMemoryDomainTrialWorkflowStore()
  const user = {
    id: "user_owner",
    name: "Owner",
    email: "owner@first.example",
    emailVerified: false,
  }
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: sequentialIds("org_first", "membership_owner", "domain_first"),
    findExistingOrganizationId: async (userId) => store.findActiveOrganizationId(userId),
    createOrganizationMembershipDomainAndTrial: (input) => (
      store.createOrganizationMembershipDomainAndTrial(input)
    ),
  })
  const signupDependencies = {
    runWithUserProvisioningLock: async <T>(_userId: string, operation: () => Promise<T>) => operation(),
    createMembershipId: () => "membership_joined",
    findExistingOrganizationId: async (userId: string) => store.findActiveOrganizationId(userId),
    resolveEnabledOrganizationDomainForEmail: async (email: string) => store.resolveEnabledDomain(email),
    createOrActivateOrganizationMembership: async (input: {
      membershipId: string
      orgId: string
      userId: string
      role: "member" | "organization_admin"
    }) => {
      store.addVerifiedMember({
        id: input.membershipId,
        orgId: input.orgId,
        userId: input.userId,
        email: user.email,
      })
      return {
        ...input,
        status: "active" as const,
        createdAt: NOW,
      }
    },
    ensureSignupOrganization,
    assignManagedAiAccess: async () => true,
  }

  const unverified = await runSignupAfterUserCreateSideEffects({
    ...signupDependencies,
    user,
    name: user.name,
    inviteToken: null,
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be used")
    },
    cleanupCreatedAuthUser: async () => undefined,
  })

  assert.equal(unverified.awaitingEmailVerification, true)
  assert.equal(store.state.organizations.size, 0)
  assert.equal(store.state.domains.size, 0)
  assert.equal(store.state.trials.size, 0)
  assert.equal(store.state.claims.size, 0)

  user.emailVerified = true
  const verified = await provisionVerifiedSignupUser({
    ...signupDependencies,
    user,
  })

  assert.equal(verified.organizationId, "org_first")
  assert.equal(store.state.organizations.size, 1)
  assert.deepEqual([...store.state.domains.values()].map((entry) => entry.domain), ["first.example"])
  assert.equal(store.state.trials.get("org_first")?.expiresAt.getTime(), EXPECTED_EXPIRY.getTime())
  assert.equal(store.state.claims.get("first.example"), "org_first")
  assert.equal(store.state.grants.length, 1)
  assert.equal(store.state.grants[0]?.manualAccessExpiresAt.getTime(), EXPECTED_EXPIRY.getTime())

  store.addVerifiedMember({
    id: "membership_second_domain",
    orgId: "org_first",
    userId: "user_second_domain",
    email: "member@second.example",
  })
  const mutations = createOrganizationDomainMutationService({ store })
  const initialExpiry = store.state.trials.get("org_first")?.expiresAt.getTime()
  const addedDomain = await mutations.create({
    id: "domain_second",
    orgId: "org_first",
    domain: "second.example",
    enabled: true,
    selfSignupEnabled: false,
  })

  assert.equal(addedDomain.verifiedMemberUserId, "user_second_domain")
  assert.equal(store.state.claims.get("second.example"), "org_first")
  assert.equal(store.state.trials.get("org_first")?.expiresAt.getTime(), initialExpiry)
  assert.equal(store.state.grants.length, 1)

  store.removeDomain("domain_second")
  assert.equal(store.state.claims.get("second.example"), "org_first")
  store.addOrganization("org_second", "Second organization")
  store.addVerifiedMember({
    id: "membership_second_owner",
    orgId: "org_second",
    userId: "user_second_owner",
    email: "owner@second.example",
  })
  const transferredDomain = await mutations.create({
    id: "domain_second_reused",
    orgId: "org_second",
    domain: "second.example",
    enabled: true,
    selfSignupEnabled: true,
  })

  assert.equal(transferredDomain.verifiedMemberUserId, "user_second_owner")
  assert.equal(store.state.trials.has("org_second"), false)
  assert.equal(store.state.claims.get("second.example"), "org_first")
  assert.equal(store.state.grants.length, 1)
  assert.equal(store.state.trials.get("org_first")?.expiresAt.getTime(), initialExpiry)
  assert.deepEqual([...store.state.claims], [
    ["first.example", "org_first"],
    ["second.example", "org_first"],
  ])
  assert.equal(
    (EXPECTED_EXPIRY.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1_000),
    AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
  )
})
