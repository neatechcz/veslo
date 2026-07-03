import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  OrganizationBillingRepositoryError,
  createOrganizationBillingRepository,
  type OrganizationBillingAccountRecord,
  type OrganizationBillingDataStore,
  type OrganizationBillingEventRecord,
  type OrganizationBillingTierAllowlistRecord,
} from "../src/billing/repository.js"

function assertBillingErrorCode(error: unknown, code: OrganizationBillingRepositoryError["code"]) {
  assert.ok(error instanceof OrganizationBillingRepositoryError)
  assert.equal(error.code, code)
}

function duplicateKeyError() {
  return Object.assign(new Error("Duplicate entry"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
  })
}

function createBillingAccount(input: Partial<OrganizationBillingAccountRecord> = {}): OrganizationBillingAccountRecord {
  const now = new Date("2026-06-23T12:00:00.000Z")
  return {
    id: "billing_1",
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_subscription",
    status: "active",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    billingInterval: "monthly",
    managedAiBasicQuantity: 1,
    managedAiExtendedQuantity: 0,
    localModelsQuantity: 0,
    manualAccessEnabled: false,
    manualAccessExpiresAt: null,
    localModelsUnitAmount: null,
    localModelsCurrency: null,
    paymentProblemCode: null,
    paymentProblemMessage: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
    ...input,
  }
}

function createMemoryBillingRepository(input: {
  accounts?: OrganizationBillingAccountRecord[]
  allowedTiers?: OrganizationBillingTierAllowlistRecord[]
  events?: OrganizationBillingEventRecord[]
  memberships?: Array<{ orgId: string; status: "active" | "disabled" | "removed" }>
  now?: Date
} = {}) {
  const accounts = [...(input.accounts ?? [])]
  const allowedTiers = [...(input.allowedTiers ?? [])]
  const events = [...(input.events ?? [])]
  const memberships = [...(input.memberships ?? [])]
  const now = input.now ?? new Date("2026-06-23T12:00:00.000Z")
  let nextId = 1

  const createId = (prefix: string) => `${prefix}_${nextId++}`

  const store: OrganizationBillingDataStore = {
    async getBillingAccount(orgId) {
      return accounts.find((entry) => entry.orgId === orgId) ?? null
    },
    async findBillingAccountByStripeSubscriptionId(stripeSubscriptionId) {
      return accounts.find((entry) => entry.stripeSubscriptionId === stripeSubscriptionId) ?? null
    },
    async findBillingAccountByStripeCustomerId(stripeCustomerId) {
      return accounts.find((entry) => entry.stripeCustomerId === stripeCustomerId) ?? null
    },
    async upsertBillingAccount(record) {
      const existingIndex = accounts.findIndex((entry) => entry.orgId === record.orgId)
      if (existingIndex >= 0) {
        accounts[existingIndex] = record
      } else {
        accounts.push(record)
      }
      return record
    },
    async listAllowedTiers(orgId) {
      return allowedTiers.filter((entry) => entry.orgId === orgId)
    },
    async setAllowedTiers(orgId, tiers) {
      for (let index = allowedTiers.length - 1; index >= 0; index -= 1) {
        if (allowedTiers[index]?.orgId === orgId) {
          allowedTiers.splice(index, 1)
        }
      }
      const records = tiers.map((entry) => ({
        id: createId("tier"),
        orgId,
        tier: entry.tier,
        enabled: entry.enabled,
        createdAt: now,
        updatedAt: now,
      }))
      allowedTiers.push(...records)
      return records
    },
    async countActiveUsers(orgId) {
      return memberships.filter((entry) => entry.orgId === orgId && entry.status === "active").length
    },
    async recordBillingEvent(record) {
      if (record.stripeEventId) {
        const existing = events.find((entry) => entry.stripeEventId === record.stripeEventId)
        if (existing) {
          return existing
        }
      }
      events.push(record)
      return record
    },
    async updateBillingEvent(update) {
      const existing = events.find((entry) => entry.id === update.id)
      if (!existing) {
        return null
      }
      existing.status = update.status
      existing.errorMessage = update.errorMessage ?? null
      existing.processedAt = update.processedAt ?? null
      return existing
    },
  }

  return {
    accounts,
    allowedTiers,
    events,
    memberships,
    repository: createOrganizationBillingRepository(store, { createId, now: () => now }),
  }
}

test("organization billing repository creates and updates an account", async () => {
  const { repository } = createMemoryBillingRepository()

  const created = await repository.upsertBillingAccount({
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_checkout",
    status: "active",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    managedAiBasicQuantity: 1,
    managedAiExtendedQuantity: 2,
  })

  assert.equal(created.id, "billing_1")
  assert.equal(created.managedAiBasicQuantity, 1)
  assert.equal(created.managedAiExtendedQuantity, 2)
  assert.deepEqual(await repository.getBillingAccount("org_1"), created)

  const updated = await repository.upsertBillingAccount({
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_subscription",
    status: "trialing",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_456",
    managedAiBasicQuantity: 3,
    managedAiExtendedQuantity: 1,
  })

  assert.equal(updated.id, created.id)
  assert.equal(updated.status, "trialing")
  assert.equal(updated.stripeSubscriptionId, "sub_456")
  assert.equal(updated.managedAiBasicQuantity + updated.managedAiExtendedQuantity, 4)
})

test("organization billing repository preserves an existing account id on update", async () => {
  const { repository } = createMemoryBillingRepository()

  const created = await repository.upsertBillingAccount({
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_checkout",
    status: "active",
    managedAiBasicQuantity: 1,
  })

  const updated = await repository.upsertBillingAccount({
    id: "billing_replacement_attempt",
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_subscription",
    status: "trialing",
    managedAiBasicQuantity: 3,
  })

  assert.equal(updated.id, created.id)
  assert.equal((await repository.getBillingAccount("org_1"))?.id, created.id)
  assert.equal(updated.managedAiBasicQuantity, 3)
})

test("organization billing repository finds accounts by Stripe subscription and customer ids", async () => {
  const account = createBillingAccount({
    orgId: "org_lookup",
    stripeSubscriptionId: "sub_lookup",
    stripeCustomerId: "cus_lookup",
  })
  const { repository } = createMemoryBillingRepository({ accounts: [account] })

  assert.deepEqual(await repository.findBillingAccountByStripeSubscriptionId("sub_lookup"), account)
  assert.deepEqual(await repository.findBillingAccountByStripeCustomerId("cus_lookup"), account)
  assert.equal(await repository.findBillingAccountByStripeSubscriptionId("sub_missing"), null)
  assert.equal(await repository.findBillingAccountByStripeCustomerId("cus_missing"), null)
})

test("organization billing repository retries account upserts after a duplicate org race", async () => {
  const now = new Date("2026-06-23T12:00:00.000Z")
  let account: OrganizationBillingAccountRecord | null = null
  let upsertAttempts = 0
  const store: OrganizationBillingDataStore = {
    async getBillingAccount(orgId) {
      return account?.orgId === orgId ? account : null
    },
    async upsertBillingAccount(record) {
      upsertAttempts += 1
      if (upsertAttempts === 1) {
        account = {
          ...record,
          id: "billing_existing",
          managedAiBasicQuantity: 1,
          createdAt: new Date("2026-06-23T11:59:00.000Z"),
        }
        throw duplicateKeyError()
      }
      account = record
      return record
    },
    async listAllowedTiers() {
      return []
    },
    async setAllowedTiers() {
      return []
    },
    async countActiveUsers() {
      return 0
    },
    async recordBillingEvent(record) {
      return record
    },
  }
  const repository = createOrganizationBillingRepository(store, {
    createId: () => "billing_new",
    now: () => now,
  })

  const updated = await repository.upsertBillingAccount({
    id: "billing_input_id",
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_checkout",
    status: "active",
    managedAiBasicQuantity: 4,
  })

  assert.equal(upsertAttempts, 2)
  assert.equal(updated.id, "billing_existing")
  assert.equal(updated.createdAt.toISOString(), "2026-06-23T11:59:00.000Z")
  assert.equal(updated.managedAiBasicQuantity, 4)
})

test("organization billing repository derives active managed-ai license limits", async () => {
  const { repository } = createMemoryBillingRepository({
    memberships: [
      { orgId: "org_1", status: "active" },
      { orgId: "org_1", status: "active" },
    ],
  })
  await repository.upsertBillingAccount({
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_subscription",
    status: "active",
    managedAiBasicQuantity: 1,
    managedAiExtendedQuantity: 2,
  })

  const entitlement = await repository.deriveEntitlement("org_1")

  assert.equal(entitlement.activeUserCount, 2)
  assert.equal(entitlement.licenseLimit, 3)
  assert.equal(entitlement.canUseManagedAi, true)
})

test("organization billing repository rejects requested quantity decreases below active users", async () => {
  const { repository } = createMemoryBillingRepository({
    memberships: [
      { orgId: "org_1", status: "active" },
      { orgId: "org_1", status: "active" },
      { orgId: "org_1", status: "active" },
    ],
  })

  await assert.rejects(
    repository.assertRequestedQuantitiesCanCoverActiveUsers({
      orgId: "org_1",
      mode: "managed_ai",
      quantities: {
        managedAiBasic: 1,
        managedAiExtended: 1,
        localModels: 0,
      },
    }),
    (error) => {
      assertBillingErrorCode(error, "requested_license_limit_below_active_users")
      assert.deepEqual((error as OrganizationBillingRepositoryError).details, {
        requestedLicenseLimit: 2,
        activeUserCount: 3,
      })
      return true
    },
  )
})

test("organization billing repository does not grant expired manual access", async () => {
  const { repository } = createMemoryBillingRepository({
    now: new Date("2026-06-23T12:00:00.000Z"),
    memberships: [{ orgId: "org_1", status: "active" }],
  })
  await repository.upsertBillingAccount({
    orgId: "org_1",
    mode: "manual_access",
    source: "manual_external",
    status: "active",
    manualAccessEnabled: true,
    manualAccessExpiresAt: new Date("2026-06-23T11:59:59.000Z"),
    managedAiBasicQuantity: 5,
  })

  const entitlement = await repository.deriveEntitlement("org_1")

  assert.equal(entitlement.effectiveMode, "none")
  assert.equal(entitlement.licenseLimit, 0)
  assert.equal(entitlement.canUseManagedAi, false)
  assert.equal(entitlement.managedAiBlockingReason, "payment_required")
})

test("organization billing repository replaces and lists tier allowlist entries", async () => {
  const { repository } = createMemoryBillingRepository()

  await repository.setAllowedTiers("org_1", [
    { tier: "managed_ai_basic", enabled: true },
    { tier: "local_models", enabled: false },
  ])
  assert.deepEqual(
    (await repository.listAllowedTiers("org_1")).map((entry) => ({ tier: entry.tier, enabled: entry.enabled })),
    [
      { tier: "managed_ai_basic", enabled: true },
      { tier: "local_models", enabled: false },
    ],
  )

  await repository.setAllowedTiers("org_1", [{ tier: "managed_ai_extended", enabled: true }])
  assert.deepEqual(
    (await repository.listAllowedTiers("org_1")).map((entry) => ({ tier: entry.tier, enabled: entry.enabled })),
    [{ tier: "managed_ai_extended", enabled: true }],
  )
})

test("organization billing repository rejects invalid tier replacements before mutating existing rows", async () => {
  const existingTier: OrganizationBillingTierAllowlistRecord = {
    id: "tier_existing",
    orgId: "org_1",
    tier: "managed_ai_basic",
    enabled: true,
    createdAt: new Date("2026-06-23T11:00:00.000Z"),
    updatedAt: new Date("2026-06-23T11:00:00.000Z"),
  }
  const { repository } = createMemoryBillingRepository({ allowedTiers: [existingTier] })

  await assert.rejects(
    repository.setAllowedTiers("org_1", [
      { tier: "managed_ai_extended", enabled: true },
      { tier: "managed_ai_extended", enabled: false },
    ]),
    (error) => {
      assertBillingErrorCode(error, "invalid_tier_allowlist" as OrganizationBillingRepositoryError["code"])
      return true
    },
  )
  assert.deepEqual(await repository.listAllowedTiers("org_1"), [existingTier])

  await assert.rejects(
    repository.setAllowedTiers("org_1", [{ tier: " ", enabled: true }]),
    (error) => {
      assertBillingErrorCode(error, "invalid_tier_allowlist" as OrganizationBillingRepositoryError["code"])
      return true
    },
  )
  assert.deepEqual(await repository.listAllowedTiers("org_1"), [existingTier])
})

test("organization billing repository records Stripe events idempotently", async () => {
  const { events, repository } = createMemoryBillingRepository()

  const first = await repository.recordBillingEvent({
    orgId: "org_1",
    stripeEventId: "evt_123",
    stripeEventType: "invoice.paid",
    status: "applied",
    payload: { id: "evt_123", type: "invoice.paid" },
    processedAt: new Date("2026-06-23T12:01:00.000Z"),
  })
  const second = await repository.recordBillingEvent({
    orgId: "org_1",
    stripeEventId: "evt_123",
    stripeEventType: "invoice.paid",
    status: "failed",
    payload: { id: "evt_123", duplicate: true },
    errorMessage: "duplicate should not replace the original",
    processedAt: new Date("2026-06-23T12:02:00.000Z"),
  })

  assert.equal(first.id, "billing_event_1")
  assert.equal(second.id, first.id)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.status, "applied")
})

test("organization billing repository updates a recorded billing event status", async () => {
  const { events, repository } = createMemoryBillingRepository()

  const recorded = await repository.recordBillingEvent({
    orgId: "org_1",
    stripeEventId: "evt_apply_failure",
    stripeEventType: "checkout.session.completed",
    status: "applied",
    payload: { id: "evt_apply_failure" },
    processedAt: new Date("2026-06-23T12:01:00.000Z"),
  })

  const updated = await repository.updateBillingEvent({
    id: recorded.id,
    status: "failed",
    errorMessage: "database write failed",
    processedAt: new Date("2026-06-23T12:02:00.000Z"),
  })

  assert.equal(updated?.id, recorded.id)
  assert.equal(updated?.status, "failed")
  assert.equal(updated?.errorMessage, "database write failed")
  assert.equal(updated?.processedAt?.toISOString(), "2026-06-23T12:02:00.000Z")
  assert.equal(events[0]?.status, "failed")
})

test("organization billing repository returns the original Stripe event after a duplicate insert race", async () => {
  const existingEvent: OrganizationBillingEventRecord = {
    id: "billing_event_existing",
    orgId: "org_1",
    stripeEventId: "evt_race",
    stripeEventType: "invoice.paid",
    status: "applied",
    payload: { id: "evt_race", original: true },
    errorMessage: null,
    createdAt: new Date("2026-06-23T12:00:00.000Z"),
    processedAt: new Date("2026-06-23T12:01:00.000Z"),
  }
  let insertAttempts = 0
  const store = {
    async getBillingAccount() {
      return null
    },
    async upsertBillingAccount(record) {
      return record
    },
    async listAllowedTiers() {
      return []
    },
    async setAllowedTiers() {
      return []
    },
    async countActiveUsers() {
      return 0
    },
    async recordBillingEvent() {
      insertAttempts += 1
      throw duplicateKeyError()
    },
    async getBillingEventByStripeEventId(stripeEventId: string) {
      return stripeEventId === existingEvent.stripeEventId ? existingEvent : null
    },
  } satisfies OrganizationBillingDataStore & {
    getBillingEventByStripeEventId(stripeEventId: string): Promise<OrganizationBillingEventRecord | null>
  }
  const repository = createOrganizationBillingRepository(store, {
    createId: () => "billing_event_new",
    now: () => new Date("2026-06-23T12:02:00.000Z"),
  })

  const event = await repository.recordBillingEvent({
    orgId: "org_1",
    stripeEventId: "evt_race",
    stripeEventType: "invoice.paid",
    status: "failed",
    payload: { id: "evt_race", duplicate: true },
    errorMessage: "duplicate delivery",
    processedAt: new Date("2026-06-23T12:03:00.000Z"),
  })

  assert.equal(insertAttempts, 1)
  assert.equal(event.id, existingEvent.id)
  assert.equal(event.status, "applied")
  assert.deepEqual(event.payload, { id: "evt_race", original: true })
})

test("organization billing repository counts active memberships only", async () => {
  const { repository } = createMemoryBillingRepository({
    memberships: [
      { orgId: "org_1", status: "active" },
      { orgId: "org_1", status: "disabled" },
      { orgId: "org_1", status: "removed" },
      { orgId: "org_2", status: "active" },
    ],
  })

  assert.equal(await repository.countActiveUsers("org_1"), 1)
})

test("drizzle billing active-user count excludes globally disabled users", () => {
  const source = readFileSync(new URL("../src/billing/repository.ts", import.meta.url), "utf8")
  const countSource = source.match(/async countActiveUsers\(orgId\)[\s\S]*?async getBillingEventByStripeEventId/)?.[0] ?? ""

  assert.match(source, /AdminUserStateTable/)
  assert.match(countSource, /leftJoin\(AdminUserStateTable/)
  assert.match(countSource, /isNull\(AdminUserStateTable\.disabled\)/)
  assert.match(countSource, /eq\(AdminUserStateTable\.disabled,\s*false\)/)
})
