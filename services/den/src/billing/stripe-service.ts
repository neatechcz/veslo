import type { OrganizationBillingRepository } from "./repository.js"
import {
  resolveStripePriceId,
  type OrganizationBillingInterval,
  type StripeOrganizationBillingConfig,
} from "./stripe-config.js"
import type {
  OrganizationStripeBillingClient,
  OrganizationStripeBillingMetadata,
  OrganizationStripeSubscription,
} from "./stripe.js"
export type { OrganizationStripeBillingClient } from "./stripe.js"

export type ManagedAiBillingQuantities = {
  managedAiBasic: number
  managedAiExtended: number
}

export type OrganizationStripeBillingServiceErrorCode =
  | "stripe_billing_disabled"
  | "tier_not_allowed"
  | "stripe_customer_required"
  | "stripe_subscription_required"
  | "stripe_subscription_item_required"
  | "managed_ai_quantity_required"
  | "platform_admin_required"

export class OrganizationStripeBillingServiceError extends Error {
  constructor(
    readonly code: OrganizationStripeBillingServiceErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = "OrganizationStripeBillingServiceError"
  }
}

type CreateManagedAiCheckoutSessionInput = {
  orgId: string
  actorUserId: string
  interval: OrganizationBillingInterval
  quantities: ManagedAiBillingQuantities
  returnOrigin?: string | null
}

type CreateBillingPortalSessionInput = {
  orgId: string
  actorUserId: string
  returnOrigin?: string | null
}

type UpdateManagedAiSubscriptionQuantitiesInput = {
  orgId: string
  actorUserId: string
  quantities: ManagedAiBillingQuantities
}

type CancelManagedAiSubscriptionAtPeriodEndInput = {
  orgId: string
  actorUserId: string
}

type CreateLocalModelsStripeInvoiceOrSubscriptionInput = {
  orgId: string
  actorUserId: string
  platformAdmin: boolean
  quantity: number
}

export type OrganizationStripeBillingService = {
  createManagedAiCheckoutSession(input: CreateManagedAiCheckoutSessionInput): Promise<{ id: string; url: string | null }>
  createBillingPortalSession(input: CreateBillingPortalSessionInput): Promise<{ id: string; url: string | null }>
  updateManagedAiSubscriptionQuantities(input: UpdateManagedAiSubscriptionQuantitiesInput): Promise<void>
  cancelManagedAiSubscriptionAtPeriodEnd(input: CancelManagedAiSubscriptionAtPeriodEndInput): Promise<void>
  createLocalModelsStripeInvoiceOrSubscription(
    input: CreateLocalModelsStripeInvoiceOrSubscriptionInput,
  ): Promise<{ status: "not_configured"; orgId: string; billingMode: "local_models" }>
}

export type CreateOrganizationStripeBillingServiceInput = {
  config: StripeOrganizationBillingConfig
  repository: OrganizationBillingRepository
  stripe: OrganizationStripeBillingClient
}

export function createOrganizationStripeBillingService(
  input: CreateOrganizationStripeBillingServiceInput,
): OrganizationStripeBillingService {
  const { config, repository, stripe } = input

  return {
    async createManagedAiCheckoutSession(request) {
      assertStripeBillingEnabled(config)
      const quantities = normalizeManagedAiQuantities(request.quantities)
      assertAnyManagedAiQuantity(quantities)
      await repository.assertRequestedQuantitiesCanCoverActiveUsers({
        orgId: request.orgId,
        mode: "managed_ai",
        quantities: {
          managedAiBasic: quantities.managedAiBasic,
          managedAiExtended: quantities.managedAiExtended,
          localModels: 0,
        },
      })
      await assertManagedAiTiersAllowed(repository, request.orgId, quantities)

      const lineItems = [
        quantities.managedAiBasic > 0
          ? {
            price: resolveStripePriceId(config, { tier: "basic", interval: request.interval }),
            quantity: quantities.managedAiBasic,
          }
          : null,
        quantities.managedAiExtended > 0
          ? {
            price: resolveStripePriceId(config, { tier: "extended", interval: request.interval }),
            quantity: quantities.managedAiExtended,
          }
          : null,
      ].filter((item): item is { price: string; quantity: number } => item !== null)

      const metadata = managedAiMetadata(request.orgId, request.actorUserId, request.interval, quantities)
      return stripe.checkout.sessions.create({
        mode: "subscription",
        success_url: configuredReturnUrl(config.successUrl, "successUrl", request.returnOrigin),
        cancel_url: configuredReturnUrl(config.cancelUrl, "cancelUrl", request.returnOrigin),
        line_items: lineItems,
        automatic_tax: {
          enabled: config.taxMode === "stripe_tax",
        },
        metadata,
        subscription_data: {
          metadata,
        },
      })
    },

    async createBillingPortalSession(request) {
      assertStripeBillingEnabled(config)
      const account = await repository.getBillingAccount(request.orgId)
      if (!account?.stripeCustomerId) {
        throw new OrganizationStripeBillingServiceError("stripe_customer_required", { orgId: request.orgId })
      }

      return stripe.billingPortal.sessions.create({
        customer: account.stripeCustomerId,
        return_url: configuredReturnUrl(config.portalReturnUrl, "portalReturnUrl", request.returnOrigin),
      })
    },

    async updateManagedAiSubscriptionQuantities(request) {
      assertStripeBillingEnabled(config)
      const quantities = normalizeManagedAiQuantities(request.quantities)
      await repository.assertRequestedQuantitiesCanCoverActiveUsers({
        orgId: request.orgId,
        mode: "managed_ai",
        quantities: {
          managedAiBasic: quantities.managedAiBasic,
          managedAiExtended: quantities.managedAiExtended,
          localModels: 0,
        },
      })
      await assertManagedAiTiersAllowed(repository, request.orgId, quantities)

      const account = await repository.getBillingAccount(request.orgId)
      if (!account?.stripeSubscriptionId) {
        throw new OrganizationStripeBillingServiceError("stripe_subscription_required", { orgId: request.orgId })
      }
      const interval = resolveBillingInterval(account.billingInterval)
      const subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId)
      const basicPriceId = resolveStripePriceId(config, { tier: "basic", interval })
      const extendedPriceId = resolveStripePriceId(config, { tier: "extended", interval })
      const basicItem = findSubscriptionItem(subscription, basicPriceId)
      const extendedItem = findSubscriptionItem(subscription, extendedPriceId)

      const currentBasicQuantity = normalizeCount(basicItem?.quantity ?? 0)
      const currentExtendedQuantity = normalizeCount(extendedItem?.quantity ?? 0)
      const hasIncrease = quantities.managedAiBasic > currentBasicQuantity ||
        quantities.managedAiExtended > currentExtendedQuantity

      await stripe.subscriptions.update(account.stripeSubscriptionId, {
        proration_behavior: hasIncrease ? "always_invoice" : "none",
        items: [
          ...subscriptionItemUpdate(basicItem, basicPriceId, quantities.managedAiBasic),
          ...subscriptionItemUpdate(extendedItem, extendedPriceId, quantities.managedAiExtended),
        ],
        metadata: managedAiMetadata(request.orgId, request.actorUserId, interval, quantities),
      })
    },

    async cancelManagedAiSubscriptionAtPeriodEnd(request) {
      assertStripeBillingEnabled(config)
      const account = await repository.getBillingAccount(request.orgId)
      if (!account?.stripeSubscriptionId) {
        throw new OrganizationStripeBillingServiceError("stripe_subscription_required", { orgId: request.orgId })
      }

      await stripe.subscriptions.update(account.stripeSubscriptionId, {
        cancel_at_period_end: true,
        metadata: {
          orgId: request.orgId,
          actorUserId: request.actorUserId,
          billingMode: "managed_ai",
        },
      })
    },

    async createLocalModelsStripeInvoiceOrSubscription(request) {
      if (!request.platformAdmin) {
        throw new OrganizationStripeBillingServiceError("platform_admin_required", { orgId: request.orgId })
      }
      assertStripeBillingEnabled(config)

      return {
        status: "not_configured",
        orgId: request.orgId,
        billingMode: "local_models",
      }
    },
  }
}

function assertStripeBillingEnabled(config: StripeOrganizationBillingConfig) {
  if (!config.enabled) {
    throw new OrganizationStripeBillingServiceError("stripe_billing_disabled")
  }
}

function requiredConfiguredUrl(value: string | null, name: string) {
  if (!value) {
    throw new OrganizationStripeBillingServiceError("stripe_billing_disabled", { missing: name })
  }
  return value
}

function configuredReturnUrl(value: string | null, name: string, returnOrigin: string | null | undefined) {
  return rewriteConfiguredLocalReturnOrigin(requiredConfiguredUrl(value, name), returnOrigin)
}

function rewriteConfiguredLocalReturnOrigin(configuredUrl: string, returnOrigin: string | null | undefined) {
  if (!returnOrigin) {
    return configuredUrl
  }

  try {
    const configured = new URL(configuredUrl)
    const requested = new URL(returnOrigin)
    if (
      configured.protocol !== requested.protocol ||
      normalizedUrlPort(configured) !== normalizedUrlPort(requested) ||
      !isLoopbackHost(configured.hostname) ||
      !isLoopbackHost(requested.hostname)
    ) {
      return configuredUrl
    }

    configured.protocol = requested.protocol
    configured.hostname = requested.hostname
    configured.port = requested.port
    return configured.toString()
  } catch {
    return configuredUrl
  }
}

function normalizedUrlPort(url: URL) {
  if (url.port) {
    return url.port
  }
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

function normalizeManagedAiQuantities(quantities: ManagedAiBillingQuantities): ManagedAiBillingQuantities {
  return {
    managedAiBasic: normalizeCount(quantities.managedAiBasic),
    managedAiExtended: normalizeCount(quantities.managedAiExtended),
  }
}

function normalizeCount(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.trunc(value))
}

function assertAnyManagedAiQuantity(quantities: ManagedAiBillingQuantities) {
  if (quantities.managedAiBasic <= 0 && quantities.managedAiExtended <= 0) {
    throw new OrganizationStripeBillingServiceError("managed_ai_quantity_required")
  }
}

async function assertManagedAiTiersAllowed(
  repository: OrganizationBillingRepository,
  orgId: string,
  quantities: ManagedAiBillingQuantities,
) {
  const allowlist = await repository.listAllowedTiers(orgId)
  const allowedByTier = new Map(allowlist.map((entry) => [entry.tier, entry.enabled]))
  if (quantities.managedAiBasic > 0 && allowedByTier.get("managed_ai_basic") === false) {
    throw new OrganizationStripeBillingServiceError("tier_not_allowed", { orgId, tier: "managed_ai_basic" })
  }
  if (quantities.managedAiExtended > 0 && allowedByTier.get("managed_ai_extended") === false) {
    throw new OrganizationStripeBillingServiceError("tier_not_allowed", { orgId, tier: "managed_ai_extended" })
  }
}

function resolveBillingInterval(value: string | null): OrganizationBillingInterval {
  if (value === "monthly" || value === "annual") {
    return value
  }
  return "monthly"
}

function findSubscriptionItem(subscription: OrganizationStripeSubscription, priceId: string) {
  return subscription.items.data.find((candidate) => candidate.price.id === priceId) ?? null
}

function subscriptionItemUpdate(
  item: OrganizationStripeSubscription["items"]["data"][number] | null,
  priceId: string,
  quantity: number,
) {
  if (item) {
    return [{ id: item.id, quantity }]
  }
  if (quantity > 0) {
    return [{ price: priceId, quantity }]
  }
  return []
}

function managedAiMetadata(
  orgId: string,
  actorUserId: string,
  interval: OrganizationBillingInterval,
  quantities: ManagedAiBillingQuantities,
): OrganizationStripeBillingMetadata {
  return {
    orgId,
    actorUserId,
    billingMode: "managed_ai",
    interval,
    managedAiBasicQuantity: String(quantities.managedAiBasic),
    managedAiExtendedQuantity: String(quantities.managedAiExtended),
  }
}
