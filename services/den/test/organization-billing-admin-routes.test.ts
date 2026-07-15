import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { deriveOrganizationBillingEntitlement } from "../src/billing/organization-billing.js"
import { OrganizationBillingRepositoryError, type OrganizationBillingAccountRecord, type OrganizationBillingRepository } from "../src/billing/repository.js"
import { type OrganizationStripeBillingService } from "../src/billing/stripe-service.js"
import { createAdminRouter, type AdminOrganizationRecord, type AdminRouteDeps, type AdminSessionSnapshot } from "../src/http/admin.js"
import { errorMiddleware } from "../src/http/errors.js"

function orgAdminSession(): AdminSessionSnapshot {
  return {
    user: {
      id: "user_org_admin",
      email: "admin@example.com",
      emailVerified: true,
      name: "Org Admin",
    },
    platformAdmin: false,
    activeOrgId: "org_1",
    organizations: [
      {
        id: "org_1",
        name: "Alpha",
        slug: "alpha",
        ownerUserId: "user_org_admin",
        role: "organization_admin",
      },
    ],
  }
}

function platformAdminSession(): AdminSessionSnapshot {
  return {
    ...orgAdminSession(),
    user: {
      id: "user_platform_admin",
      email: "platform@example.com",
      emailVerified: true,
      name: "Platform Admin",
    },
    platformAdmin: true,
  }
}

function billingSummary() {
  return {
    billing: {
      account: {
        id: "billing_1",
        orgId: "org_1",
        mode: "managed_ai" as const,
        source: "stripe_subscription",
        status: "active" as const,
        billingInterval: "monthly",
        quantities: {
          managedAiBasic: 2,
          managedAiExtended: 0,
          localModels: 0,
        },
        manualAccess: {
          enabled: false,
          expiresAt: null,
        },
        localModels: {
          unitAmount: null,
          currency: null,
        },
        stripe: {
          customerConfigured: true,
          subscriptionConfigured: true,
        },
        paymentProblem: {
          code: null,
          message: null,
        },
        graceUntil: null,
        cancelAtPeriodEnd: false,
        createdAt: "2026-06-23T08:00:00.000Z",
        updatedAt: "2026-06-23T08:00:00.000Z",
      },
      entitlement: {
        mode: "managed_ai" as const,
        effectiveMode: "managed_ai" as const,
        status: "active" as const,
        canUseManagedAi: true,
        canUseByokOrLocalProvider: true,
        canReadHistory: true,
        licenseLimit: 2,
        activeUserCount: 1,
        isInGracePeriod: false,
        warning: null,
        managedAiBlockingReason: null,
        byokOrLocalProviderBlockingReason: null,
      },
      allowedTiers: [
        { tier: "managed_ai_basic", enabled: true },
        { tier: "managed_ai_extended", enabled: true },
      ],
      activeUserCount: 1,
      licenseLimit: 2,
      availableManagedAiTiers: [
        { tier: "managed_ai_basic", key: "basic" as const, name: "Basic" },
        { tier: "managed_ai_extended", key: "extended" as const, name: "Extended" },
      ],
    },
  }
}

function billingAccount(input: Partial<OrganizationBillingAccountRecord> = {}): OrganizationBillingAccountRecord {
  return {
    id: "billing_1",
    orgId: "org_1",
    mode: "managed_ai",
    source: "stripe_subscription",
    status: "active",
    stripeCustomerId: "cus_secret",
    stripeSubscriptionId: "sub_secret",
    billingInterval: "monthly",
    managedAiBasicQuantity: 2,
    managedAiExtendedQuantity: 0,
    localModelsQuantity: 0,
    manualAccessEnabled: false,
    manualAccessUnlimited: false,
    manualAccessExpiresAt: null,
    localModelsUnitAmount: null,
    localModelsCurrency: null,
    paymentProblemCode: null,
    paymentProblemMessage: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    createdAt: new Date("2026-06-23T08:00:00.000Z"),
    updatedAt: new Date("2026-06-23T08:00:00.000Z"),
    ...input,
  }
}

type BillingAccountUpdateInput = Parameters<OrganizationBillingRepository["upsertBillingAccount"]>[0]

const dayMs = 24 * 60 * 60 * 1000

function futureBillingIsoString(daysFromNow = 14) {
  return new Date(Date.now() + daysFromNow * dayMs).toISOString()
}

function pastBillingIsoString(daysAgo = 1) {
  return new Date(Date.now() - daysAgo * dayMs).toISOString()
}

function applyBillingAccountUpdate(
  existing: OrganizationBillingAccountRecord,
  input: BillingAccountUpdateInput,
): OrganizationBillingAccountRecord {
  return billingAccount({
    ...existing,
    orgId: input.orgId,
    mode: input.mode ?? existing.mode,
    source: input.source !== undefined ? input.source : existing.source,
    status: input.status ?? existing.status,
    stripeCustomerId: input.stripeCustomerId !== undefined ? input.stripeCustomerId : existing.stripeCustomerId,
    stripeSubscriptionId: input.stripeSubscriptionId !== undefined ? input.stripeSubscriptionId : existing.stripeSubscriptionId,
    billingInterval: input.billingInterval !== undefined ? input.billingInterval : existing.billingInterval,
    managedAiBasicQuantity: input.managedAiBasicQuantity ?? existing.managedAiBasicQuantity,
    managedAiExtendedQuantity: input.managedAiExtendedQuantity ?? existing.managedAiExtendedQuantity,
    localModelsQuantity: input.localModelsQuantity ?? existing.localModelsQuantity,
    manualAccessEnabled: input.manualAccessEnabled ?? existing.manualAccessEnabled,
    manualAccessUnlimited: input.manualAccessUnlimited ?? existing.manualAccessUnlimited,
    manualAccessExpiresAt: input.manualAccessExpiresAt !== undefined ? input.manualAccessExpiresAt : existing.manualAccessExpiresAt,
    localModelsUnitAmount: input.localModelsUnitAmount !== undefined ? input.localModelsUnitAmount : existing.localModelsUnitAmount,
    localModelsCurrency: input.localModelsCurrency !== undefined ? input.localModelsCurrency : existing.localModelsCurrency,
    paymentProblemCode: input.paymentProblemCode !== undefined ? input.paymentProblemCode : existing.paymentProblemCode,
    paymentProblemMessage: input.paymentProblemMessage !== undefined ? input.paymentProblemMessage : existing.paymentProblemMessage,
    graceUntil: input.graceUntil !== undefined ? input.graceUntil : existing.graceUntil,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
    updatedAt: new Date("2026-06-23T08:01:00.000Z"),
  })
}

const platformTrialExpiry = futureBillingIsoString()

const platformTrialGrantPayload = {
  mode: "manual_access",
  source: "manual_trial",
  status: "active",
  quantities: { managedAiBasic: 2, managedAiExtended: 1 },
  manualAccess: {
    enabled: true,
    expiresAt: platformTrialExpiry,
    licenseLimit: 3,
  },
}

function organization(): AdminOrganizationRecord {
  return {
    id: "org_1",
    name: "Alpha",
    slug: "alpha",
    ownerUserId: "user_org_admin",
    seatLimit: null,
  }
}

function runtimeRepository(
  overrides: Partial<OrganizationBillingRepository> = {},
): OrganizationBillingRepository {
  return {
    async getBillingAccount() {
      return billingAccount()
    },
    async findBillingAccountByStripeSubscriptionId() {
      return null
    },
    async findBillingAccountByStripeCustomerId() {
      return null
    },
    async upsertBillingAccount(input) {
      return billingAccount({
        mode: input.mode ?? "managed_ai",
        status: input.status ?? "active",
        managedAiBasicQuantity: input.managedAiBasicQuantity ?? 2,
        managedAiExtendedQuantity: input.managedAiExtendedQuantity ?? 0,
        localModelsQuantity: input.localModelsQuantity ?? 0,
      })
    },
    async listAllowedTiers() {
      return [
        {
          id: "tier_1",
          orgId: "org_1",
          tier: "managed_ai_basic",
          enabled: true,
          createdAt: new Date("2026-06-23T08:00:00.000Z"),
          updatedAt: new Date("2026-06-23T08:00:00.000Z"),
        },
      ]
    },
    async setAllowedTiers(_orgId, tiers) {
      return tiers.map((entry, index) => ({
        id: `tier_${index}`,
        orgId: "org_1",
        tier: entry.tier,
        enabled: entry.enabled,
        createdAt: new Date("2026-06-23T08:00:00.000Z"),
        updatedAt: new Date("2026-06-23T08:00:00.000Z"),
      }))
    },
    async countActiveUsers() {
      return 2
    },
    async deriveEntitlement() {
      return {
        mode: "managed_ai",
        effectiveMode: "managed_ai",
        status: "active",
        canUseManagedAi: true,
        canUseByokOrLocalProvider: true,
        canReadHistory: true,
        licenseLimit: 2,
        isUnlimited: false,
        activeUserCount: 2,
        isInGracePeriod: false,
        warning: null,
        managedAiBlockingReason: null,
        byokOrLocalProviderBlockingReason: null,
      }
    },
    async assertRequestedQuantitiesCanCoverActiveUsers() {},
    async recordBillingEvent(input) {
      return {
        id: input.id ?? "billing_event_1",
        orgId: input.orgId,
        stripeEventId: input.stripeEventId ?? null,
        stripeEventType: input.stripeEventType ?? null,
        status: input.status,
        payload: input.payload,
        errorMessage: input.errorMessage ?? null,
        createdAt: input.createdAt ?? new Date("2026-06-23T08:00:00.000Z"),
        processedAt: input.processedAt ?? null,
      }
    },
    async updateBillingEvent() {
      return null
    },
    ...overrides,
  }
}

function runtimeStripeService(
  overrides: Partial<OrganizationStripeBillingService> = {},
): OrganizationStripeBillingService {
  return {
    async createManagedAiCheckoutSession() {
      return { id: "cs_test_123", url: "https://stripe.example.test/checkout" }
    },
    async createBillingPortalSession() {
      return { id: "bps_123", url: "https://stripe.example.test/portal" }
    },
    async updateManagedAiSubscriptionQuantities() {},
    async cancelManagedAiSubscriptionAtPeriodEnd() {},
    async createLocalModelsStripeInvoiceOrSubscription() {
      return { status: "not_configured", orgId: "org_1", billingMode: "local_models" }
    },
    ...overrides,
  }
}

async function listen(deps: AdminRouteDeps) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRouter(deps))
  app.use(errorMiddleware)
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  }
}

async function runtimeBillingRouteDeps(input: {
  repository?: OrganizationBillingRepository
  stripeService?: OrganizationStripeBillingService | null
  platformAdmin?: boolean
  auditEvents?: Array<{ orgId: string; action: string; payload: unknown }>
}) {
  process.env.DATABASE_URL ??= "mysql://veslo:veslo@127.0.0.1:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "test_secret_for_admin_runtime_123456789"
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3000"

  const { createOrganizationBillingAdminRouteDeps } = await import("../src/http/admin-runtime.js")
  const snapshot = input.platformAdmin === false ? orgAdminSession() : platformAdminSession()
  return createOrganizationBillingAdminRouteDeps({
    repository: input.repository ?? runtimeRepository(),
    stripeService: input.stripeService === undefined ? runtimeStripeService() : input.stripeService,
    async requireOrganizationAccess(_req, _res) {
      return { snapshot, organization: organization() }
    },
    async requirePlatformAdmin(_req, res) {
      if (!snapshot.platformAdmin) {
        res.status(403).json({ error: "forbidden" })
        return null
      }
      return snapshot
    },
    async recordOrganizationAudit(_snapshot, orgId, action, payload) {
      input.auditEvents?.push({ orgId, action, payload })
    },
  })
}

test("organization billing routes return 501 when deps are missing", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
  })

  try {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/organizations/org_1/billing", undefined],
      ["/organizations/org_1/billing/checkout", { method: "POST" }],
      ["/organizations/org_1/billing/portal", { method: "POST" }],
      ["/organizations/org_1/billing/plan", { method: "PATCH" }],
      ["/organizations/org_1/billing/cancel", { method: "POST" }],
      ["/organizations/org_1/billing/platform", { method: "PATCH" }],
    ]

    for (const [path, init] of cases) {
      const response = await fetch(`${baseUrl}${path}`, init)
      assert.equal(response.status, 501, path)
      assert.deepEqual(await response.json(), { error: "not_implemented" })
    }
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admins can call self-serve billing routes and payloads stay secret-free", async () => {
  const calls: string[] = []
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    async getOrganizationBilling(req) {
      calls.push(`get:${req.params.orgId}`)
      return billingSummary()
    },
    async createOrganizationBillingCheckout(req) {
      calls.push(`checkout:${req.params.orgId}:${req.body.interval}:${req.body.quantities.managedAiBasic}`)
      return { checkout: { id: "cs_test_123", url: "https://stripe.example.test/checkout" } }
    },
    async createOrganizationBillingPortalSession(req) {
      calls.push(`portal:${req.params.orgId}`)
      return { portal: { id: "bps_123", url: "https://stripe.example.test/portal" } }
    },
    async updateOrganizationBillingPlan(req) {
      calls.push(`plan:${req.params.orgId}:${req.body.quantities.managedAiBasic}`)
      return billingSummary()
    },
    async cancelOrganizationBilling(req) {
      calls.push(`cancel:${req.params.orgId}`)
      return { ok: true }
    },
  })

  try {
    const summaryResponse = await fetch(`${baseUrl}/organizations/org_1/billing`)
    assert.equal(summaryResponse.status, 200)
    const summaryPayload = await summaryResponse.json()
    assert.equal(JSON.stringify(summaryPayload).includes("sk_test"), false)
    assert.equal(JSON.stringify(summaryPayload).includes("whsec_"), false)
    assert.equal(JSON.stringify(summaryPayload).includes("cus_"), false)
    assert.equal(JSON.stringify(summaryPayload).includes("sub_"), false)

    const checkoutResponse = await fetch(`${baseUrl}/organizations/org_1/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval: "monthly", quantities: { managedAiBasic: 2, managedAiExtended: 0 } }),
    })
    assert.equal(checkoutResponse.status, 200)
    assert.deepEqual(await checkoutResponse.json(), {
      checkout: { id: "cs_test_123", url: "https://stripe.example.test/checkout" },
    })

    const portalResponse = await fetch(`${baseUrl}/organizations/org_1/billing/portal`, { method: "POST" })
    assert.equal(portalResponse.status, 200)
    assert.deepEqual(await portalResponse.json(), {
      portal: { id: "bps_123", url: "https://stripe.example.test/portal" },
    })

    const planResponse = await fetch(`${baseUrl}/organizations/org_1/billing/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantities: { managedAiBasic: 3, managedAiExtended: 0 } }),
    })
    assert.equal(planResponse.status, 200)
    assert.equal((await planResponse.json()).billing.licenseLimit, 2)

    const cancelResponse = await fetch(`${baseUrl}/organizations/org_1/billing/cancel`, { method: "POST" })
    assert.equal(cancelResponse.status, 200)
    assert.deepEqual(await cancelResponse.json(), { ok: true })

    assert.deepEqual(calls, [
      "get:org_1",
      "checkout:org_1:monthly:2",
      "portal:org_1",
      "plan:org_1:3",
      "cancel:org_1",
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("organization admins cannot call platform billing update route", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    async updatePlatformOrganizationBilling(_req, res) {
      res.status(403).json({ error: "platform_admin_required" })
      return null
    },
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "platform_admin_required" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("platform admins can update organization billing platform fields", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    async updatePlatformOrganizationBilling(req) {
      assert.deepEqual(req.body.allowlist, [
        { tier: "managed_ai_basic", enabled: true },
        { tier: "managed_ai_extended", enabled: false },
      ])
      return billingSummary()
    },
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "managed_ai",
        status: "active",
        allowlist: [
          { tier: "managed_ai_basic", enabled: true },
          { tier: "managed_ai_extended", enabled: false },
        ],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).billing.account.mode, "managed_ai")
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("invalid organization billing quantities return stable errors", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    async updateOrganizationBillingPlan(_req, res) {
      res.status(400).json({ error: "invalid_billing_quantities" })
      return null
    },
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantities: { managedAiBasic: -1, managedAiExtended: 0 } }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "invalid_billing_quantities" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing allowlist-only update skips active-user license validation", async () => {
  let validationCalls = 0
  let upsertCalls = 0
  let allowlistCalls = 0
  const auditEvents: Array<{ orgId: string; action: string; payload: unknown }> = []
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      auditEvents,
      repository: runtimeRepository({
        async getBillingAccount() {
          return null
        },
        async assertRequestedQuantitiesCanCoverActiveUsers() {
          validationCalls += 1
          throw new OrganizationBillingRepositoryError("requested_license_limit_below_active_users", {
            requestedLicenseLimit: 0,
            activeUserCount: 2,
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "none" })
        },
        async setAllowedTiers(_orgId, tiers) {
          allowlistCalls += 1
          return tiers.map((entry, index) => ({
            id: `tier_${index}`,
            orgId: "org_1",
            tier: entry.tier,
            enabled: entry.enabled,
            createdAt: new Date("2026-06-23T08:00:00.000Z"),
            updatedAt: new Date("2026-06-23T08:00:00.000Z"),
          }))
        },
        async deriveEntitlement() {
          return {
            mode: "none",
            effectiveMode: "none",
            status: "none",
            canUseManagedAi: false,
            canUseByokOrLocalProvider: false,
            canReadHistory: true,
            licenseLimit: 0,
            activeUserCount: 2,
            isInGracePeriod: false,
            warning: null,
            managedAiBlockingReason: "payment_required",
            byokOrLocalProviderBlockingReason: "payment_required",
          }
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowlist: [
          { tier: "managed_ai_basic", enabled: true },
          { tier: "managed_ai_extended", enabled: false },
        ],
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(validationCalls, 0)
    assert.equal(upsertCalls, 0)
    assert.equal(allowlistCalls, 1)
    assert.equal(auditEvents[0]?.action, "admin.billing.platform.updated")
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing update requires platform admin access before repository writes", async () => {
  let repositoryCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      repository: runtimeRepository({
        async getBillingAccount() {
          repositoryCalls += 1
          return billingAccount()
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "forbidden" })
    assert.equal(repositoryCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route grants platform trial access with quantities and expiry", async () => {
  let storedAccount = billingAccount({
    mode: "none",
    source: null,
    status: "none",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    billingInterval: null,
    managedAiBasicQuantity: 0,
    managedAiExtendedQuantity: 0,
    localModelsQuantity: 0,
    manualAccessEnabled: false,
    manualAccessExpiresAt: null,
  })
  let validationCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return storedAccount
        },
        async assertRequestedQuantitiesCanCoverActiveUsers(input) {
          validationCalls += 1
          assert.equal(input.mode, "manual_access")
          assert.deepEqual(input.quantities, { managedAiBasic: 2, managedAiExtended: 1, localModels: 0 })
          assert.deepEqual(input.manualAccess, { enabled: true, unlimited: false, licenseLimit: 3 })
        },
        async upsertBillingAccount(input) {
          storedAccount = applyBillingAccountUpdate(storedAccount, input)
          return storedAccount
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(platformTrialGrantPayload),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.billing.account.mode, "manual_access")
    assert.equal(payload.billing.account.source, "manual_trial")
    assert.equal(payload.billing.account.manualAccess.enabled, true)
    assert.equal(payload.billing.account.manualAccess.expiresAt, platformTrialExpiry)
    assert.equal(payload.billing.account.quantities.managedAiBasic, 2)
    assert.equal(payload.billing.account.quantities.managedAiExtended, 1)
    assert.equal(validationCalls, 1)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route grants unlimited trial without expiry or seat quantities", async () => {
  let storedAccount = billingAccount({
    mode: "none",
    source: null,
    status: "none",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    billingInterval: null,
    managedAiBasicQuantity: 0,
    managedAiExtendedQuantity: 0,
    localModelsQuantity: 0,
    manualAccessEnabled: false,
    manualAccessUnlimited: false,
    manualAccessExpiresAt: null,
  })
  let validationCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return storedAccount
        },
        async assertRequestedQuantitiesCanCoverActiveUsers(input) {
          validationCalls += 1
          assert.equal(input.mode, "manual_access")
          assert.deepEqual(input.quantities, { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 })
          assert.deepEqual(input.manualAccess, { enabled: true, unlimited: true, licenseLimit: 0 })
        },
        async deriveEntitlement() {
          return deriveOrganizationBillingEntitlement({
            mode: storedAccount.mode,
            status: storedAccount.status,
            grace: false,
            manualAccess: storedAccount.manualAccessEnabled
              ? {
                enabled: true,
                allowManagedAi: true,
                unlimited: storedAccount.manualAccessUnlimited,
                licenseLimit: 0,
              }
              : null,
            quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
            activeUserCount: 250,
            policy: {
              allowByokWithoutPaidAccess: false,
              organizationAccessEnabled: true,
              tierAllowed: true,
            },
          })
        },
        async upsertBillingAccount(input) {
          storedAccount = applyBillingAccountUpdate(storedAccount, input)
          return storedAccount
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "manual_access",
        source: "manual_trial",
        status: "trialing",
        manualAccess: { enabled: true, unlimited: true, expiresAt: null },
      }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.billing.account.manualAccess, {
      enabled: true,
      unlimited: true,
      expiresAt: null,
    })
    assert.deepEqual(payload.billing.account.quantities, {
      managedAiBasic: 0,
      managedAiExtended: 0,
      localModels: 0,
    })
    assert.equal(payload.billing.entitlement.isUnlimited, true)
    assert.equal(payload.billing.entitlement.licenseLimit, null)
    assert.equal(payload.billing.entitlement.canUseManagedAi, true)
    assert.equal(validationCalls, 1)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route rejects an expiry on an unlimited trial", async () => {
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            mode: "none",
            source: null,
            status: "none",
            stripeSubscriptionId: null,
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "manual_access",
        source: "manual_trial",
        status: "trialing",
        manualAccess: { enabled: true, unlimited: true, expiresAt: futureBillingIsoString() },
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "unlimited_manual_access_cannot_expire" })
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route rejects unlimited manual access when access is disabled", async () => {
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            mode: "none",
            source: null,
            status: "none",
            stripeSubscriptionId: null,
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "manual_access",
        source: "manual_trial",
        status: "trialing",
        manualAccess: { enabled: false, unlimited: true, expiresAt: null },
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "unlimited_manual_access_requires_enabled_access" })
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route preserves existing trial expiry when source is resent", async () => {
  const existingExpiry = futureBillingIsoString()
  let storedAccount = billingAccount({
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    billingInterval: null,
    managedAiBasicQuantity: 2,
    managedAiExtendedQuantity: 1,
    localModelsQuantity: 0,
    manualAccessEnabled: true,
    manualAccessExpiresAt: new Date(existingExpiry),
  })
  let validationCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return storedAccount
        },
        async assertRequestedQuantitiesCanCoverActiveUsers(input) {
          validationCalls += 1
          assert.equal(input.mode, "manual_access")
          assert.deepEqual(input.quantities, { managedAiBasic: 3, managedAiExtended: 1, localModels: 0 })
          assert.deepEqual(input.manualAccess, { enabled: true, unlimited: false, licenseLimit: 4 })
        },
        async upsertBillingAccount(input) {
          storedAccount = applyBillingAccountUpdate(storedAccount, input)
          return storedAccount
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual_trial",
        quantities: { managedAiBasic: 3 },
        manualAccess: { enabled: true },
      }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.billing.account.source, "manual_trial")
    assert.equal(payload.billing.account.manualAccess.expiresAt, existingExpiry)
    assert.equal(payload.billing.account.quantities.managedAiBasic, 3)
    assert.equal(payload.billing.account.quantities.managedAiExtended, 1)
    assert.equal(validationCalls, 1)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route revokes platform trial access without active-user license validation", async () => {
  let storedAccount = billingAccount({
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    billingInterval: null,
    managedAiBasicQuantity: 2,
    managedAiExtendedQuantity: 1,
    localModelsQuantity: 0,
    manualAccessEnabled: true,
    manualAccessExpiresAt: new Date(platformTrialExpiry),
  })
  let validationCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return storedAccount
        },
        async deriveEntitlement() {
          return deriveOrganizationBillingEntitlement({
            mode: storedAccount.mode,
            status: storedAccount.status,
            grace: false,
            manualAccess: storedAccount.manualAccessEnabled
              ? {
                enabled: true,
                allowManagedAi: true,
                unlimited: storedAccount.manualAccessUnlimited,
                licenseLimit:
                  storedAccount.managedAiBasicQuantity +
                  storedAccount.managedAiExtendedQuantity +
                  storedAccount.localModelsQuantity,
              }
              : null,
            quantities: {
              managedAiBasic: storedAccount.managedAiBasicQuantity,
              managedAiExtended: storedAccount.managedAiExtendedQuantity,
              localModels: storedAccount.localModelsQuantity,
            },
            activeUserCount: 2,
            policy: {
              allowByokWithoutPaidAccess: false,
              organizationAccessEnabled: true,
              tierAllowed: true,
            },
          })
        },
        async assertRequestedQuantitiesCanCoverActiveUsers() {
          validationCalls += 1
          throw new OrganizationBillingRepositoryError("requested_license_limit_below_active_users", {
            requestedLicenseLimit: 0,
            activeUserCount: 2,
          })
        },
        async upsertBillingAccount(input) {
          storedAccount = applyBillingAccountUpdate(storedAccount, input)
          return storedAccount
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "none",
        source: null,
        status: "none",
        quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
        manualAccess: { enabled: false, unlimited: false, expiresAt: null },
      }),
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.billing.account.mode, "none")
    assert.equal(payload.billing.account.source, null)
    assert.equal(payload.billing.account.status, "none")
    assert.deepEqual(payload.billing.account.quantities, {
      managedAiBasic: 0,
      managedAiExtended: 0,
      localModels: 0,
    })
    assert.deepEqual(payload.billing.account.manualAccess, {
      enabled: false,
      unlimited: false,
      expiresAt: null,
    })
    assert.equal(payload.billing.entitlement.effectiveMode, "none")
    assert.equal(payload.billing.entitlement.canUseManagedAi, false)
    assert.equal(payload.billing.entitlement.managedAiBlockingReason, "payment_required")
    assert.equal(payload.billing.entitlement.isInGracePeriod, false)
    assert.equal(payload.billing.entitlement.warning, null)
    assert.equal(validationCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route validates existing trial expiry when source is omitted", async () => {
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            mode: "manual_access",
            source: "manual_trial",
            status: "active",
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            billingInterval: null,
            managedAiBasicQuantity: 2,
            managedAiExtendedQuantity: 1,
            localModelsQuantity: 0,
            manualAccessEnabled: true,
            manualAccessExpiresAt: new Date(pastBillingIsoString()),
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantities: { managedAiBasic: 3 },
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "invalid_manual_access_expires_at" })
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route rejects organization admin trial grants before repository writes", async () => {
  let repositoryCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      repository: runtimeRepository({
        async getBillingAccount() {
          repositoryCalls += 1
          return null
        },
        async upsertBillingAccount(input) {
          repositoryCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(platformTrialGrantPayload),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "forbidden" })
    assert.equal(repositoryCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route rejects platform trial when Stripe subscription exists", async () => {
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            mode: "managed_ai",
            source: "stripe_subscription",
            stripeSubscriptionId: "sub_secret",
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(platformTrialGrantPayload),
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: "stripe_subscription_exists" })
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing route requires future platform trial expiry", async () => {
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            mode: "none",
            source: null,
            status: "none",
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            managedAiBasicQuantity: 0,
            managedAiExtendedQuantity: 0,
            manualAccessEnabled: false,
            manualAccessExpiresAt: null,
          })
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({ mode: input.mode ?? "manual_access" })
        },
      }),
    }),
  })

  try {
    const cases = [
      {
        name: "missing expiry",
        body: {
          ...platformTrialGrantPayload,
          manualAccess: { enabled: true },
        },
      },
      {
        name: "past expiry",
        body: {
          ...platformTrialGrantPayload,
          manualAccess: { enabled: true, expiresAt: pastBillingIsoString() },
        },
      },
    ]

    for (const testCase of cases) {
      const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testCase.body),
      })

      assert.equal(response.status, 400, testCase.name)
      assert.deepEqual(await response.json(), { error: "invalid_manual_access_expires_at" }, testCase.name)
    }
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime billing self-serve routes reject Stripe price ids before calling Stripe", async () => {
  let updateCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      stripeService: runtimeStripeService({
        async updateManagedAiSubscriptionQuantities() {
          updateCalls += 1
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priceId: "price_123",
        quantities: { managedAiBasic: 2, managedAiExtended: 0 },
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "stripe_price_id_not_allowed" })
    assert.equal(updateCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime billing summary sanitizes stored Stripe payment problem messages", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      repository: runtimeRepository({
        async getBillingAccount() {
          return billingAccount({
            paymentProblemCode: "invoice_payment_failed",
            paymentProblemMessage: "Stripe invoice in_1SecretInvoiceId payment failed",
          })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.billing.account.paymentProblem.code, "invoice_payment_failed")
    assert.equal(payload.billing.account.paymentProblem.message, "Payment issue")
    assert.equal(JSON.stringify(payload).includes("in_1SecretInvoiceId"), false)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing update rejects nested Stripe price ids in quantities", async () => {
  let validationCalls = 0
  let upsertCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async assertRequestedQuantitiesCanCoverActiveUsers() {
          validationCalls += 1
        },
        async upsertBillingAccount(input) {
          upsertCalls += 1
          return billingAccount({
            managedAiBasicQuantity: input.managedAiBasicQuantity ?? 2,
            managedAiExtendedQuantity: input.managedAiExtendedQuantity ?? 0,
          })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantities: {
          managedAiBasic: 2,
          managedAiExtended: 0,
          localModels: 0,
          stripePriceId: "price_nested_123",
        },
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "stripe_price_id_not_allowed" })
    assert.equal(validationCalls, 0)
    assert.equal(upsertCalls, 0)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime platform billing quantity updates map active-user guard failures", async () => {
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return platformAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      repository: runtimeRepository({
        async assertRequestedQuantitiesCanCoverActiveUsers() {
          throw new OrganizationBillingRepositoryError("requested_license_limit_below_active_users", {
            requestedLicenseLimit: 1,
            activeUserCount: 2,
          })
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "managed_ai",
        quantities: { managedAiBasic: 1, managedAiExtended: 0, localModels: 0 },
      }),
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: "requested_license_limit_below_active_users",
      details: {
        requestedLicenseLimit: 1,
        activeUserCount: 2,
      },
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime billing checkout records audit events after Stripe session creation", async () => {
  const auditEvents: Array<{ orgId: string; action: string; payload: unknown }> = []
  let checkoutCalls = 0
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      auditEvents,
      stripeService: runtimeStripeService({
        async createManagedAiCheckoutSession(input) {
          checkoutCalls += 1
          assert.deepEqual(input.quantities, { managedAiBasic: 2, managedAiExtended: 0 })
          return { id: "cs_test_runtime", url: "https://stripe.example.test/runtime" }
        },
      }),
    }),
  })

  try {
    const response = await fetch(`${baseUrl}/organizations/org_1/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval: "monthly", quantities: { managedAiBasic: 2, managedAiExtended: 0 } }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      checkout: { id: "cs_test_runtime", url: "https://stripe.example.test/runtime" },
    })
    assert.equal(checkoutCalls, 1)
    assert.equal(auditEvents[0]?.orgId, "org_1")
    assert.equal(auditEvents[0]?.action, "admin.billing.checkout.created")
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("runtime billing checkout and portal pass the request origin for Stripe return URLs", async () => {
  const returnOrigins: Array<string | null | undefined> = []
  const { server, baseUrl } = await listen({
    async getSessionSnapshot() {
      return orgAdminSession()
    },
    ...await runtimeBillingRouteDeps({
      platformAdmin: false,
      stripeService: runtimeStripeService({
        async createManagedAiCheckoutSession(input) {
          returnOrigins.push(input.returnOrigin)
          return { id: "cs_test_runtime", url: "https://stripe.example.test/runtime" }
        },
        async createBillingPortalSession(input) {
          returnOrigins.push(input.returnOrigin)
          return { id: "bps_test_runtime", url: "https://stripe.example.test/portal" }
        },
      }),
    }),
  })

  try {
    const origin = "http://127.0.0.1:8788"
    const checkoutResponse = await fetch(`${baseUrl}/organizations/org_1/billing/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ interval: "monthly", quantities: { managedAiBasic: 2, managedAiExtended: 0 } }),
    })
    assert.equal(checkoutResponse.status, 200)

    const portalResponse = await fetch(`${baseUrl}/organizations/org_1/billing/portal`, {
      method: "POST",
      headers: {
        Origin: origin,
      },
    })
    assert.equal(portalResponse.status, 200)

    assert.deepEqual(returnOrigins, [origin, origin])
  } finally {
    server.close()
    await once(server, "close")
  }
})
