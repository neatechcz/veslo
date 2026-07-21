import { asc, eq, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { isMySqlDuplicateKeyError } from "../db/mysql-errors.js"
import {
  OrganizationBillingAccountTable,
  OrganizationDomainTable,
  OrganizationTrialDomainClaimTable,
  OrgTable,
} from "../db/schema.js"
import {
  createDrizzleOrganizationBillingStore,
  createOrganizationBillingRepository,
  type OrganizationBillingAccountRecord,
  type UpsertOrganizationBillingAccountInput,
} from "./repository.js"

export type ManualTrialBillingWriter = (
  input: UpsertOrganizationBillingAccountInput,
) => Promise<OrganizationBillingAccountRecord>

export function createDrizzleManualTrialBillingWriter(
  database: any,
  options: { now?: () => Date } = {},
): ManualTrialBillingWriter {
  const now = options.now ?? (() => new Date())

  return async (input) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.transaction(async (transaction: any) => {
          const organizations = await transaction
            .select({ id: OrgTable.id })
            .from(OrgTable)
            .where(eq(OrgTable.id, input.orgId))
            .limit(1)
            .for("update")
          if (organizations.length === 0) {
            throw new Error("organization_not_found")
          }

          const domainRows = await transaction
            .select({ domain: OrganizationDomainTable.domain })
            .from(OrganizationDomainTable)
            .where(eq(OrganizationDomainTable.org_id, input.orgId))
            .orderBy(asc(OrganizationDomainTable.domain))
            .for("update")
          const domains = normalizedDomains(domainRows.map((entry: { domain: string }) => entry.domain))

          await transaction
            .select({ id: OrganizationBillingAccountTable.id })
            .from(OrganizationBillingAccountTable)
            .where(eq(OrganizationBillingAccountTable.org_id, input.orgId))
            .limit(1)
            .for("update")

          if (domains.length > 0) {
            const existingClaims = await transaction
              .select({ domain: OrganizationTrialDomainClaimTable.domain })
              .from(OrganizationTrialDomainClaimTable)
              .where(inArray(OrganizationTrialDomainClaimTable.domain, domains))
              .for("update")
            const claimedDomains = new Set(existingClaims.map((entry: { domain: string }) => normalizeDomain(entry.domain)))
            const missingDomains = domains.filter((domain) => !claimedDomains.has(domain))

            if (missingDomains.length > 0) {
              const claimedAt = now()
              await transaction.insert(OrganizationTrialDomainClaimTable).values(missingDomains.map((domain) => ({
                id: `trial_domain_claim_${randomUUID()}`,
                domain,
                org_id: input.orgId,
                claimed_at: claimedAt,
              })))
            }
          }

          const repository = createOrganizationBillingRepository(
            createDrizzleOrganizationBillingStore(transaction),
            { now },
          )
          return repository.upsertBillingAccount(input)
        }, { isolationLevel: "serializable" })
      } catch (error) {
        if (isMySqlDuplicateKeyError(error) && attempt < 2) {
          continue
        }
        throw error
      }
    }

    throw new Error("manual_trial_domain_claim_retry_exhausted")
  }
}

function normalizedDomains(domains: string[]) {
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))].sort()
}

function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase()
}
