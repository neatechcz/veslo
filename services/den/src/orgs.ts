import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import {
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
} from "./billing/automatic-organization-trial.js"
import { SignupOrganizationDomainConflictError } from "./auth/signup-organization.js"
import { db } from "./db/index.js"
import { isMySqlDuplicateKeyError } from "./db/mysql-errors.js"
import { OrgMembershipTable, OrgTable, OrganizationDomainTable } from "./db/schema.js"
import { normalizeEmailDomain } from "./org-admin/policy.js"
import { OrganizationAdminRepositoryError } from "./org-admin/repository.js"

type EnsureDefaultOrgDependencies = {
  createId(): string
  findExistingOrganizationId(userId: string): Promise<string | null>
  createOrganizationAndMembership(input: {
    orgId: string
    membershipId: string
    userId: string
    name: string
    slug: string
  }): Promise<void>
  ensureAutomaticTrial(orgId: string): Promise<unknown>
}

export function createEnsureDefaultOrg(deps: EnsureDefaultOrgDependencies) {
  return async (userId: string, name: string) => {
    const existingOrganizationId = await deps.findExistingOrganizationId(userId)
    if (existingOrganizationId) {
      return existingOrganizationId
    }

    const orgId = deps.createId()
    await deps.createOrganizationAndMembership({
      orgId,
      membershipId: deps.createId(),
      userId,
      name,
      slug: `personal-${orgId.slice(0, 8)}`,
    })
    await deps.ensureAutomaticTrial(orgId)
    return orgId
  }
}

export { SignupOrganizationDomainConflictError } from "./auth/signup-organization.js"

type SignupOrganizationBootstrapInput = {
  orgId: string
  membershipId: string
  domainId: string
  userId: string
  name: string
  slug: string
  domain: string
}

type EnsureSignupOrganizationDependencies = {
  createId(): string
  findExistingOrganizationId(userId: string): Promise<string | null>
  createOrganizationMembershipDomainAndTrial(input: SignupOrganizationBootstrapInput): Promise<void>
}

export function createEnsureSignupOrganization(deps: EnsureSignupOrganizationDependencies) {
  return async (userId: string, name: string, email: string) => {
    const domain = normalizeEmailDomain(email)
    if (!domain) {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    }

    const existingOrganizationId = await deps.findExistingOrganizationId(userId)
    if (existingOrganizationId) {
      return existingOrganizationId
    }

    const orgId = deps.createId()
    await deps.createOrganizationMembershipDomainAndTrial({
      orgId,
      membershipId: deps.createId(),
      domainId: deps.createId(),
      userId,
      name,
      slug: `personal-${orgId.slice(0, 8)}`,
      domain,
    })
    return orgId
  }
}

export const automaticOrganizationTrialService = createAutomaticOrganizationTrialService({
  store: createDrizzleAutomaticOrganizationTrialStore(db),
})

async function findExistingOrganizationId(userId: string) {
  const existing = await db
    .select({ orgId: OrgMembershipTable.org_id })
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)
  return existing[0]?.orgId ?? null
}

export const ensureDefaultOrg = createEnsureDefaultOrg({
  createId: randomUUID,
  findExistingOrganizationId,
  async createOrganizationAndMembership(input) {
    await db.transaction(async (tx) => {
      await tx.insert(OrgTable).values({
        id: input.orgId,
        name: input.name,
        slug: input.slug,
        owner_user_id: input.userId,
      })
      await tx.insert(OrgMembershipTable).values({
        id: input.membershipId,
        org_id: input.orgId,
        user_id: input.userId,
        role: "organization_admin",
      })
    })
  },
  ensureAutomaticTrial(orgId) {
    return automaticOrganizationTrialService.ensureTrial(orgId)
  },
})

export const ensureSignupOrganization = createEnsureSignupOrganization({
  createId: randomUUID,
  findExistingOrganizationId,
  createOrganizationMembershipDomainAndTrial: createSignupOrganizationPersistence(db),
})

export function createSignupOrganizationPersistence(database: any) {
  return async (input: SignupOrganizationBootstrapInput) => {
    await database.transaction(async (tx: any) => {
      await tx.insert(OrgTable).values({
        id: input.orgId,
        name: input.name,
        slug: input.slug,
        owner_user_id: input.userId,
      })
      await tx.insert(OrgMembershipTable).values({
        id: input.membershipId,
        org_id: input.orgId,
        user_id: input.userId,
        role: "organization_admin",
      })
      try {
        await tx.insert(OrganizationDomainTable).values({
          id: input.domainId,
          org_id: input.orgId,
          domain: input.domain,
          enabled: true,
          self_signup_enabled: true,
        })
      } catch (error) {
        if (isMySqlDuplicateKeyError(error)) {
          throw new SignupOrganizationDomainConflictError(input.domain, { cause: error })
        }
        throw error
      }

      await createAutomaticOrganizationTrialService({
        store: createDrizzleAutomaticOrganizationTrialStore(tx),
      }).ensureTrial(input.orgId)
    }, { isolationLevel: "serializable" })
  }
}
