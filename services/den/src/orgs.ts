import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { db } from "./db/index.js"
import { OrganizationBillingAccountTable, OrgMembershipTable, OrgTable } from "./db/schema.js"

type DefaultOrganizationRecord = {
  id: string
  name: string
  slug: string
  ownerUserId: string
}

type DefaultOrganizationMembershipRecord = {
  id: string
  orgId: string
  userId: string
  role: "organization_admin"
}

type DefaultOrganizationBillingRecord = {
  id: string
  orgId: string
  mode: "manual_access"
  source: "manual_trial"
  status: "trialing"
  manualAccessEnabled: true
  manualAccessUnlimited: true
  manualAccessExpiresAt: null
}

export type DefaultOrganizationTransaction = {
  findMembershipOrgId(userId: string): Promise<string | null>
  createOrganization(record: DefaultOrganizationRecord): Promise<void>
  createMembership(record: DefaultOrganizationMembershipRecord): Promise<void>
  ensureBillingAccount(record: DefaultOrganizationBillingRecord): Promise<void>
}

export type DefaultOrganizationStore = {
  transaction<T>(callback: (transaction: DefaultOrganizationTransaction) => Promise<T>): Promise<T>
}

export async function ensureDefaultOrgWithStore(
  store: DefaultOrganizationStore,
  userId: string,
  name: string,
  createId: () => string = randomUUID,
) {
  return store.transaction(async (transaction) => {
    const existingOrgId = await transaction.findMembershipOrgId(userId)
    if (existingOrgId) {
      await transaction.ensureBillingAccount({
        id: createId(),
        orgId: existingOrgId,
        mode: "manual_access",
        source: "manual_trial",
        status: "trialing",
        manualAccessEnabled: true,
        manualAccessUnlimited: true,
        manualAccessExpiresAt: null,
      })
      return existingOrgId
    }

    const orgId = createId()
    await transaction.createOrganization({
      id: orgId,
      name,
      slug: `personal-${orgId.slice(0, 8)}`,
      ownerUserId: userId,
    })
    await transaction.createMembership({
      id: createId(),
      orgId,
      userId,
      role: "organization_admin",
    })
    await transaction.ensureBillingAccount({
      id: createId(),
      orgId,
      mode: "manual_access",
      source: "manual_trial",
      status: "trialing",
      manualAccessEnabled: true,
      manualAccessUnlimited: true,
      manualAccessExpiresAt: null,
    })
    return orgId
  })
}

export async function ensureDefaultOrg(userId: string, name: string) {
  return ensureDefaultOrgWithStore(createDrizzleDefaultOrganizationStore(db), userId, name)
}

function createDrizzleDefaultOrganizationStore(database: any): DefaultOrganizationStore {
  return {
    transaction(callback) {
      return database.transaction(async (transaction: any) => callback({
        async findMembershipOrgId(userId) {
          const rows = await transaction
            .select({ orgId: OrgMembershipTable.org_id })
            .from(OrgMembershipTable)
            .where(eq(OrgMembershipTable.user_id, userId))
            .limit(1)
          return rows[0]?.orgId ?? null
        },
        async createOrganization(record) {
          await transaction.insert(OrgTable).values({
            id: record.id,
            name: record.name,
            slug: record.slug,
            owner_user_id: record.ownerUserId,
          })
        },
        async createMembership(record) {
          await transaction.insert(OrgMembershipTable).values({
            id: record.id,
            org_id: record.orgId,
            user_id: record.userId,
            role: record.role,
          })
        },
        async ensureBillingAccount(record) {
          await transaction
            .insert(OrganizationBillingAccountTable)
            .values({
              id: record.id,
              org_id: record.orgId,
              mode: record.mode,
              source: record.source,
              status: record.status,
              manual_access_enabled: record.manualAccessEnabled,
              manual_access_unlimited: record.manualAccessUnlimited,
              manual_access_expires_at: record.manualAccessExpiresAt,
            })
            .onDuplicateKeyUpdate({
              set: { org_id: record.orgId },
            })
        },
      }))
    },
  }
}
