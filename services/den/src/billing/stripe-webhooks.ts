import { randomUUID } from "node:crypto"
import type {
  OrganizationBillingAccountRecord,
  OrganizationBillingEventStatus,
  OrganizationBillingRepository,
  UpsertOrganizationBillingAccountInput,
} from "./repository.js"
import type { OrganizationBillingStatus } from "./organization-billing.js"
import type { OrganizationBillingInterval, StripeOrganizationBillingConfig } from "./stripe-config.js"

export type StripeOrganizationBillingEvent = {
  id?: string
  type?: string
  data?: {
    object?: StripeObject
  }
}

type StripeObject = Record<string, unknown>

export type StripeOrganizationBillingWebhookProcessingResult = {
  ok: boolean
  status: OrganizationBillingEventStatus
  duplicate?: boolean
  errorMessage?: string
}

export type StripeOrganizationBillingWebhookProcessor = {
  processEvent(event: StripeOrganizationBillingEvent): Promise<StripeOrganizationBillingWebhookProcessingResult>
}

export type CreateStripeOrganizationBillingWebhookProcessorInput = {
  config: StripeOrganizationBillingConfig
  repository: OrganizationBillingRepository
  findBillingAccountByStripeSubscriptionId?: (stripeSubscriptionId: string) => Promise<OrganizationBillingAccountRecord | null>
  findBillingAccountByStripeCustomerId?: (stripeCustomerId: string) => Promise<OrganizationBillingAccountRecord | null>
  createBillingEventId?: () => string
  now?: () => Date
}

type WebhookPlan = {
  orgId: string
  status: OrganizationBillingEventStatus
  errorMessage?: string
  apply?: () => Promise<void>
}

const UNKNOWN_ORG_ID = "unknown"
const PROCESSING_NOT_FINALIZED_ERROR = "processing_not_finalized"

export function createStripeOrganizationBillingWebhookProcessor(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
): StripeOrganizationBillingWebhookProcessor {
  const createBillingEventId = input.createBillingEventId ?? (() => `billing_event_${randomUUID()}`)
  const now = input.now ?? (() => new Date())

  return {
    async processEvent(event) {
      const stripeEventId = typeof event.id === "string" && event.id.length > 0 ? event.id : null
      const stripeEventType = typeof event.type === "string" && event.type.length > 0 ? event.type : null
      const object = event.data?.object && isRecord(event.data.object) ? event.data.object : {}
      const plan = stripeEventType
        ? await planStripeEvent(input, stripeEventType, object)
        : failedPlan(resolveOrgIdFromObject(object), "Stripe event type is missing")
      const billingEventId = createBillingEventId()
      const initialStatus = plan.status === "applied" && plan.apply ? "failed" : plan.status
      const initialErrorMessage = initialStatus === "failed" && plan.status === "applied"
        ? PROCESSING_NOT_FINALIZED_ERROR
        : plan.errorMessage ?? null

      const recorded = await input.repository.recordBillingEvent({
        id: billingEventId,
        orgId: plan.orgId,
        stripeEventId,
        stripeEventType,
        status: initialStatus,
        payload: event,
        errorMessage: initialErrorMessage,
        processedAt: now(),
      })

      if (recorded.id !== billingEventId) {
        if (recorded.status === "applied" || recorded.status === "ignored") {
          return {
            ok: true,
            status: recorded.status,
            duplicate: true,
          }
        }
      }

      if (plan.status === "applied" && plan.apply) {
        try {
          await plan.apply()
          await input.repository.updateBillingEvent({
            id: recorded.id,
            status: "applied",
            errorMessage: null,
            processedAt: now(),
          })
          return {
            ok: true,
            status: "applied",
            duplicate: recorded.id !== billingEventId,
          }
        } catch (error) {
          const message = errorMessage(error)
          try {
            await input.repository.updateBillingEvent({
              id: recorded.id,
              status: "failed",
              errorMessage: message,
              processedAt: now(),
            })
          } catch {
            // Keep the original retryable failed event if final failure persistence is unavailable.
          }
          return {
            ok: false,
            status: "failed",
            duplicate: recorded.id !== billingEventId,
            errorMessage: message,
          }
        }
      }

      return {
        ok: plan.status !== "failed",
        status: plan.status,
        errorMessage: plan.errorMessage,
      }
    },
  }
}

async function planStripeEvent(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  stripeEventType: string,
  object: StripeObject,
): Promise<WebhookPlan> {
  switch (stripeEventType) {
    case "checkout.session.completed":
      return planCheckoutSessionCompleted(input, object)
    case "customer.subscription.updated":
      return planSubscriptionUpdated(input, object)
    case "invoice.payment_failed":
      return planInvoicePaymentFailed(input, object)
    case "invoice.payment_succeeded":
      return planInvoicePaymentSucceeded(input, object)
    case "customer.subscription.deleted":
      return planSubscriptionDeleted(input, object)
    default:
      return {
        orgId: resolveOrgIdFromObject(object) ?? UNKNOWN_ORG_ID,
        status: "ignored",
      }
  }
}

function planCheckoutSessionCompleted(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  session: StripeObject,
): WebhookPlan {
  const orgId = resolveOrgIdFromObject(session)
  if (!orgId) {
    return failedPlan(null, "checkout.session.completed is missing metadata.orgId")
  }

  const metadata = readMetadata(session)
  const quantities = quantitiesFromMetadata(metadata)
  const billingInterval = normalizeBillingInterval(metadata.interval)
  return {
    orgId,
    status: "applied",
    apply: () =>
      input.repository.upsertBillingAccount({
        orgId,
        mode: "managed_ai",
        source: "stripe_checkout",
        status: checkoutStatus(session),
        stripeCustomerId: readStripeId(session.customer),
        stripeSubscriptionId: readStripeId(session.subscription),
        billingInterval,
        managedAiBasicQuantity: quantities.managedAiBasic,
        managedAiExtendedQuantity: quantities.managedAiExtended,
        localModelsQuantity: 0,
        manualAccessEnabled: false,
        manualAccessExpiresAt: null,
        paymentProblemCode: null,
        paymentProblemMessage: null,
      }).then(() => undefined),
  }
}

async function planSubscriptionUpdated(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  subscription: StripeObject,
): Promise<WebhookPlan> {
  const resolved = await resolveAccountFromStripeObject(input, subscription)
  if (!resolved) {
    return failedPlan(resolveOrgIdFromObject(subscription), "customer.subscription.updated could not resolve an organization")
  }

  const metadata = readMetadata(subscription)
  const quantities = quantitiesFromSubscriptionItems(input.config, subscription)
  const status = mapStripeSubscriptionStatus(readString(subscription.status))
  const billingInterval = normalizeBillingInterval(metadata.interval) ??
    inferBillingIntervalFromSubscriptionItems(input.config, subscription) ??
    resolved.account?.billingInterval ??
    null
  const shouldActivateStripeSubscription = isActiveStripeSubscriptionStatus(status)
  const isExistingManualTrial =
    resolved.account?.mode === "manual_access" &&
    resolved.account.source === "manual_trial" &&
    resolved.account.manualAccessEnabled

  if (isExistingManualTrial && !shouldActivateStripeSubscription) {
    const update: UpsertOrganizationBillingAccountInput = {
      orgId: resolved.orgId,
      stripeCustomerId: readStripeId(subscription.customer) ?? resolved.account?.stripeCustomerId ?? null,
      stripeSubscriptionId: readStripeId(subscription.id) ?? resolved.account?.stripeSubscriptionId ?? null,
      cancelAtPeriodEnd: readBoolean(subscription.cancel_at_period_end),
    }

    return {
      orgId: resolved.orgId,
      status: "applied",
      apply: () => input.repository.upsertBillingAccount(update).then(() => undefined),
    }
  }

  const update: UpsertOrganizationBillingAccountInput = {
    orgId: resolved.orgId,
    mode: "managed_ai",
    source: "stripe_subscription",
    status,
    stripeCustomerId: readStripeId(subscription.customer) ?? resolved.account?.stripeCustomerId ?? null,
    stripeSubscriptionId: readStripeId(subscription.id) ?? resolved.account?.stripeSubscriptionId ?? null,
    billingInterval,
    managedAiBasicQuantity: quantities.managedAiBasic,
    managedAiExtendedQuantity: quantities.managedAiExtended,
    localModelsQuantity: 0,
    cancelAtPeriodEnd: readBoolean(subscription.cancel_at_period_end),
  }
  if (shouldActivateStripeSubscription) {
    update.manualAccessEnabled = false
    update.manualAccessExpiresAt = null
  }

  return {
    orgId: resolved.orgId,
    status: "applied",
    apply: () => input.repository.upsertBillingAccount(update).then(() => undefined),
  }
}

async function planInvoicePaymentFailed(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  invoice: StripeObject,
): Promise<WebhookPlan> {
  const resolved = await resolveAccountFromStripeObject(input, invoice)
  if (!resolved) {
    return failedPlan(resolveOrgIdFromObject(invoice), "invoice.payment_failed could not resolve an organization")
  }

  const subscription = readInvoiceSubscriptionObject(invoice)
  const subscriptionStatus = subscription ? mapStripeSubscriptionStatus(readString(subscription.status)) : "past_due"
  const status = subscriptionStatus === "active" || subscriptionStatus === "trialing" ? "past_due" : subscriptionStatus
  const invoiceId = readString(invoice.id) ?? "unknown_invoice"
  const stripeSubscriptionId = readStripeId(invoice.subscription) ?? readInvoiceParentSubscriptionId(invoice)
  const isExistingManualTrial =
    resolved.account?.mode === "manual_access" &&
    resolved.account.source === "manual_trial" &&
    resolved.account.manualAccessEnabled
  if (isExistingManualTrial && !isActiveStripeSubscriptionStatus(subscriptionStatus)) {
    return {
      orgId: resolved.orgId,
      status: "applied",
      apply: () =>
        input.repository.upsertBillingAccount({
          orgId: resolved.orgId,
          stripeCustomerId: readStripeId(invoice.customer) ?? resolved.account?.stripeCustomerId ?? null,
          stripeSubscriptionId: stripeSubscriptionId ?? resolved.account?.stripeSubscriptionId ?? null,
          paymentProblemCode: "invoice_payment_failed",
          paymentProblemMessage: `Stripe invoice ${invoiceId} payment failed`,
        }).then(() => undefined),
    }
  }

  return {
    orgId: resolved.orgId,
    status: "applied",
    apply: () =>
      input.repository.upsertBillingAccount({
        orgId: resolved.orgId,
        mode: "managed_ai",
        source: "stripe_invoice",
        status,
        stripeCustomerId: readStripeId(invoice.customer) ?? resolved.account?.stripeCustomerId ?? null,
        stripeSubscriptionId: stripeSubscriptionId ?? resolved.account?.stripeSubscriptionId ?? null,
        manualAccessEnabled: false,
        manualAccessExpiresAt: null,
        paymentProblemCode: "invoice_payment_failed",
        paymentProblemMessage: `Stripe invoice ${invoiceId} payment failed`,
      }).then(() => undefined),
  }
}

async function planInvoicePaymentSucceeded(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  invoice: StripeObject,
): Promise<WebhookPlan> {
  const resolved = await resolveAccountFromStripeObject(input, invoice)
  if (!resolved) {
    return {
      orgId: resolveOrgIdFromObject(invoice) ?? UNKNOWN_ORG_ID,
      status: "ignored",
    }
  }

  const subscription = readObject(invoice.subscription)
  const mappedSubscriptionStatus = subscription ? mapStripeSubscriptionStatus(readString(subscription.status)) : null
  const status = mappedSubscriptionStatus ??
    (isPaymentFailedStatus(resolved.account?.status) ? "active" : resolved.account?.status ?? "active")
  const stripeSubscriptionId = readStripeId(invoice.subscription) ?? readInvoiceParentSubscriptionId(invoice)
  return {
    orgId: resolved.orgId,
    status: "applied",
    apply: () =>
      input.repository.upsertBillingAccount({
        orgId: resolved.orgId,
        mode: "managed_ai",
        source: "stripe_invoice",
        status,
        stripeCustomerId: readStripeId(invoice.customer) ?? resolved.account?.stripeCustomerId ?? null,
        stripeSubscriptionId: stripeSubscriptionId ?? resolved.account?.stripeSubscriptionId ?? null,
        paymentProblemCode: null,
        paymentProblemMessage: null,
      }).then(() => undefined),
  }
}

async function planSubscriptionDeleted(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  subscription: StripeObject,
): Promise<WebhookPlan> {
  const resolved = await resolveAccountFromStripeObject(input, subscription)
  if (!resolved) {
    return failedPlan(resolveOrgIdFromObject(subscription), "customer.subscription.deleted could not resolve an organization")
  }

  return {
    orgId: resolved.orgId,
    status: "applied",
    apply: () =>
      input.repository.upsertBillingAccount({
        orgId: resolved.orgId,
        mode: "managed_ai",
        source: "stripe_subscription",
        status: "canceled",
        stripeCustomerId: readStripeId(subscription.customer) ?? resolved.account?.stripeCustomerId ?? null,
        stripeSubscriptionId: readStripeId(subscription.id) ?? resolved.account?.stripeSubscriptionId ?? null,
        managedAiBasicQuantity: 0,
        managedAiExtendedQuantity: 0,
        localModelsQuantity: 0,
        cancelAtPeriodEnd: false,
      }).then(() => undefined),
  }
}

async function resolveAccountFromStripeObject(
  input: CreateStripeOrganizationBillingWebhookProcessorInput,
  object: StripeObject,
) {
  const orgId = resolveOrgIdFromObject(object)
  if (orgId) {
    return {
      orgId,
      account: await input.repository.getBillingAccount(orgId),
    }
  }

  const stripeSubscriptionId = readStripeId(object.subscription) ??
    readStripeId(readObject(object.subscription)?.id) ??
    readInvoiceParentSubscriptionId(object) ??
    (isStripeSubscriptionId(readStripeId(object.id)) ? readStripeId(object.id) : null)
  const findByStripeSubscriptionId = input.findBillingAccountByStripeSubscriptionId ??
    input.repository.findBillingAccountByStripeSubscriptionId
  if (stripeSubscriptionId && findByStripeSubscriptionId) {
    const account = await findByStripeSubscriptionId(stripeSubscriptionId)
    if (account) {
      return { orgId: account.orgId, account }
    }
  }

  const stripeCustomerId = readStripeId(object.customer)
  const findByStripeCustomerId = input.findBillingAccountByStripeCustomerId ??
    input.repository.findBillingAccountByStripeCustomerId
  if (stripeCustomerId && findByStripeCustomerId) {
    const account = await findByStripeCustomerId(stripeCustomerId)
    if (account) {
      return { orgId: account.orgId, account }
    }
  }

  return null
}

function failedPlan(orgId: string | null | undefined, errorMessage: string): WebhookPlan {
  return {
    orgId: orgId ?? UNKNOWN_ORG_ID,
    status: "failed",
    errorMessage,
  }
}

function checkoutStatus(session: StripeObject): OrganizationBillingStatus {
  const metadataStatus = mapStripeSubscriptionStatus(readMetadata(session).status)
  if (metadataStatus !== "incomplete") {
    return metadataStatus
  }
  if (readString(session.payment_status) === "paid" || readString(session.status) === "complete") {
    return "active"
  }
  return "incomplete"
}

function mapStripeSubscriptionStatus(status: string | null | undefined): OrganizationBillingStatus {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "incomplete":
      return status
    case "incomplete_expired":
      return "canceled"
    default:
      return "incomplete"
  }
}

function isActiveStripeSubscriptionStatus(status: OrganizationBillingStatus) {
  return status === "active" || status === "trialing"
}

function quantitiesFromMetadata(metadata: Record<string, string>) {
  return {
    managedAiBasic: normalizeCount(metadata.managedAiBasicQuantity),
    managedAiExtended: normalizeCount(metadata.managedAiExtendedQuantity),
  }
}

function quantitiesFromSubscriptionItems(
  config: StripeOrganizationBillingConfig,
  subscription: StripeObject,
) {
  const quantities = {
    managedAiBasic: 0,
    managedAiExtended: 0,
  }

  for (const item of readSubscriptionItems(subscription)) {
    const priceId = readString(readObject(item.price)?.id)
    if (!priceId) {
      continue
    }
    if (matchesConfiguredPrice(config, priceId, "basic")) {
      quantities.managedAiBasic += normalizeCount(item.quantity)
    }
    if (matchesConfiguredPrice(config, priceId, "extended")) {
      quantities.managedAiExtended += normalizeCount(item.quantity)
    }
  }

  return quantities
}

function inferBillingIntervalFromSubscriptionItems(
  config: StripeOrganizationBillingConfig,
  subscription: StripeObject,
): OrganizationBillingInterval | null {
  for (const item of readSubscriptionItems(subscription)) {
    const priceId = readString(readObject(item.price)?.id)
    if (!priceId) {
      continue
    }
    for (const interval of ["monthly", "annual"] as const) {
      if (config.prices.basic[interval] === priceId || config.prices.extended[interval] === priceId) {
        return interval
      }
    }
  }
  return null
}

function matchesConfiguredPrice(
  config: StripeOrganizationBillingConfig,
  priceId: string,
  tier: "basic" | "extended",
) {
  return config.prices[tier].monthly === priceId || config.prices[tier].annual === priceId
}

function readSubscriptionItems(subscription: StripeObject) {
  const items = readObject(subscription.items)
  const data = items && Array.isArray(items.data) ? items.data : []
  return data.filter(isRecord)
}

function resolveOrgIdFromObject(object: StripeObject) {
  return readMetadata(object).orgId ??
    readMetadata(readObject(object.subscription) ?? {}).orgId ??
    readMetadata(readObject(readObject(readObject(object.parent)?.subscription_details)?.subscription) ?? {}).orgId ??
    readMetadata(readObject(object.subscription_details) ?? {}).orgId ??
    null
}

function readMetadata(object: StripeObject): Record<string, string> {
  const metadata = readObject(object.metadata)
  if (!metadata) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(metadata)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
  )
}

function normalizeBillingInterval(value: string | null | undefined): OrganizationBillingInterval | null {
  if (value === "monthly" || value === "annual") {
    return value
  }
  return null
}

function readStripeId(value: unknown) {
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id
  }
  return null
}

function readInvoiceParentSubscriptionId(invoice: StripeObject) {
  const parent = readObject(invoice.parent)
  const subscriptionDetails = parent ? readObject(parent.subscription_details) : null
  return subscriptionDetails ? readStripeId(subscriptionDetails.subscription) : null
}

function readInvoiceSubscriptionObject(invoice: StripeObject) {
  return readObject(invoice.subscription) ??
    readObject(readObject(readObject(invoice.parent)?.subscription_details)?.subscription)
}

function isStripeSubscriptionId(value: string | null) {
  return Boolean(value?.startsWith("sub_"))
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null
}

function readBoolean(value: unknown) {
  return value === true
}

function readObject(value: unknown): StripeObject | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is StripeObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeCount(value: unknown) {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0
  if (!Number.isFinite(numberValue)) {
    return 0
  }
  return Math.max(0, Math.trunc(numberValue))
}

function isPaymentFailedStatus(status: OrganizationBillingStatus | null | undefined) {
  return status === "past_due" || status === "unpaid" || status === "incomplete"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
