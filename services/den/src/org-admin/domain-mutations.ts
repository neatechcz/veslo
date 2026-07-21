import { and, eq } from "drizzle-orm"

import {
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
  type AutomaticOrganizationTrialStore,
} from "../billing/automatic-organization-trial.js"
import { isMySqlDuplicateKeyError } from "../db/mysql-errors.js"
import { OrganizationDomainTable, OrgTable } from "../db/schema.js"
import {
  createDrizzleOrganizationDomainMemberReader,
  createOrganizationDomainVerifier,
  type OrganizationDomainMemberReader,
} from "./domain-verification.js"

export type OrganizationDomainMutationRecord = {
  id: string
  orgId: string
  domain: string
  enabled: boolean
  selfSignupEnabled: boolean
  createdAt?: Date | string
  updatedAt?: Date | string
}

export type OrganizationDomainMutationUpdate = {
  domain?: string
  enabled?: boolean
  selfSignupEnabled?: boolean
}

export type OrganizationDomainMutationScope = {
  lockOrganization(orgId: string): Promise<void>
  findById(orgId: string, domainId: string): Promise<OrganizationDomainMutationRecord | null>
  requireVerifiedMember(orgId: string, domain: string): Promise<{ userId: string }>
  insert(record: OrganizationDomainMutationRecord): Promise<void>
  update(orgId: string, domainId: string, update: OrganizationDomainMutationUpdate): Promise<void>
  synchronizeTrial(orgId: string): Promise<void>
}

export type OrganizationDomainMutationStore = {
  findById(orgId: string, domainId: string): Promise<OrganizationDomainMutationRecord | null>
  findByDomain(domain: string): Promise<OrganizationDomainMutationRecord | null>
  transaction<T>(run: (scope: OrganizationDomainMutationScope) => Promise<T>): Promise<T>
}

export class OrganizationDomainExistsError extends Error {
  readonly code = "domain_exists"

  constructor() {
    super("domain_exists")
    this.name = "OrganizationDomainExistsError"
  }
}

export class OrganizationDomainNotFoundError extends Error {
  readonly code = "domain_not_found"

  constructor() {
    super("domain_not_found")
    this.name = "OrganizationDomainNotFoundError"
  }
}

export function createOrganizationDomainMutationService(input: {
  store: OrganizationDomainMutationStore
}) {
  return {
    async create(record: OrganizationDomainMutationRecord) {
      if (await input.store.findByDomain(record.domain)) {
        throw new OrganizationDomainExistsError()
      }

      return input.store.transaction(async (scope) => {
        await scope.lockOrganization(record.orgId)
        const evidence = await scope.requireVerifiedMember(record.orgId, record.domain)
        await scope.insert(record)
        await scope.synchronizeTrial(record.orgId)
        const persisted = await scope.findById(record.orgId, record.id)

        return {
          domain: persisted ?? record,
          verifiedMemberUserId: evidence.userId,
          changedFields: ["domain", "enabled", "selfSignupEnabled"],
        }
      })
    },

    async update(inputUpdate: {
      orgId: string
      domainId: string
      domain?: string
      enabled?: boolean
      selfSignupEnabled?: boolean
    }) {
      const preflightExisting = await input.store.findById(inputUpdate.orgId, inputUpdate.domainId)
      if (!preflightExisting) {
        throw new OrganizationDomainNotFoundError()
      }
      const preflightDomainChanged = inputUpdate.domain !== undefined
        && inputUpdate.domain !== preflightExisting.domain
      if (preflightDomainChanged && await input.store.findByDomain(inputUpdate.domain!)) {
        throw new OrganizationDomainExistsError()
      }

      return input.store.transaction(async (scope) => {
        await scope.lockOrganization(inputUpdate.orgId)
        const existing = await scope.findById(inputUpdate.orgId, inputUpdate.domainId)
        if (!existing) {
          throw new OrganizationDomainNotFoundError()
        }

        const domainChanged = inputUpdate.domain !== undefined && inputUpdate.domain !== existing.domain
        let verifiedMemberUserId: string | null = null
        if (domainChanged) {
          const evidence = await scope.requireVerifiedMember(inputUpdate.orgId, inputUpdate.domain!)
          verifiedMemberUserId = evidence.userId
        }

        const update: OrganizationDomainMutationUpdate = {}
        if (domainChanged) update.domain = inputUpdate.domain
        if (inputUpdate.enabled !== undefined && inputUpdate.enabled !== existing.enabled) {
          update.enabled = inputUpdate.enabled
        }
        if (
          inputUpdate.selfSignupEnabled !== undefined
          && inputUpdate.selfSignupEnabled !== existing.selfSignupEnabled
        ) {
          update.selfSignupEnabled = inputUpdate.selfSignupEnabled
        }
        const changedFields = Object.keys(update)
        if (changedFields.length > 0) {
          await scope.update(inputUpdate.orgId, inputUpdate.domainId, update)
        }
        if (domainChanged) {
          await scope.synchronizeTrial(inputUpdate.orgId)
        }

        const persisted = await scope.findById(inputUpdate.orgId, inputUpdate.domainId)
        if (!persisted) {
          throw new OrganizationDomainNotFoundError()
        }
        return { domain: persisted, verifiedMemberUserId, changedFields }
      })
    },
  }
}

export type OrganizationDomainMutationService = ReturnType<typeof createOrganizationDomainMutationService>

type DrizzleOrganizationDomainMutationStoreFactories = {
  createMemberReader?: (transaction: any) => OrganizationDomainMemberReader
  createAutomaticTrialStore?: (transaction: any) => AutomaticOrganizationTrialStore
}

export function createDrizzleOrganizationDomainMutationStore(
  database: any,
  factories: DrizzleOrganizationDomainMutationStoreFactories = {},
): OrganizationDomainMutationStore {
  const createMemberReader = factories.createMemberReader ?? createDrizzleOrganizationDomainMemberReader
  const createAutomaticTrialStore = factories.createAutomaticTrialStore
    ?? createDrizzleAutomaticOrganizationTrialStore

  return {
    findById(orgId, domainId) {
      return findDomainById(database, orgId, domainId)
    },
    findByDomain(domain) {
      return findDomainByName(database, domain)
    },
    async transaction<T>(run: (scope: OrganizationDomainMutationScope) => Promise<T>) {
      try {
        return await database.transaction(async (tx: any) => {
          const verifier = createOrganizationDomainVerifier(
            createMemberReader(tx),
          )
          const scope: OrganizationDomainMutationScope = {
            async lockOrganization(orgId) {
              await tx
                .select({ id: OrgTable.id })
                .from(OrgTable)
                .where(eq(OrgTable.id, orgId))
                .for("update")
                .limit(1)
            },
            findById(orgId, domainId) {
              return findDomainById(tx, orgId, domainId)
            },
            requireVerifiedMember(orgId, domain) {
              return verifier.requireVerifiedMember(orgId, domain)
            },
            async insert(record) {
              await tx.insert(OrganizationDomainTable).values({
                id: record.id,
                org_id: record.orgId,
                domain: record.domain,
                enabled: record.enabled,
                self_signup_enabled: record.selfSignupEnabled,
              })
            },
            async update(orgId, domainId, update) {
              await tx
                .update(OrganizationDomainTable)
                .set({
                  ...(update.domain !== undefined ? { domain: update.domain } : {}),
                  ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
                  ...(update.selfSignupEnabled !== undefined
                    ? { self_signup_enabled: update.selfSignupEnabled }
                    : {}),
                })
                .where(and(
                  eq(OrganizationDomainTable.org_id, orgId),
                  eq(OrganizationDomainTable.id, domainId),
                ))
            },
            async synchronizeTrial(orgId) {
              await createAutomaticOrganizationTrialService({
                store: createAutomaticTrialStore(tx),
              }).ensureTrial(orgId)
            },
          }
          return run(scope)
        }, { isolationLevel: "serializable" })
      } catch (error) {
        if (isMySqlDuplicateKeyError(error)) {
          throw new OrganizationDomainExistsError()
        }
        throw error
      }
    },
  }
}

async function findDomainById(database: any, orgId: string, domainId: string) {
  const rows = await database
    .select()
    .from(OrganizationDomainTable)
    .where(and(
      eq(OrganizationDomainTable.org_id, orgId),
      eq(OrganizationDomainTable.id, domainId),
    ))
    .limit(1)
  return rows[0] ? mapDomainRow(rows[0]) : null
}

async function findDomainByName(database: any, domain: string) {
  const rows = await database
    .select()
    .from(OrganizationDomainTable)
    .where(eq(OrganizationDomainTable.domain, domain))
    .limit(1)
  return rows[0] ? mapDomainRow(rows[0]) : null
}

function mapDomainRow(row: typeof OrganizationDomainTable.$inferSelect): OrganizationDomainMutationRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    enabled: row.enabled,
    selfSignupEnabled: row.self_signup_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
