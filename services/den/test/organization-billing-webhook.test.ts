import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import {
  createOrganizationBillingRepository,
  type OrganizationBillingAccountRecord,
  type OrganizationBillingDataStore,
  type OrganizationBillingEventRecord,
} from "../src/billing/repository.js"
import type { StripeOrganizationBillingConfig } from "../src/billing/stripe-config.js"
import {
  createStripeOrganizationBillingWebhookProcessor,
  type StripeOrganizationBillingWebhookProcessor,
} from "../src/billing/stripe-webhooks.js"
import { createOrganizationBillingWebhookRouter } from "../src/http/organization-billing-webhook.js"

const enabledConfig: StripeOrganizationBillingConfig = {
  enabled: true,
  secretKey: "sk_test_not_used",
  webhookSecret: "whsec_test_secret",
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

function createBillingEvent(input: Partial<OrganizationBillingEventRecord> = {}): OrganizationBillingEventRecord {
  const now = new Date("2026-06-23T12:00:00.000Z")
  return {
    id: "billing_event_existing",
    orgId: "org_1",
    stripeEventId: "evt_existing",
    stripeEventType: "checkout.session.completed",
    status: "failed",
    payload: checkoutCompletedEvent("evt_existing"),
    errorMessage: "processing did not complete",
    createdAt: now,
    processedAt: now,
    ...input,
  }
}

function createMemoryBillingHarness(input: {
  accounts?: OrganizationBillingAccountRecord[]
  events?: OrganizationBillingEventRecord[]
  rejectUpsert?: Error
} = {}) {
  const accounts = [...(input.accounts ?? [])]
  const events = [...(input.events ?? [])]
  const upserts: OrganizationBillingAccountRecord[] = []
  const eventInserts: OrganizationBillingEventRecord[] = []
  const now = new Date("2026-06-23T12:00:00.000Z")
  let nextId = 1

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
      upserts.push(record)
      if (input.rejectUpsert) {
        throw input.rejectUpsert
      }
      const existingIndex = accounts.findIndex((entry) => entry.orgId === record.orgId)
      if (existingIndex >= 0) {
        accounts[existingIndex] = record
      } else {
        accounts.push(record)
      }
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
      if (record.stripeEventId) {
        const existing = events.find((entry) => entry.stripeEventId === record.stripeEventId)
        if (existing) {
          return existing
        }
      }
      events.push(record)
      eventInserts.push(record)
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

  const repository = createOrganizationBillingRepository(store, {
    createId: (prefix) => `${prefix}_${nextId++}`,
    now: () => now,
  })

  return {
    accounts,
    events,
    upserts,
    eventInserts,
    repository,
    findBillingAccountByStripeSubscriptionId: async (stripeSubscriptionId: string) =>
      accounts.find((entry) => entry.stripeSubscriptionId === stripeSubscriptionId) ?? null,
    findBillingAccountByStripeCustomerId: async (stripeCustomerId: string) =>
      accounts.find((entry) => entry.stripeCustomerId === stripeCustomerId) ?? null,
  }
}

function createProcessor(input: ReturnType<typeof createMemoryBillingHarness>) {
  return createStripeOrganizationBillingWebhookProcessor({
    config: enabledConfig,
    repository: input.repository,
    findBillingAccountByStripeSubscriptionId: input.findBillingAccountByStripeSubscriptionId,
    findBillingAccountByStripeCustomerId: input.findBillingAccountByStripeCustomerId,
  })
}

async function postWebhook(app: express.Express, event: unknown, signature = "valid_signature") {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    return await fetch(`http://127.0.0.1:${port}/v1/organization-billing/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body: JSON.stringify(event),
    })
  } finally {
    server.close()
    await once(server, "close")
  }
}

function createWebhookApp(input: {
  processor: StripeOrganizationBillingWebhookProcessor
  verifyEvent?: (payload: Buffer, signature: string, webhookSecret: string) => unknown
}) {
  const app = express()
  app.use(
    createOrganizationBillingWebhookRouter({
      config: enabledConfig,
      processor: input.processor,
      verifyEvent: input.verifyEvent ?? ((payload) => JSON.parse(payload.toString("utf8"))),
    }),
  )
  app.use(express.json())
  return app
}

function createWebhookAppWithRepository(input: {
  repository: ReturnType<typeof createMemoryBillingHarness>["repository"]
  verifyEvent?: (payload: Buffer, signature: string, webhookSecret: string) => unknown
}) {
  const app = express()
  app.use(
    createOrganizationBillingWebhookRouter({
      config: enabledConfig,
      repository: input.repository,
      verifyEvent: input.verifyEvent ?? ((payload) => JSON.parse(payload.toString("utf8"))),
    }),
  )
  app.use(express.json())
  return app
}

function checkoutCompletedEvent(id = "evt_checkout_1") {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_123",
        customer: "cus_123",
        subscription: "sub_123",
        payment_status: "paid",
        metadata: {
          orgId: "org_1",
          interval: "annual",
          managedAiBasicQuantity: "2",
          managedAiExtendedQuantity: "1",
        },
      },
    },
  }
}

function subscriptionUpdatedEvent(id = "evt_subscription_1") {
  return {
    id,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "past_due",
        cancel_at_period_end: true,
        metadata: {},
        items: {
          data: [
            { id: "si_basic", price: { id: "price_basic_annual" }, quantity: 3 },
            { id: "si_extended", price: { id: "price_extended_annual" }, quantity: 2 },
          ],
        },
      },
    },
  }
}

function invoicePaymentFailedEvent(id = "evt_invoice_failed_1") {
  return {
    id,
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_failed_1",
        customer: "cus_123",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_123",
          },
        },
        status: "open",
        hosted_invoice_url: "https://invoice.stripe.test/in_failed_1",
        metadata: {},
      },
    },
  }
}

function invoicePaymentSucceededEvent(id = "evt_invoice_succeeded_1") {
  return {
    id,
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: "in_succeeded_1",
        customer: "cus_123",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_123",
          },
        },
        status: "paid",
        metadata: {},
      },
    },
  }
}

function subscriptionDeletedEvent(id = "evt_subscription_deleted_1") {
  return {
    id,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "canceled",
        cancel_at_period_end: false,
        metadata: {},
      },
    },
  }
}

test("invalid signature returns 400 and does not call processor or repository business changes", async () => {
  const harness = createMemoryBillingHarness()
  let processCalls = 0
  const app = createWebhookApp({
    processor: {
      async processEvent() {
        processCalls += 1
        assert.fail("processor should not receive invalid Stripe events")
      },
    },
    verifyEvent() {
      throw new Error("invalid signature")
    },
  })

  const response = await postWebhook(app, checkoutCompletedEvent(), "invalid_signature")

  assert.equal(response.status, 400)
  assert.equal(processCalls, 0)
  assert.equal(harness.upserts.length, 0)
  assert.equal(harness.eventInserts.length, 0)
})

test("duplicate Stripe event id is idempotent and does not apply the same mutation twice", async () => {
  const harness = createMemoryBillingHarness()
  const processor = createProcessor(harness)

  assert.equal((await processor.processEvent(checkoutCompletedEvent("evt_duplicate"))).ok, true)
  assert.equal((await processor.processEvent(checkoutCompletedEvent("evt_duplicate"))).ok, true)

  assert.equal(harness.eventInserts.length, 1)
  assert.equal(harness.upserts.length, 1)
  assert.equal(harness.accounts[0]?.stripeSubscriptionId, "sub_123")
})

test("duplicate pre-final failed event is retried instead of false-success skipped", async () => {
  const event = checkoutCompletedEvent("evt_retry_failed")
  const harness = createMemoryBillingHarness({
    events: [
      createBillingEvent({
        id: "billing_event_retry",
        stripeEventId: "evt_retry_failed",
        stripeEventType: "checkout.session.completed",
        status: "failed",
        payload: event,
      }),
    ],
  })
  const processor = createProcessor(harness)

  const result = await processor.processEvent(event)

  assert.equal(result.ok, true)
  assert.equal(result.duplicate, true)
  assert.equal(harness.upserts.length, 1)
  assert.equal(harness.events.length, 1)
  assert.equal(harness.events[0]?.status, "applied")
  assert.equal(harness.events[0]?.errorMessage, null)
  assert.equal(harness.accounts[0]?.stripeSubscriptionId, "sub_123")
})

test("checkout.session.completed links customer and subscription to org and stores metadata quantities and interval", async () => {
  const harness = createMemoryBillingHarness()
  const result = await createProcessor(harness).processEvent(checkoutCompletedEvent())

  assert.equal(result.ok, true)
  assert.equal(harness.eventInserts[0]?.status, "applied")
  assert.deepEqual(harness.accounts[0], {
    ...createBillingAccount({
      source: "stripe_checkout",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      billingInterval: "annual",
      managedAiBasicQuantity: 2,
      managedAiExtendedQuantity: 1,
    }),
  })
})

test("customer.subscription.updated updates status, quantities, interval, and cancel-at-period-end", async () => {
  const existing = createBillingAccount({ billingInterval: "monthly", managedAiBasicQuantity: 1 })
  const harness = createMemoryBillingHarness({ accounts: [existing] })
  const result = await createProcessor(harness).processEvent(subscriptionUpdatedEvent())

  assert.equal(result.ok, true)
  assert.equal(harness.eventInserts[0]?.status, "applied")
  assert.equal(harness.accounts[0]?.status, "past_due")
  assert.equal(harness.accounts[0]?.source, "stripe_subscription")
  assert.equal(harness.accounts[0]?.billingInterval, "annual")
  assert.equal(harness.accounts[0]?.managedAiBasicQuantity, 3)
  assert.equal(harness.accounts[0]?.managedAiExtendedQuantity, 2)
  assert.equal(harness.accounts[0]?.cancelAtPeriodEnd, true)
})

test("invoice.payment_failed stores payment problem state", async () => {
  const harness = createMemoryBillingHarness({ accounts: [createBillingAccount()] })
  const result = await createProcessor(harness).processEvent(invoicePaymentFailedEvent())

  assert.equal(result.ok, true)
  assert.equal(harness.eventInserts[0]?.status, "applied")
  assert.equal(harness.accounts[0]?.status, "past_due")
  assert.equal(harness.accounts[0]?.source, "stripe_invoice")
  assert.equal(harness.accounts[0]?.paymentProblemCode, "invoice_payment_failed")
  assert.match(harness.accounts[0]?.paymentProblemMessage ?? "", /in_failed_1/)
})

test("invoice.payment_succeeded clears payment problem state", async () => {
  const harness = createMemoryBillingHarness({
    accounts: [
      createBillingAccount({
        status: "past_due",
        paymentProblemCode: "invoice_payment_failed",
        paymentProblemMessage: "Invoice in_failed_1 payment failed",
      }),
    ],
  })
  const result = await createProcessor(harness).processEvent(invoicePaymentSucceededEvent())

  assert.equal(result.ok, true)
  assert.equal(harness.eventInserts[0]?.status, "applied")
  assert.equal(harness.accounts[0]?.status, "active")
  assert.equal(harness.accounts[0]?.source, "stripe_invoice")
  assert.equal(harness.accounts[0]?.paymentProblemCode, null)
  assert.equal(harness.accounts[0]?.paymentProblemMessage, null)
})

test("invoice.payment_succeeded before checkout is ignored instead of failing when the org is not resolvable yet", async () => {
  const harness = createMemoryBillingHarness()
  const processor = createProcessor(harness)

  const invoiceResult = await processor.processEvent(invoicePaymentSucceededEvent("evt_invoice_before_checkout"))

  assert.equal(invoiceResult.ok, true)
  assert.equal(invoiceResult.status, "ignored")
  assert.equal(harness.eventInserts[0]?.status, "ignored")
  assert.equal(harness.accounts.length, 0)

  const checkoutResult = await processor.processEvent(checkoutCompletedEvent("evt_checkout_after_invoice"))

  assert.equal(checkoutResult.ok, true)
  assert.equal(harness.accounts[0]?.status, "active")
  assert.equal(harness.accounts[0]?.stripeSubscriptionId, "sub_123")
})

test("default webhook processor resolves subscription updates by Stripe customer id", async () => {
  const harness = createMemoryBillingHarness({
    accounts: [createBillingAccount({ stripeSubscriptionId: "sub_old", stripeCustomerId: "cus_123" })],
  })
  const app = createWebhookAppWithRepository({ repository: harness.repository })

  const response = await postWebhook(app, {
    id: "evt_default_customer_fallback",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_new",
        customer: "cus_123",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [
            { id: "si_basic", price: { id: "price_basic_monthly" }, quantity: 2 },
          ],
        },
      },
    },
  })

  assert.equal(response.status, 200)
  assert.equal(harness.accounts[0]?.stripeSubscriptionId, "sub_new")
  assert.equal(harness.accounts[0]?.managedAiBasicQuantity, 2)
})

test("default webhook processor resolves invoice parent subscription details by Stripe subscription id", async () => {
  const harness = createMemoryBillingHarness({
    accounts: [createBillingAccount({ stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" })],
  })
  const app = createWebhookAppWithRepository({ repository: harness.repository })

  const response = await postWebhook(app, {
    id: "evt_parent_subscription_invoice",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_parent_subscription",
        customer: "cus_unknown",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_123",
          },
        },
        status: "open",
        metadata: {},
      },
    },
  })

  assert.equal(response.status, 200)
  assert.equal(harness.accounts[0]?.source, "stripe_invoice")
  assert.equal(harness.accounts[0]?.status, "past_due")
  assert.equal(harness.accounts[0]?.paymentProblemCode, "invoice_payment_failed")
})

test("customer.subscription.deleted removes active Managed AI entitlement by canceling and zeroing quantities", async () => {
  const harness = createMemoryBillingHarness({
    accounts: [createBillingAccount({ managedAiBasicQuantity: 4, managedAiExtendedQuantity: 2, cancelAtPeriodEnd: true })],
  })
  const result = await createProcessor(harness).processEvent(subscriptionDeletedEvent())

  assert.equal(result.ok, true)
  assert.equal(harness.eventInserts[0]?.status, "applied")
  assert.equal(harness.accounts[0]?.status, "canceled")
  assert.equal(harness.accounts[0]?.source, "stripe_subscription")
  assert.equal(harness.accounts[0]?.managedAiBasicQuantity, 0)
  assert.equal(harness.accounts[0]?.managedAiExtendedQuantity, 0)
  assert.equal(harness.accounts[0]?.cancelAtPeriodEnd, false)
})

test("unknown event type is recorded as ignored and returns 200", async () => {
  const harness = createMemoryBillingHarness()
  const processor = createProcessor(harness)
  const app = createWebhookApp({ processor })

  const response = await postWebhook(app, {
    id: "evt_unknown_1",
    type: "customer.updated",
    data: {
      object: {
        id: "cus_123",
        metadata: { orgId: "org_1" },
      },
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, status: "ignored" })
  assert.equal(harness.eventInserts.length, 1)
  assert.equal(harness.eventInserts[0]?.status, "ignored")
  assert.equal(harness.upserts.length, 0)
})

test("known apply failure records a failed event with the error and route returns non-2xx", async () => {
  const harness = createMemoryBillingHarness({
    rejectUpsert: new Error("database write failed"),
  })
  const processor = createProcessor(harness)
  const app = createWebhookApp({ processor })

  const response = await postWebhook(app, checkoutCompletedEvent("evt_apply_failure_1"))

  assert.equal(response.status, 500)
  assert.equal(harness.eventInserts.length, 1)
  assert.equal(harness.eventInserts[0]?.stripeEventId, "evt_apply_failure_1")
  assert.equal(harness.eventInserts[0]?.status, "failed")
  assert.equal(harness.eventInserts[0]?.errorMessage, "database write failed")
})

test("route verifier receives raw request bytes before parsed JSON", async () => {
  const harness = createMemoryBillingHarness()
  let verifierReceivedBuffer = false
  let verifierReceivedRawJson = false
  const app = createWebhookApp({
    processor: createProcessor(harness),
    verifyEvent(payload) {
      verifierReceivedBuffer = Buffer.isBuffer(payload)
      verifierReceivedRawJson = payload.toString("utf8").includes("\"checkout.session.completed\"")
      return JSON.parse(payload.toString("utf8"))
    },
  })

  const response = await postWebhook(app, checkoutCompletedEvent("evt_raw_body_1"))

  assert.equal(response.status, 200)
  assert.equal(verifierReceivedBuffer, true)
  assert.equal(verifierReceivedRawJson, true)
})
