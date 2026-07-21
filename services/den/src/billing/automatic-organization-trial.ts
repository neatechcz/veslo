import { asc, eq, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import {
  OrganizationBillingAccountTable,
  OrganizationBillingEventTable,
  OrganizationDomainTable,
  OrganizationTrialDomainClaimTable,
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
  grantOrSyncDomainTrial(input: AutomaticOrganizationTrialGrant): Promise<{
    granted: boolean
  }>
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
    const decision = await deps.store.grantOrSyncDomainTrial({
      orgId: normalizedOrgId,
      mode: "manual_access",
      source: "manual_trial",
      status: "active",
      manualAccessEnabled: true,
      manualAccessUnlimited: true,
      manualAccessExpiresAt: expiresAt,
    })
    return { granted: decision.granted, expiresAt }
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

    async grantOrSyncDomainTrial(input) {
      try {
        return await database.transaction(async (tx: any) => {
          const organizationRows = await tx
            .select({ id: OrgTable.id })
            .from(OrgTable)
            .where(eq(OrgTable.id, input.orgId))
            .limit(1)
            .for("update")
          if (organizationRows.length === 0) {
            return { granted: false }
          }

          const domainRows = await tx
            .select({ domain: OrganizationDomainTable.domain })
            .from(OrganizationDomainTable)
            .where(eq(OrganizationDomainTable.org_id, input.orgId))
            .orderBy(asc(OrganizationDomainTable.domain))
            .for("update")
          const domains = normalizedDomains(domainRows.map((entry: { domain: string }) => entry.domain))
          if (domains.length === 0) {
            return { granted: false }
          }

          const existingAccounts = await tx
            .select({
              id: OrganizationBillingAccountTable.id,
              source: OrganizationBillingAccountTable.source,
            })
            .from(OrganizationBillingAccountTable)
            .where(eq(OrganizationBillingAccountTable.org_id, input.orgId))
            .limit(1)
            .for("update")

          const historyId = automaticTrialHistoryId(input.orgId)
          const history = await tx
            .select({ id: OrganizationBillingEventTable.id })
            .from(OrganizationBillingEventTable)
            .where(eq(OrganizationBillingEventTable.stripe_event_id, historyId))
            .limit(1)
            .for("update")

          const existingClaims = await tx
            .select({
              domain: OrganizationTrialDomainClaimTable.domain,
              orgId: OrganizationTrialDomainClaimTable.org_id,
            })
            .from(OrganizationTrialDomainClaimTable)
            .where(inArray(OrganizationTrialDomainClaimTable.domain, domains))
            .for("update")
          const claimsByDomain = new Map<string, string>(existingClaims.map((entry: {
            domain: string
            orgId: string
          }) => [normalizeDomain(entry.domain), entry.orgId]))
          const hasForeignClaim = domains.some((domain) => {
            const claimedBy = claimsByDomain.get(domain)
            return claimedBy !== undefined && claimedBy !== input.orgId
          })
          const hasExistingTrial = existingAccounts[0]?.source === "manual_trial" || history.length > 0
          const claimedAt = new Date(
            input.manualAccessExpiresAt.getTime() - AUTOMATIC_ORGANIZATION_TRIAL_DAYS * DAY_MS,
          )

          if (hasExistingTrial) {
            if (hasForeignClaim) {
              return { granted: false }
            }

            const missingDomains = domains.filter((domain) => !claimsByDomain.has(domain))
            if (missingDomains.length > 0) {
              await insertDomainClaims(tx, input.orgId, missingDomains, claimedAt)
            }
            return { granted: false }
          }

          if (existingAccounts.length > 0 || existingClaims.length > 0) {
            return { granted: false }
          }

          await insertDomainClaims(tx, input.orgId, domains, claimedAt)
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
            created_at: claimedAt,
            updated_at: claimedAt,
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
            created_at: claimedAt,
            processed_at: claimedAt,
          })
          return { granted: true }
        }, { isolationLevel: "serializable" })
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return { granted: false }
        }
        throw error
      }
    },
  }
}

async function insertDomainClaims(tx: any, orgId: string, domains: string[], claimedAt: Date) {
  await tx.insert(OrganizationTrialDomainClaimTable).values(domains.map((domain) => ({
    id: `trial_domain_claim_${randomUUID()}`,
    domain,
    org_id: orgId,
    claimed_at: claimedAt,
  })))
}

function normalizedDomains(domains: string[]) {
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))].sort()
}

function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase()
}

function automaticTrialHistoryId(orgId: string) {
  return `${AUTOMATIC_TRIAL_EVENT_PREFIX}${orgId}`
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as {
    code?: unknown
    errno?: unknown
    sqlState?: unknown
    message?: unknown
    cause?: unknown
  }
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : ""

  return candidate.code === "ER_DUP_ENTRY" ||
    candidate.errno === 1062 ||
    (candidate.sqlState === "23000" && message.includes("duplicate")) ||
    isDuplicateKeyError(candidate.cause)
}
