import Stripe from "stripe"
import type { StripeOrganizationBillingConfig } from "./stripe-config.js"

export type OrganizationStripeBillingMetadata = Record<string, string>

type OrganizationStripeCheckoutSessionCreateParams = {
  mode: "subscription"
  success_url: string
  cancel_url: string
  line_items: Array<{ price: string; quantity: number }>
  automatic_tax: { enabled: boolean }
  metadata: OrganizationStripeBillingMetadata
  subscription_data: {
    metadata: OrganizationStripeBillingMetadata
  }
}

type OrganizationStripeBillingPortalSessionCreateParams = {
  customer: string
  return_url: string
}

export type OrganizationStripeSubscription = {
  id: string
  items: {
    data: Array<{
      id: string
      price: {
        id: string | null
      }
      quantity?: number | null
    }>
  }
}

type OrganizationStripeSubscriptionUpdateParams = {
  proration_behavior?: "always_invoice" | "none"
  items?: Array<({ id: string } | { price: string }) & { quantity: number }>
  cancel_at_period_end?: boolean
  metadata?: OrganizationStripeBillingMetadata
}

export type OrganizationStripeBillingClient = {
  checkout: {
    sessions: {
      create(params: OrganizationStripeCheckoutSessionCreateParams): Promise<{ id: string; url: string | null }>
    }
  }
  billingPortal: {
    sessions: {
      create(params: OrganizationStripeBillingPortalSessionCreateParams): Promise<{ id: string; url: string | null }>
    }
  }
  subscriptions: {
    retrieve(id: string): Promise<OrganizationStripeSubscription>
    update(id: string, params: OrganizationStripeSubscriptionUpdateParams): Promise<unknown>
  }
}

const STRIPE_ORGANIZATION_BILLING_API_VERSION = Stripe.API_VERSION

export function createOrganizationStripeBillingClient(
  config: StripeOrganizationBillingConfig,
): OrganizationStripeBillingClient {
  if (!config.enabled || !config.secretKey) {
    throw new Error("Stripe organization billing is disabled")
  }

  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_ORGANIZATION_BILLING_API_VERSION,
  }) as unknown as OrganizationStripeBillingClient
}
