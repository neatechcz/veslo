import { randomUUID } from "node:crypto"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import {
  AdminUserStateTable,
  OrgMembershipTable,
  OrganizationBillingAccountTable,
  OrganizationBillingEventStatus as OrganizationBillingEventStatusValues,
  OrganizationBillingEventTable,
  OrganizationBillingSource as OrganizationBillingSourceValues,
  OrganizationBillingTierAllowlistTable,
} from "../db/schema.js"
import {
  deriveOrganizationBillingEntitlement,
  validateRequestedLicenseLimit,
  type OrganizationBillingEntitlement,
  type OrganizationBillingMode,
  type OrganizationBillingQuantities,
  type OrganizationBillingStatus,
} from "./organization-billing.js"

export type OrganizationBillingSource = (typeof OrganizationBillingSourceValues)[number]
export type OrganizationBillingEventStatus = (typeof OrganizationBillingEventStatusValues)[number]

export type OrganizationBillingRepositoryErrorCode = "requested_license_limit_below_active_users" | "invalid_tier_allowlist"

export class OrganizationBillingRepositoryError extends Error {
  constructor(
    readonly code: OrganizationBillingRepositoryErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = "OrganizationBillingRepositoryError"
  }
}

export type OrganizationBillingAccountRecord = {
  id: string
  orgId: string
  mode: OrganizationBillingMode
  source: OrganizationBillingSource | null
  status: OrganizationBillingStatus
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  billingInterval: string | null
  managedAiBasicQuantity: number
  managedAiExtendedQuantity: number
  localModelsQuantity: number
  manualAccessEnabled: boolean
  manualAccessUnlimited?: boolean
  manualAccessExpiresAt: Date | null
  localModelsUnitAmount: number | null
  localModelsCurrency: string | null
  paymentProblemCode: string | null
  paymentProblemMessage: string | null
  graceUntil: Date | null
  cancelAtPeriodEnd: boolean
  createdAt: Date
  updatedAt: Date
}

export type UpsertOrganizationBillingAccountInput = {
  id?: string
  orgId: string
  mode?: OrganizationBillingMode
  source?: OrganizationBillingSource | null
  status?: OrganizationBillingStatus
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  billingInterval?: string | null
  managedAiBasicQuantity?: number
  managedAiExtendedQuantity?: number
  localModelsQuantity?: number
  manualAccessEnabled?: boolean
  manualAccessUnlimited?: boolean
  manualAccessExpiresAt?: Date | null
  localModelsUnitAmount?: number | null
  localModelsCurrency?: string | null
  paymentProblemCode?: string | null
  paymentProblemMessage?: string | null
  graceUntil?: Date | null
  cancelAtPeriodEnd?: boolean
}

export type OrganizationBillingTierAllowlistRecord = {
  id: string
  orgId: string
  tier: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

export type OrganizationBillingTierAllowlistInput = {
  tier: string
  enabled: boolean
}

export type OrganizationBillingEventRecord = {
  id: string
  orgId: string
  stripeEventId: string | null
  stripeEventType: string | null
  status: OrganizationBillingEventStatus
  payload: unknown
  errorMessage: string | null
  createdAt: Date
  processedAt: Date | null
}

export type RecordOrganizationBillingEventInput = {
  id?: string
  orgId: string
  stripeEventId?: string | null
  stripeEventType?: string | null
  status: OrganizationBillingEventStatus
  payload: unknown
  errorMessage?: string | null
  createdAt?: Date
  processedAt?: Date | null
}

export type UpdateOrganizationBillingEventInput = {
  id: string
  status: OrganizationBillingEventStatus
  errorMessage?: string | null
  processedAt?: Date | null
}

export type AssertRequestedQuantitiesCanCoverActiveUsersInput = {
  orgId: string
  mode: OrganizationBillingMode
  quantities?: Partial<OrganizationBillingQuantities>
  manualAccess?: { enabled: boolean; licenseLimit: number } | null
}

export type OrganizationBillingDataStore = {
  getBillingAccount(orgId: string): Promise<OrganizationBillingAccountRecord | null>
  findBillingAccountByStripeSubscriptionId?(
    stripeSubscriptionId: string,
  ): Promise<OrganizationBillingAccountRecord | null>
  findBillingAccountByStripeCustomerId?(stripeCustomerId: string): Promise<OrganizationBillingAccountRecord | null>
  upsertBillingAccount(record: OrganizationBillingAccountRecord): Promise<OrganizationBillingAccountRecord>
  listAllowedTiers(orgId: string): Promise<OrganizationBillingTierAllowlistRecord[]>
  setAllowedTiers(
    orgId: string,
    tiers: OrganizationBillingTierAllowlistInput[],
  ): Promise<OrganizationBillingTierAllowlistRecord[]>
  countActiveUsers(orgId: string): Promise<number>
  recordBillingEvent(record: OrganizationBillingEventRecord): Promise<OrganizationBillingEventRecord>
  updateBillingEvent?(input: UpdateOrganizationBillingEventInput): Promise<OrganizationBillingEventRecord | null>
  getBillingEventByStripeEventId?(stripeEventId: string): Promise<OrganizationBillingEventRecord | null>
}

export type OrganizationBillingRepository = {
  getBillingAccount(orgId: string): Promise<OrganizationBillingAccountRecord | null>
  findBillingAccountByStripeSubscriptionId(stripeSubscriptionId: string): Promise<OrganizationBillingAccountRecord | null>
  findBillingAccountByStripeCustomerId(stripeCustomerId: string): Promise<OrganizationBillingAccountRecord | null>
  upsertBillingAccount(input: UpsertOrganizationBillingAccountInput): Promise<OrganizationBillingAccountRecord>
  listAllowedTiers(orgId: string): Promise<OrganizationBillingTierAllowlistRecord[]>
  setAllowedTiers(
    orgId: string,
    tiers: OrganizationBillingTierAllowlistInput[],
  ): Promise<OrganizationBillingTierAllowlistRecord[]>
  countActiveUsers(orgId: string): Promise<number>
  deriveEntitlement(orgId: string): Promise<OrganizationBillingEntitlement>
  assertRequestedQuantitiesCanCoverActiveUsers(
    input: AssertRequestedQuantitiesCanCoverActiveUsersInput,
  ): Promise<void>
  recordBillingEvent(input: RecordOrganizationBillingEventInput): Promise<OrganizationBillingEventRecord>
  updateBillingEvent(input: UpdateOrganizationBillingEventInput): Promise<OrganizationBillingEventRecord | null>
}

type RepositoryOptions = {
  createId?: (prefix: string) => string
  now?: () => Date
}

export function createOrganizationBillingRepository(
  store: OrganizationBillingDataStore,
  options: RepositoryOptions = {},
): OrganizationBillingRepository {
  const createId = options.createId ?? ((prefix: string) => `${prefix}_${randomUUID()}`)
  const now = options.now ?? (() => new Date())

  return {
    getBillingAccount(orgId) {
      return store.getBillingAccount(orgId)
    },

    async findBillingAccountByStripeSubscriptionId(stripeSubscriptionId) {
      return store.findBillingAccountByStripeSubscriptionId?.(stripeSubscriptionId) ?? null
    },

    async findBillingAccountByStripeCustomerId(stripeCustomerId) {
      return store.findBillingAccountByStripeCustomerId?.(stripeCustomerId) ?? null
    },

    async upsertBillingAccount(input) {
      const existing = await store.getBillingAccount(input.orgId)
      const record = buildBillingAccountRecord(input, existing, createId, now)

      try {
        return await store.upsertBillingAccount(record)
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error
        }

        const racedExisting = await store.getBillingAccount(input.orgId)
        if (!racedExisting) {
          throw error
        }

        return store.upsertBillingAccount(buildBillingAccountRecord(input, racedExisting, createId, now))
      }
    },

    listAllowedTiers(orgId) {
      return store.listAllowedTiers(orgId)
    },

    async setAllowedTiers(orgId, tiers) {
      return store.setAllowedTiers(orgId, normalizeTierAllowlistInputs(tiers))
    },

    countActiveUsers(orgId) {
      return store.countActiveUsers(orgId)
    },

    async deriveEntitlement(orgId) {
      const account = await store.getBillingAccount(orgId)
      const [activeUserCount, allowedTiers] = await Promise.all([
        store.countActiveUsers(orgId),
        store.listAllowedTiers(orgId),
      ])
      const resolveNow = now()

      return deriveOrganizationBillingEntitlement({
        mode: account?.mode ?? "none",
        status: account?.status ?? "none",
        grace: Boolean(account?.graceUntil && account.graceUntil > resolveNow),
        manualAccess: account?.mode === "manual_access" &&
            account.manualAccessEnabled &&
            (!account.manualAccessExpiresAt || account.manualAccessExpiresAt > resolveNow)
          ? {
            enabled: true,
            allowManagedAi: true,
            licenseLimit: manualAccessLicenseLimit(account),
          }
          : null,
        quantities: {
          managedAiBasic: account?.managedAiBasicQuantity ?? 0,
          managedAiExtended: account?.managedAiExtendedQuantity ?? 0,
          localModels: account?.localModelsQuantity ?? 0,
        },
        activeUserCount,
        policy: {
          allowByokWithoutPaidAccess: false,
          organizationAccessEnabled: true,
          tierAllowed: account ? isTierAllowed(account, allowedTiers) : false,
        },
      })
    },

    async assertRequestedQuantitiesCanCoverActiveUsers(input) {
      const activeUserCount = await store.countActiveUsers(input.orgId)
      const requestedLicenseLimit = requestedLicenseLimitFor(input)
      const validation = validateRequestedLicenseLimit({ requestedLicenseLimit, activeUserCount })

      if (!validation.ok) {
        throw new OrganizationBillingRepositoryError(validation.error.code, {
          requestedLicenseLimit: validation.error.requestedLicenseLimit,
          activeUserCount: validation.error.activeUserCount,
        })
      }
    },

    async recordBillingEvent(input) {
      const createdAt = input.createdAt ?? now()
      const record: OrganizationBillingEventRecord = {
        id: input.id ?? createId("billing_event"),
        orgId: input.orgId,
        stripeEventId: input.stripeEventId ?? null,
        stripeEventType: input.stripeEventType ?? null,
        status: input.status,
        payload: input.payload,
        errorMessage: input.errorMessage ?? null,
        createdAt,
        processedAt: input.processedAt ?? null,
      }

      try {
        return await store.recordBillingEvent(record)
      } catch (error) {
        return handleDuplicateBillingEventInsert(store, record, error)
      }
    },

    async updateBillingEvent(input) {
      if (!store.updateBillingEvent) {
        throw new Error("organization billing store does not support billing event updates")
      }
      return store.updateBillingEvent({
        id: input.id,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        processedAt: input.processedAt ?? now(),
      })
    },
  }
}

export function createDrizzleOrganizationBillingStore(database: any): OrganizationBillingDataStore {
  return {
    async getBillingAccount(orgId) {
      const rows = await database
        .select()
        .from(OrganizationBillingAccountTable)
        .where(eq(OrganizationBillingAccountTable.org_id, orgId))
        .limit(1)

      return rows[0] ? mapBillingAccountRow(rows[0]) : null
    },

    async findBillingAccountByStripeSubscriptionId(stripeSubscriptionId) {
      const rows = await database
        .select()
        .from(OrganizationBillingAccountTable)
        .where(eq(OrganizationBillingAccountTable.stripe_subscription_id, stripeSubscriptionId))
        .limit(1)

      return rows[0] ? mapBillingAccountRow(rows[0]) : null
    },

    async findBillingAccountByStripeCustomerId(stripeCustomerId) {
      const rows = await database
        .select()
        .from(OrganizationBillingAccountTable)
        .where(eq(OrganizationBillingAccountTable.stripe_customer_id, stripeCustomerId))
        .limit(1)

      return rows[0] ? mapBillingAccountRow(rows[0]) : null
    },

    async upsertBillingAccount(record) {
      const existing = await this.getBillingAccount(record.orgId)
      if (existing) {
        const updateRecord = { ...record, id: existing.id, createdAt: existing.createdAt }
        await database
          .update(OrganizationBillingAccountTable)
          .set(billingAccountRowValues(updateRecord))
          .where(eq(OrganizationBillingAccountTable.id, existing.id))
      } else {
        try {
          await database.insert(OrganizationBillingAccountTable).values(billingAccountRowValues(record))
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error
          }

          const racedExisting = await this.getBillingAccount(record.orgId)
          if (!racedExisting) {
            throw error
          }

          const updateRecord = { ...record, id: racedExisting.id, createdAt: racedExisting.createdAt }
          await database
            .update(OrganizationBillingAccountTable)
            .set(billingAccountRowValues(updateRecord))
            .where(eq(OrganizationBillingAccountTable.id, racedExisting.id))
        }
      }

      return (await this.getBillingAccount(record.orgId)) ?? record
    },

    async listAllowedTiers(orgId) {
      const rows = await database
        .select()
        .from(OrganizationBillingTierAllowlistTable)
        .where(eq(OrganizationBillingTierAllowlistTable.org_id, orgId))

      return rows.map(mapTierAllowlistRow)
    },

    async setAllowedTiers(orgId, tiers) {
      const normalizedTiers = normalizeTierAllowlistInputs(tiers)
      const replaceAllowedTiers = async (activeDatabase: typeof database) => {
        const updatedAt = new Date()
        await activeDatabase
          .delete(OrganizationBillingTierAllowlistTable)
          .where(eq(OrganizationBillingTierAllowlistTable.org_id, orgId))

        if (normalizedTiers.length > 0) {
          await activeDatabase.insert(OrganizationBillingTierAllowlistTable).values(
            normalizedTiers.map((entry) => ({
              id: `tier_${randomUUID()}`,
              org_id: orgId,
              tier: entry.tier,
              enabled: entry.enabled,
              created_at: updatedAt,
              updated_at: updatedAt,
            })),
          )
        }

        const rows = await activeDatabase
          .select()
          .from(OrganizationBillingTierAllowlistTable)
          .where(eq(OrganizationBillingTierAllowlistTable.org_id, orgId))

        return rows.map(mapTierAllowlistRow)
      }

      if (typeof database.transaction === "function") {
        return database.transaction((transaction: typeof database) => replaceAllowedTiers(transaction))
      }

      return replaceAllowedTiers(database)
    },

    async countActiveUsers(orgId) {
      const rows = await database
        .select({ activeUsers: sql<number>`count(*)` })
        .from(OrgMembershipTable)
        .leftJoin(AdminUserStateTable, eq(AdminUserStateTable.user_id, OrgMembershipTable.user_id))
        .where(and(
          eq(OrgMembershipTable.org_id, orgId),
          eq(OrgMembershipTable.status, "active"),
          or(isNull(AdminUserStateTable.disabled), eq(AdminUserStateTable.disabled, false)),
        ))

      return Number(rows[0]?.activeUsers ?? 0)
    },

    async getBillingEventByStripeEventId(stripeEventId) {
      const rows = await database
        .select()
        .from(OrganizationBillingEventTable)
        .where(eq(OrganizationBillingEventTable.stripe_event_id, stripeEventId))
        .limit(1)

      return rows[0] ? mapBillingEventRow(rows[0]) : null
    },

    async recordBillingEvent(record) {
      if (record.stripeEventId) {
        const existing = await this.getBillingEventByStripeEventId!(record.stripeEventId)
        if (existing) {
          return existing
        }
      }

      try {
        await database.insert(OrganizationBillingEventTable).values({
          id: record.id,
          org_id: record.orgId,
          stripe_event_id: record.stripeEventId,
          stripe_event_type: record.stripeEventType,
          status: record.status,
          payload: record.payload,
          error_message: record.errorMessage,
          created_at: record.createdAt,
          processed_at: record.processedAt,
        })
      } catch (error) {
        return handleDuplicateBillingEventInsert(this, record, error)
      }

      return record
    },

    async updateBillingEvent(input) {
      await database
        .update(OrganizationBillingEventTable)
        .set({
          status: input.status,
          error_message: input.errorMessage ?? null,
          processed_at: input.processedAt ?? new Date(),
        })
        .where(eq(OrganizationBillingEventTable.id, input.id))

      const rows = await database
        .select()
        .from(OrganizationBillingEventTable)
        .where(eq(OrganizationBillingEventTable.id, input.id))
        .limit(1)

      return rows[0] ? mapBillingEventRow(rows[0]) : null
    },
  }
}

function buildBillingAccountRecord(
  input: UpsertOrganizationBillingAccountInput,
  existing: OrganizationBillingAccountRecord | null,
  createId: (prefix: string) => string,
  now: () => Date,
): OrganizationBillingAccountRecord {
  const updatedAt = now()
  return {
    id: existing?.id ?? input.id ?? createId("billing"),
    orgId: input.orgId,
    mode: input.mode ?? existing?.mode ?? "none",
    source: input.source !== undefined ? input.source : existing?.source ?? null,
    status: input.status ?? existing?.status ?? "none",
    stripeCustomerId: input.stripeCustomerId !== undefined ? input.stripeCustomerId : existing?.stripeCustomerId ?? null,
    stripeSubscriptionId: input.stripeSubscriptionId !== undefined
      ? input.stripeSubscriptionId
      : existing?.stripeSubscriptionId ?? null,
    billingInterval: input.billingInterval !== undefined ? input.billingInterval : existing?.billingInterval ?? null,
    managedAiBasicQuantity: input.managedAiBasicQuantity ?? existing?.managedAiBasicQuantity ?? 0,
    managedAiExtendedQuantity: input.managedAiExtendedQuantity ?? existing?.managedAiExtendedQuantity ?? 0,
    localModelsQuantity: input.localModelsQuantity ?? existing?.localModelsQuantity ?? 0,
    manualAccessEnabled: input.manualAccessEnabled ?? existing?.manualAccessEnabled ?? false,
    manualAccessUnlimited: input.manualAccessUnlimited ?? existing?.manualAccessUnlimited ?? false,
    manualAccessExpiresAt: input.manualAccessExpiresAt !== undefined
      ? input.manualAccessExpiresAt
      : existing?.manualAccessExpiresAt ?? null,
    localModelsUnitAmount: input.localModelsUnitAmount !== undefined
      ? input.localModelsUnitAmount
      : existing?.localModelsUnitAmount ?? null,
    localModelsCurrency: input.localModelsCurrency !== undefined
      ? input.localModelsCurrency
      : existing?.localModelsCurrency ?? null,
    paymentProblemCode: input.paymentProblemCode !== undefined
      ? input.paymentProblemCode
      : existing?.paymentProblemCode ?? null,
    paymentProblemMessage: input.paymentProblemMessage !== undefined
      ? input.paymentProblemMessage
      : existing?.paymentProblemMessage ?? null,
    graceUntil: input.graceUntil !== undefined ? input.graceUntil : existing?.graceUntil ?? null,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  }
}

function normalizeTierAllowlistInputs(
  tiers: OrganizationBillingTierAllowlistInput[],
): OrganizationBillingTierAllowlistInput[] {
  const seen = new Set<string>()
  return tiers.map((entry) => {
    const tier = entry.tier.trim()
    if (tier.length === 0) {
      throw new OrganizationBillingRepositoryError("invalid_tier_allowlist", { reason: "empty_tier" })
    }
    if (seen.has(tier)) {
      throw new OrganizationBillingRepositoryError("invalid_tier_allowlist", { reason: "duplicate_tier", tier })
    }
    seen.add(tier)
    return { tier, enabled: entry.enabled }
  })
}

async function handleDuplicateBillingEventInsert(
  store: Pick<OrganizationBillingDataStore, "getBillingEventByStripeEventId">,
  record: OrganizationBillingEventRecord,
  error: unknown,
) {
  if (record.stripeEventId && isDuplicateKeyError(error) && store.getBillingEventByStripeEventId) {
    const existing = await store.getBillingEventByStripeEventId(record.stripeEventId)
    if (existing) {
      return existing
    }
  }

  throw error
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

function requestedLicenseLimitFor(input: AssertRequestedQuantitiesCanCoverActiveUsersInput) {
  const quantities = input.quantities ?? {}
  if (input.mode === "managed_ai") {
    return normalizeCount(quantities.managedAiBasic ?? 0) + normalizeCount(quantities.managedAiExtended ?? 0)
  }
  if (input.mode === "local_models") {
    return normalizeCount(quantities.localModels ?? 0)
  }
  if (input.mode === "manual_access") {
    return input.manualAccess?.enabled ? normalizeCount(input.manualAccess.licenseLimit) : 0
  }
  return 0
}

function isTierAllowed(
  account: OrganizationBillingAccountRecord,
  allowedTiers: OrganizationBillingTierAllowlistRecord[],
) {
  const allowlist = new Map(allowedTiers.map((entry) => [entry.tier, entry.enabled]))
  if (account.mode === "managed_ai") {
    const basicAllowed = account.managedAiBasicQuantity <= 0 || allowlist.get("managed_ai_basic") !== false
    const extendedAllowed = account.managedAiExtendedQuantity <= 0 || allowlist.get("managed_ai_extended") !== false
    return basicAllowed && extendedAllowed
  }
  if (account.mode === "local_models") {
    return allowlist.get("local_models") !== false
  }
  if (account.mode === "manual_access") {
    return allowlist.get("manual_access") !== false
  }
  return true
}

function manualAccessLicenseLimit(account: OrganizationBillingAccountRecord) {
  if (account.manualAccessUnlimited === true) {
    return Number.MAX_SAFE_INTEGER
  }
  return normalizeCount(account.managedAiBasicQuantity) +
    normalizeCount(account.managedAiExtendedQuantity) +
    normalizeCount(account.localModelsQuantity)
}

function normalizeCount(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.trunc(value))
}

function billingAccountRowValues(record: OrganizationBillingAccountRecord) {
  return {
    id: record.id,
    org_id: record.orgId,
    mode: record.mode,
    source: record.source,
    status: record.status,
    stripe_customer_id: record.stripeCustomerId,
    stripe_subscription_id: record.stripeSubscriptionId,
    billing_interval: record.billingInterval,
    managed_ai_basic_quantity: record.managedAiBasicQuantity,
    managed_ai_extended_quantity: record.managedAiExtendedQuantity,
    local_models_quantity: record.localModelsQuantity,
    manual_access_enabled: record.manualAccessEnabled,
    manual_access_unlimited: record.manualAccessUnlimited ?? false,
    manual_access_expires_at: record.manualAccessExpiresAt,
    local_models_unit_amount: record.localModelsUnitAmount,
    local_models_currency: record.localModelsCurrency,
    payment_problem_code: record.paymentProblemCode,
    payment_problem_message: record.paymentProblemMessage,
    grace_until: record.graceUntil,
    cancel_at_period_end: record.cancelAtPeriodEnd,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

function mapBillingAccountRow(row: typeof OrganizationBillingAccountTable.$inferSelect): OrganizationBillingAccountRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    mode: row.mode,
    source: row.source,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    billingInterval: row.billing_interval,
    managedAiBasicQuantity: row.managed_ai_basic_quantity,
    managedAiExtendedQuantity: row.managed_ai_extended_quantity,
    localModelsQuantity: row.local_models_quantity,
    manualAccessEnabled: row.manual_access_enabled,
    manualAccessUnlimited: row.manual_access_unlimited,
    manualAccessExpiresAt: row.manual_access_expires_at,
    localModelsUnitAmount: row.local_models_unit_amount,
    localModelsCurrency: row.local_models_currency,
    paymentProblemCode: row.payment_problem_code,
    paymentProblemMessage: row.payment_problem_message,
    graceUntil: row.grace_until,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTierAllowlistRow(row: typeof OrganizationBillingTierAllowlistTable.$inferSelect): OrganizationBillingTierAllowlistRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    tier: row.tier,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapBillingEventRow(row: typeof OrganizationBillingEventTable.$inferSelect): OrganizationBillingEventRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    stripeEventId: row.stripe_event_id,
    stripeEventType: row.stripe_event_type,
    status: row.status,
    payload: row.payload,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  }
}
