import assert from "node:assert/strict"
import test from "node:test"
import { OrganizationBillingRepositoryError, type OrganizationBillingAccountRecord, type OrganizationBillingRepository } from "../src/billing/repository.js"
import { createOrganizationStripeBillingService, OrganizationStripeBillingServiceError, type OrganizationStripeBillingClient } from "../src/billing/stripe-service.js"
import type { StripeOrganizationBillingConfig } from "../src/billing/stripe-config.js"

const enabledConfig: StripeOrganizationBillingConfig = {
  enabled: true,
  secretKey: "sk_test_not_used",
  webhookSecret: "whsec_not_used",
  successUrl: "https://den.example.test/billing/success",
  cancelUrl: "https://den.example.test/billing/cancel",
  portalReturnUrl: "https://den.example.test/admin/billing",
  taxMode: "manual",
  prices: {
    basic: {
      monthly: "price_basic_monthly",
      annual: "price_basic_annual",
    },
    extended: {
      monthly: "price_extended_monthly",
      annual: "price_extended_annual",
    },
  },
}

function assertServiceErrorCode(error: unknown, code: OrganizationStripeBillingServiceError["code"]) {
  assert.ok(error instanceof OrganizationStripeBillingServiceError)
  assert.equal(error.code, code)
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

function createFakeStripeClient(input: {
  subscriptionItems?: Array<{ id: string; price: { id: string }; quantity?: number | null }>
} = {}) {
  const checkoutSessions: unknown[] = []
  const portalSessions: unknown[] = []
  const subscriptionUpdates: Array<{ id: string; params: unknown }> = []
  const subscriptionRetrieves: string[] = []
  const subscription = {
    id: "sub_123",
    items: {
      data: input.subscriptionItems ?? [
        { id: "si_basic", price: { id: "price_basic_monthly" }, quantity: 1 },
        { id: "si_extended", price: { id: "price_extended_monthly" }, quantity: 0 },
      ],
    },
  }

  const stripe: OrganizationStripeBillingClient = {
    checkout: {
      sessions: {
        async create(params) {
          checkoutSessions.push(params)
          return { id: "cs_123", url: "https://checkout.stripe.test/session/cs_123" }
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          portalSessions.push(params)
          return { id: "bps_123", url: "https://billing.stripe.test/session/bps_123" }
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        subscriptionRetrieves.push(id)
        return subscription
      },
      async update(id, params) {
        subscriptionUpdates.push({ id, params })
        return { id, ...params }
      },
    },
  }

  return { stripe, checkoutSessions, portalSessions, subscriptionUpdates, subscriptionRetrieves, subscription }
}

function createFakeRepository(input: {
  account?: OrganizationBillingAccountRecord | null
  allowedTiers?: Array<{ tier: string; enabled: boolean }>
  rejectQuantityValidation?: boolean
} = {}) {
  const calls = {
    assertRequestedQuantitiesCanCoverActiveUsers: [] as unknown[],
    listAllowedTiers: [] as string[],
    getBillingAccount: [] as string[],
  }

  const repository = {
    async getBillingAccount(orgId) {
      calls.getBillingAccount.push(orgId)
      return input.account === undefined ? createBillingAccount({ orgId }) : input.account
    },
    async listAllowedTiers(orgId) {
      calls.listAllowedTiers.push(orgId)
      return (input.allowedTiers ?? []).map((entry, index) => ({
        id: `tier_${index + 1}`,
        orgId,
        tier: entry.tier,
        enabled: entry.enabled,
        createdAt: new Date("2026-06-23T12:00:00.000Z"),
        updatedAt: new Date("2026-06-23T12:00:00.000Z"),
      }))
    },
    async assertRequestedQuantitiesCanCoverActiveUsers(validationInput) {
      calls.assertRequestedQuantitiesCanCoverActiveUsers.push(validationInput)
      if (input.rejectQuantityValidation) {
        throw new OrganizationBillingRepositoryError("requested_license_limit_below_active_users", {
          requestedLicenseLimit: 1,
          activeUserCount: 2,
        })
      }
    },
  } satisfies Partial<OrganizationBillingRepository>

  return { repository: repository as OrganizationBillingRepository, calls }
}

test("checkout creates a managed-ai subscription session with configured prices and metadata", async () => {
  const fakeStripe = createFakeStripeClient()
  const { repository, calls } = createFakeRepository()
  const service = createOrganizationStripeBillingService({
    config: { ...enabledConfig, taxMode: "stripe_tax" },
    repository,
    stripe: fakeStripe.stripe,
  })

  const session = await service.createManagedAiCheckoutSession({
    orgId: "org_1",
    actorUserId: "user_1",
    interval: "monthly",
    quantities: {
      managedAiBasic: 2,
      managedAiExtended: 1,
    },
  })

  assert.deepEqual(session, {
    id: "cs_123",
    url: "https://checkout.stripe.test/session/cs_123",
  })
  assert.equal(fakeStripe.checkoutSessions.length, 1)
  assert.deepEqual(fakeStripe.checkoutSessions[0], {
    mode: "subscription",
    success_url: "https://den.example.test/billing/success",
    cancel_url: "https://den.example.test/billing/cancel",
    line_items: [
      { price: "price_basic_monthly", quantity: 2 },
      { price: "price_extended_monthly", quantity: 1 },
    ],
    automatic_tax: { enabled: true },
    metadata: {
      orgId: "org_1",
      actorUserId: "user_1",
      billingMode: "managed_ai",
      interval: "monthly",
      managedAiBasicQuantity: "2",
      managedAiExtendedQuantity: "1",
    },
    subscription_data: {
      metadata: {
        orgId: "org_1",
        actorUserId: "user_1",
        billingMode: "managed_ai",
        interval: "monthly",
        managedAiBasicQuantity: "2",
        managedAiExtendedQuantity: "1",
      },
    },
  })
  assert.deepEqual(calls.assertRequestedQuantitiesCanCoverActiveUsers, [
    {
      orgId: "org_1",
      mode: "managed_ai",
      quantities: {
        managedAiBasic: 2,
        managedAiExtended: 1,
        localModels: 0,
      },
    },
  ])
})

test("checkout preserves a trusted local request origin in Stripe return URLs", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: {
      ...enabledConfig,
      successUrl: "http://localhost:8788/admin/billing/organization?checkout=success",
      cancelUrl: "http://localhost:8788/admin/billing/organization?checkout=cancel",
    },
    repository: createFakeRepository().repository,
    stripe: fakeStripe.stripe,
  })

  await service.createManagedAiCheckoutSession({
    orgId: "org_1",
    actorUserId: "user_1",
    interval: "monthly",
    quantities: {
      managedAiBasic: 2,
      managedAiExtended: 0,
    },
    returnOrigin: "http://127.0.0.1:8788",
  })

  assert.equal(fakeStripe.checkoutSessions.length, 1)
  assert.deepEqual(fakeStripe.checkoutSessions[0], {
    mode: "subscription",
    success_url: "http://127.0.0.1:8788/admin/billing/organization?checkout=success",
    cancel_url: "http://127.0.0.1:8788/admin/billing/organization?checkout=cancel",
    line_items: [
      { price: "price_basic_monthly", quantity: 2 },
    ],
    automatic_tax: { enabled: false },
    metadata: {
      orgId: "org_1",
      actorUserId: "user_1",
      billingMode: "managed_ai",
      interval: "monthly",
      managedAiBasicQuantity: "2",
      managedAiExtendedQuantity: "0",
    },
    subscription_data: {
      metadata: {
        orgId: "org_1",
        actorUserId: "user_1",
        billingMode: "managed_ai",
        interval: "monthly",
        managedAiBasicQuantity: "2",
        managedAiExtendedQuantity: "0",
      },
    },
  })
})

test("checkout rejects requested managed-ai seats below active users before calling Stripe", async () => {
  const fakeStripe = createFakeStripeClient()
  const { repository } = createFakeRepository({ rejectQuantityValidation: true })
  const service = createOrganizationStripeBillingService({ config: enabledConfig, repository, stripe: fakeStripe.stripe })

  await assert.rejects(
    service.createManagedAiCheckoutSession({
      orgId: "org_1",
      actorUserId: "user_1",
      interval: "monthly",
      quantities: {
        managedAiBasic: 1,
        managedAiExtended: 0,
      },
    }),
    (error) => {
      assert.ok(error instanceof OrganizationBillingRepositoryError)
      assert.equal(error.code, "requested_license_limit_below_active_users")
      return true
    },
  )

  assert.equal(fakeStripe.checkoutSessions.length, 0)
})

test("checkout rejects a disabled managed-ai tier before calling Stripe", async () => {
  const fakeStripe = createFakeStripeClient()
  const { repository } = createFakeRepository({
    allowedTiers: [{ tier: "managed_ai_extended", enabled: false }],
  })
  const service = createOrganizationStripeBillingService({ config: enabledConfig, repository, stripe: fakeStripe.stripe })

  await assert.rejects(
    service.createManagedAiCheckoutSession({
      orgId: "org_1",
      actorUserId: "user_1",
      interval: "monthly",
      quantities: {
        managedAiBasic: 0,
        managedAiExtended: 1,
      },
    }),
    (error) => {
      assertServiceErrorCode(error, "tier_not_allowed")
      return true
    },
  )

  assert.equal(fakeStripe.checkoutSessions.length, 0)
})

test("portal session requires a Stripe customer and creates a customer portal session", async () => {
  const fakeStripe = createFakeStripeClient()
  const missingCustomerRepository = createFakeRepository({
    account: createBillingAccount({ stripeCustomerId: null }),
  }).repository
  const missingCustomerService = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: missingCustomerRepository,
    stripe: fakeStripe.stripe,
  })

  await assert.rejects(
    missingCustomerService.createBillingPortalSession({ orgId: "org_1", actorUserId: "user_1" }),
    (error) => {
      assertServiceErrorCode(error, "stripe_customer_required")
      return true
    },
  )
  assert.equal(fakeStripe.portalSessions.length, 0)

  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository().repository,
    stripe: fakeStripe.stripe,
  })
  const session = await service.createBillingPortalSession({ orgId: "org_1", actorUserId: "user_1" })

  assert.deepEqual(session, {
    id: "bps_123",
    url: "https://billing.stripe.test/session/bps_123",
  })
  assert.deepEqual(fakeStripe.portalSessions[0], {
    customer: "cus_123",
    return_url: "https://den.example.test/admin/billing",
  })
})

test("portal preserves a trusted local request origin in Stripe return URL", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: {
      ...enabledConfig,
      portalReturnUrl: "http://localhost:8788/admin/billing/organization",
    },
    repository: createFakeRepository().repository,
    stripe: fakeStripe.stripe,
  })

  await service.createBillingPortalSession({
    orgId: "org_1",
    actorUserId: "user_1",
    returnOrigin: "http://127.0.0.1:8788",
  })

  assert.deepEqual(fakeStripe.portalSessions[0], {
    customer: "cus_123",
    return_url: "http://127.0.0.1:8788/admin/billing/organization",
  })
})

test("adding managed-ai seats updates subscription quantities with immediate proration", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({
      account: createBillingAccount({ managedAiBasicQuantity: 1, managedAiExtendedQuantity: 0 }),
    }).repository,
    stripe: fakeStripe.stripe,
  })

  await service.updateManagedAiSubscriptionQuantities({
    orgId: "org_1",
    actorUserId: "user_1",
    quantities: {
      managedAiBasic: 2,
      managedAiExtended: 1,
    },
  })

  assert.deepEqual(fakeStripe.subscriptionRetrieves, ["sub_123"])
  assert.deepEqual(fakeStripe.subscriptionUpdates, [
    {
      id: "sub_123",
      params: {
        proration_behavior: "always_invoice",
        items: [
          { id: "si_basic", quantity: 2 },
          { id: "si_extended", quantity: 1 },
        ],
        metadata: {
          orgId: "org_1",
          actorUserId: "user_1",
          billingMode: "managed_ai",
          interval: "monthly",
          managedAiBasicQuantity: "2",
          managedAiExtendedQuantity: "1",
        },
      },
    },
  ])
})

test("adding seats uses Stripe subscription item quantities even when the local account is stale", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({
      account: createBillingAccount({ managedAiBasicQuantity: 5, managedAiExtendedQuantity: 0 }),
    }).repository,
    stripe: fakeStripe.stripe,
  })

  await service.updateManagedAiSubscriptionQuantities({
    orgId: "org_1",
    actorUserId: "user_1",
    quantities: {
      managedAiBasic: 2,
      managedAiExtended: 0,
    },
  })

  assert.equal(fakeStripe.subscriptionUpdates.length, 1)
  assert.deepEqual(fakeStripe.subscriptionUpdates[0], {
    id: "sub_123",
    params: {
      proration_behavior: "always_invoice",
      items: [
        { id: "si_basic", quantity: 2 },
        { id: "si_extended", quantity: 0 },
      ],
      metadata: {
        orgId: "org_1",
        actorUserId: "user_1",
        billingMode: "managed_ai",
        interval: "monthly",
        managedAiBasicQuantity: "2",
        managedAiExtendedQuantity: "0",
      },
    },
  })
})

test("adding a missing managed-ai tier creates a new Stripe subscription item", async () => {
  const fakeStripe = createFakeStripeClient({
    subscriptionItems: [
      { id: "si_basic", price: { id: "price_basic_monthly" }, quantity: 2 },
    ],
  })
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({
      account: createBillingAccount({ managedAiBasicQuantity: 2, managedAiExtendedQuantity: 0 }),
    }).repository,
    stripe: fakeStripe.stripe,
  })

  await service.updateManagedAiSubscriptionQuantities({
    orgId: "org_1",
    actorUserId: "user_1",
    quantities: {
      managedAiBasic: 2,
      managedAiExtended: 1,
    },
  })

  assert.deepEqual(fakeStripe.subscriptionUpdates, [
    {
      id: "sub_123",
      params: {
        proration_behavior: "always_invoice",
        items: [
          { id: "si_basic", quantity: 2 },
          { price: "price_extended_monthly", quantity: 1 },
        ],
        metadata: {
          orgId: "org_1",
          actorUserId: "user_1",
          billingMode: "managed_ai",
          interval: "monthly",
          managedAiBasicQuantity: "2",
          managedAiExtendedQuantity: "1",
        },
      },
    },
  ])
})

test("quantity update rejects disabled managed-ai tiers before calling Stripe", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({
      allowedTiers: [{ tier: "managed_ai_extended", enabled: false }],
    }).repository,
    stripe: fakeStripe.stripe,
  })

  await assert.rejects(
    service.updateManagedAiSubscriptionQuantities({
      orgId: "org_1",
      actorUserId: "user_1",
      quantities: {
        managedAiBasic: 0,
        managedAiExtended: 1,
      },
    }),
    (error) => {
      assertServiceErrorCode(error, "tier_not_allowed")
      return true
    },
  )

  assert.deepEqual(fakeStripe.subscriptionRetrieves, [])
  assert.deepEqual(fakeStripe.subscriptionUpdates, [])
})

test("reducing managed-ai seats uses no proration and rejects reductions below active users", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({
      account: createBillingAccount({ managedAiBasicQuantity: 2, managedAiExtendedQuantity: 1 }),
    }).repository,
    stripe: fakeStripe.stripe,
  })

  await service.updateManagedAiSubscriptionQuantities({
    orgId: "org_1",
    actorUserId: "user_1",
    quantities: {
      managedAiBasic: 1,
      managedAiExtended: 0,
    },
  })

  assert.equal(fakeStripe.subscriptionUpdates.length, 1)
  assert.deepEqual(fakeStripe.subscriptionUpdates[0], {
    id: "sub_123",
    params: {
      proration_behavior: "none",
      items: [
        { id: "si_basic", quantity: 1 },
        { id: "si_extended", quantity: 0 },
      ],
      metadata: {
        orgId: "org_1",
        actorUserId: "user_1",
        billingMode: "managed_ai",
        interval: "monthly",
        managedAiBasicQuantity: "1",
        managedAiExtendedQuantity: "0",
      },
    },
  })

  const rejectingStripe = createFakeStripeClient()
  const rejectingService = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository({ rejectQuantityValidation: true }).repository,
    stripe: rejectingStripe.stripe,
  })
  await assert.rejects(
    rejectingService.updateManagedAiSubscriptionQuantities({
      orgId: "org_1",
      actorUserId: "user_1",
      quantities: {
        managedAiBasic: 1,
        managedAiExtended: 0,
      },
    }),
    (error) => {
      assert.ok(error instanceof OrganizationBillingRepositoryError)
      assert.equal(error.code, "requested_license_limit_below_active_users")
      return true
    },
  )
  assert.equal(rejectingStripe.subscriptionUpdates.length, 0)
})

test("cancellation sets cancel_at_period_end on the Stripe subscription", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository().repository,
    stripe: fakeStripe.stripe,
  })

  await service.cancelManagedAiSubscriptionAtPeriodEnd({ orgId: "org_1", actorUserId: "user_1" })

  assert.deepEqual(fakeStripe.subscriptionUpdates, [
    {
      id: "sub_123",
      params: {
        cancel_at_period_end: true,
        metadata: {
          orgId: "org_1",
          actorUserId: "user_1",
          billingMode: "managed_ai",
        },
      },
    },
  ])
})

test("local-models Stripe hook is platform-admin only and returns not configured", async () => {
  const fakeStripe = createFakeStripeClient()
  const service = createOrganizationStripeBillingService({
    config: enabledConfig,
    repository: createFakeRepository().repository,
    stripe: fakeStripe.stripe,
  })

  await assert.rejects(
    service.createLocalModelsStripeInvoiceOrSubscription({
      orgId: "org_1",
      actorUserId: "user_1",
      platformAdmin: false,
      quantity: 3,
    }),
    (error) => {
      assertServiceErrorCode(error, "platform_admin_required")
      return true
    },
  )

  assert.deepEqual(
    await service.createLocalModelsStripeInvoiceOrSubscription({
      orgId: "org_1",
      actorUserId: "admin_1",
      platformAdmin: true,
      quantity: 3,
    }),
    {
      status: "not_configured",
      orgId: "org_1",
      billingMode: "local_models",
    },
  )
  assert.equal(fakeStripe.checkoutSessions.length, 0)
  assert.equal(fakeStripe.subscriptionUpdates.length, 0)
})
