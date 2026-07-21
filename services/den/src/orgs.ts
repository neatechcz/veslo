import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import {
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
} from "./billing/automatic-organization-trial.js"
import { db } from "./db/index.js"
import { OrgMembershipTable, OrgTable } from "./db/schema.js"

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

export const automaticOrganizationTrialService = createAutomaticOrganizationTrialService({
  store: createDrizzleAutomaticOrganizationTrialStore(db),
})

export const ensureDefaultOrg = createEnsureDefaultOrg({
  createId: randomUUID,
  async findExistingOrganizationId(userId) {
    const existing = await db
      .select({ orgId: OrgMembershipTable.org_id })
      .from(OrgMembershipTable)
      .where(eq(OrgMembershipTable.user_id, userId))
      .limit(1)
    return existing[0]?.orgId ?? null
  },
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
