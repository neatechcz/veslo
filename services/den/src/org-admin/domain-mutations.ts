import { and, eq } from "drizzle-orm"

import {
  createAutomaticOrganizationTrialService,
  createDrizzleAutomaticOrganizationTrialStore,
  type AutomaticOrganizationTrialStore,
} from "../billing/automatic-organization-trial.js"
import { isMySqlDuplicateKeyError } from "../db/mysql-errors.js"
import { OrganizationDomainTable } from "../db/schema.js"
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
  findById(orgId: string, domainId: string): Promise<OrganizationDomainMutationRecord | null>
  findByDomain(domain: string): Promise<OrganizationDomainMutationRecord | null>
  requireVerifiedMember(orgId: string, domain: string): Promise<{ userId: string }>
  insert(record: OrganizationDomainMutationRecord): Promise<void>
  update(orgId: string, domainId: string, update: OrganizationDomainMutationUpdate): Promise<void>
  synchronizeTrial(orgId: string): Promise<void>
}

export type OrganizationDomainMutationStore = {
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
      return input.store.transaction(async (scope) => {
        if (await scope.findByDomain(record.domain)) {
          throw new OrganizationDomainExistsError()
        }

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
      return input.store.transaction(async (scope) => {
        const existing = await scope.findById(inputUpdate.orgId, inputUpdate.domainId)
        if (!existing) {
          throw new OrganizationDomainNotFoundError()
        }

        const domainChanged = inputUpdate.domain !== undefined && inputUpdate.domain !== existing.domain
        let verifiedMemberUserId: string | null = null
        if (domainChanged) {
          if (await scope.findByDomain(inputUpdate.domain!)) {
            throw new OrganizationDomainExistsError()
          }
          const evidence = await scope.requireVerifiedMember(inputUpdate.orgId, inputUpdate.domain!)
          verifiedMemberUserId = evidence.userId
        }

        const update: OrganizationDomainMutationUpdate = {}
        if (domainChanged) update.domain = inputUpdate.domain
        if (inputUpdate.enabled !== undefined) update.enabled = inputUpdate.enabled
        if (inputUpdate.selfSignupEnabled !== undefined) {
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
    async transaction<T>(run: (scope: OrganizationDomainMutationScope) => Promise<T>) {
      try {
        return await database.transaction(async (tx: any) => {
          const verifier = createOrganizationDomainVerifier(
            createMemberReader(tx),
          )
          const scope: OrganizationDomainMutationScope = {
            async findById(orgId, domainId) {
              const rows = await tx
                .select()
                .from(OrganizationDomainTable)
                .where(and(
                  eq(OrganizationDomainTable.org_id, orgId),
                  eq(OrganizationDomainTable.id, domainId),
                ))
                .limit(1)
              return rows[0] ? mapDomainRow(rows[0]) : null
            },
            async findByDomain(domain) {
              const rows = await tx
                .select()
                .from(OrganizationDomainTable)
                .where(eq(OrganizationDomainTable.domain, domain))
                .limit(1)
              return rows[0] ? mapDomainRow(rows[0]) : null
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
