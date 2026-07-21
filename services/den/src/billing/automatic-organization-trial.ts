import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import {
  OrganizationBillingAccountTable,
  OrganizationBillingEventTable,
  OrgTable,
} from "../db/schema.js"

export const AUTOMATIC_ORGANIZATION_TRIAL_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1_000
const AUTOMATIC_TRIAL_EVENT_PREFIX = "automatic_organization_trial:"

export type AutomaticOrganizationTrialGrant = {
  orgId: string
  mode: "manual_access"
  source: "manual_trial"
  status: "active"
  manualAccessEnabled: true
  manualAccessUnlimited: true
  manualAccessExpiresAt: Date
}

export type AutomaticOrganizationTrialStore = {
  listOrganizationIds(): Promise<string[]>
  grantTrialIfUnconfigured(input: AutomaticOrganizationTrialGrant): Promise<boolean>
}

export function createAutomaticOrganizationTrialService(deps: {
  store: AutomaticOrganizationTrialStore
  now?: () => Date
}) {
  const now = deps.now ?? (() => new Date())

  async function ensureTrial(orgId: string) {
    const normalizedOrgId = orgId.trim()
    if (!normalizedOrgId) {
      throw new Error("automatic_organization_trial_org_id_required")
    }

    const expiresAt = new Date(now().getTime() + AUTOMATIC_ORGANIZATION_TRIAL_DAYS * DAY_MS)
    const granted = await deps.store.grantTrialIfUnconfigured({
      orgId: normalizedOrgId,
      mode: "manual_access",
      source: "manual_trial",
      status: "active",
      manualAccessEnabled: true,
      manualAccessUnlimited: true,
      manualAccessExpiresAt: expiresAt,
    })
    return { granted, expiresAt }
  }

  return {
    ensureTrial,
    async reconcile() {
      const organizationIds = await deps.store.listOrganizationIds()
      let granted = 0
      for (const orgId of organizationIds) {
        if ((await ensureTrial(orgId)).granted) {
          granted += 1
        }
      }
      return { scanned: organizationIds.length, granted }
    },
  }
}

export function createDrizzleAutomaticOrganizationTrialStore(
  database: any,
): AutomaticOrganizationTrialStore {
  return {
    async listOrganizationIds() {
      const rows = await database.select({ id: OrgTable.id }).from(OrgTable)
      return rows.map((entry: { id: string }) => entry.id)
    },

    async grantTrialIfUnconfigured(input) {
      return database.transaction(async (tx: any) => {
        const organizationRows = await tx
          .select({ id: OrgTable.id })
          .from(OrgTable)
          .where(eq(OrgTable.id, input.orgId))
          .limit(1)
          .for("update")
        if (organizationRows.length === 0) {
          return false
        }

        const existingAccounts = await tx
          .select({ id: OrganizationBillingAccountTable.id })
          .from(OrganizationBillingAccountTable)
          .where(eq(OrganizationBillingAccountTable.org_id, input.orgId))
          .limit(1)
          .for("update")
        if (existingAccounts.length > 0) {
          return false
        }

        const historyId = automaticTrialHistoryId(input.orgId)
        const history = await tx
          .select({ id: OrganizationBillingEventTable.id })
          .from(OrganizationBillingEventTable)
          .where(eq(OrganizationBillingEventTable.stripe_event_id, historyId))
          .limit(1)
        if (history.length > 0) {
          return false
        }

        const createdAt = new Date(input.manualAccessExpiresAt.getTime() - AUTOMATIC_ORGANIZATION_TRIAL_DAYS * DAY_MS)
        await tx.insert(OrganizationBillingAccountTable).values({
          id: `billing_${randomUUID()}`,
          org_id: input.orgId,
          mode: input.mode,
          source: input.source,
          status: input.status,
          managed_ai_basic_quantity: 0,
          managed_ai_extended_quantity: 0,
          local_models_quantity: 0,
          manual_access_enabled: input.manualAccessEnabled,
          manual_access_unlimited: input.manualAccessUnlimited,
          manual_access_expires_at: input.manualAccessExpiresAt,
          created_at: createdAt,
          updated_at: createdAt,
        })
        await tx.insert(OrganizationBillingEventTable).values({
          id: `billing_event_${randomUUID()}`,
          org_id: input.orgId,
          stripe_event_id: historyId,
          stripe_event_type: "automatic_organization_trial.granted",
          status: "applied",
          payload: {
            source: "automatic_organization_trial",
            durationDays: AUTOMATIC_ORGANIZATION_TRIAL_DAYS,
          },
          created_at: createdAt,
          processed_at: createdAt,
        })
        return true
      }, { isolationLevel: "serializable" })
    },
  }
}

function automaticTrialHistoryId(orgId: string) {
  return `${AUTOMATIC_TRIAL_EVENT_PREFIX}${orgId}`
}
