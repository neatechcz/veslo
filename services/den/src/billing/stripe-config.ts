export type OrganizationBillingTier = "basic" | "extended"
export type OrganizationBillingInterval = "monthly" | "annual"
type OrganizationBillingTaxMode = "manual" | "stripe_tax"

export interface StripeOrganizationBillingConfig {
  enabled: boolean
  secretKey: string | null
  webhookSecret: string | null
  successUrl: string | null
  cancelUrl: string | null
  portalReturnUrl: string | null
  taxMode: OrganizationBillingTaxMode
  prices: Record<OrganizationBillingTier, Record<OrganizationBillingInterval, string | null>>
}

export interface StripeOrganizationBillingEnvInput {
  STRIPE_ORG_BILLING_ENABLED?: string
  STRIPE_ORG_BILLING_SECRET_KEY?: string
  STRIPE_ORG_BILLING_WEBHOOK_SECRET?: string
  STRIPE_ORG_BILLING_SUCCESS_URL?: string
  STRIPE_ORG_BILLING_CANCEL_URL?: string
  STRIPE_ORG_BILLING_PORTAL_RETURN_URL?: string
  STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID?: string
  STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID?: string
  STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID?: string
  STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID?: string
  STRIPE_ORG_BILLING_TAX_MODE?: string
}

export function parseStripeOrganizationBillingConfig(
  input: StripeOrganizationBillingEnvInput,
): StripeOrganizationBillingConfig {
  const enabled = (input.STRIPE_ORG_BILLING_ENABLED ?? "false").trim().toLowerCase() === "true"
  const taxMode = parseTaxMode(input.STRIPE_ORG_BILLING_TAX_MODE)
  const values = {
    secretKey: readOptionalEnv(input.STRIPE_ORG_BILLING_SECRET_KEY),
    webhookSecret: readOptionalEnv(input.STRIPE_ORG_BILLING_WEBHOOK_SECRET),
    successUrl: normalizeConfiguredUrl(input.STRIPE_ORG_BILLING_SUCCESS_URL),
    cancelUrl: normalizeConfiguredUrl(input.STRIPE_ORG_BILLING_CANCEL_URL),
    portalReturnUrl: normalizeConfiguredUrl(input.STRIPE_ORG_BILLING_PORTAL_RETURN_URL),
    prices: {
      basic: {
        monthly: readOptionalEnv(input.STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID),
        annual: readOptionalEnv(input.STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID),
      },
      extended: {
        monthly: readOptionalEnv(input.STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID),
        annual: readOptionalEnv(input.STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID),
      },
    },
  } satisfies Omit<StripeOrganizationBillingConfig, "enabled" | "taxMode">

  if (!enabled) {
    return {
      enabled: false,
      secretKey: null,
      webhookSecret: null,
      successUrl: null,
      cancelUrl: null,
      portalReturnUrl: null,
      taxMode,
      prices: emptyPriceConfig(),
    }
  }

  const missing = [
    ["STRIPE_ORG_BILLING_SECRET_KEY", values.secretKey],
    ["STRIPE_ORG_BILLING_WEBHOOK_SECRET", values.webhookSecret],
    ["STRIPE_ORG_BILLING_SUCCESS_URL", values.successUrl],
    ["STRIPE_ORG_BILLING_CANCEL_URL", values.cancelUrl],
    ["STRIPE_ORG_BILLING_PORTAL_RETURN_URL", values.portalReturnUrl],
    ["STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID", values.prices.basic.monthly],
    ["STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID", values.prices.basic.annual],
    ["STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID", values.prices.extended.monthly],
    ["STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID", values.prices.extended.annual],
  ].flatMap(([name, value]) => (value ? [] : [name]))

  if (missing.length > 0) {
    throw new Error(`Stripe organization billing is enabled but missing required env vars: ${missing.join(", ")}`)
  }

  validateStripePriceId("STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID", values.prices.basic.monthly)
  validateStripePriceId("STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID", values.prices.basic.annual)
  validateStripePriceId("STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID", values.prices.extended.monthly)
  validateStripePriceId("STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID", values.prices.extended.annual)

  return {
    enabled: true,
    taxMode,
    ...values,
  }
}

export function resolveStripePriceId(
  config: StripeOrganizationBillingConfig,
  request: { tier: OrganizationBillingTier; interval: OrganizationBillingInterval },
) {
  if (!config.enabled) {
    throw new Error("Stripe organization billing is disabled; cannot resolve price id")
  }

  const priceId = config.prices[request.tier][request.interval]
  if (!priceId) {
    throw new Error(`Missing Stripe organization billing price id for ${request.tier} ${request.interval}`)
  }

  validateStripePriceId(priceEnvVarName(request.tier, request.interval), priceId)

  return priceId
}

function readOptionalEnv(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function normalizeConfiguredUrl(value: string | undefined): string | null {
  return readOptionalEnv(value)?.replace(/\/+$/, "") ?? null
}

function parseTaxMode(value: string | undefined): OrganizationBillingTaxMode {
  const taxMode = readOptionalEnv(value) ?? "manual"
  if (taxMode !== "manual" && taxMode !== "stripe_tax") {
    throw new Error("STRIPE_ORG_BILLING_TAX_MODE must be manual or stripe_tax")
  }
  return taxMode
}

function validateStripePriceId(envVarName: string, value: string | null) {
  if (!value) {
    return
  }
  if (!value.startsWith("price_")) {
    throw new Error(`${envVarName} must be a Stripe Price ID`)
  }
}

function priceEnvVarName(tier: OrganizationBillingTier, interval: OrganizationBillingInterval) {
  const tierPart = tier === "basic" ? "BASIC" : "EXTENDED"
  const intervalPart = interval === "monthly" ? "MONTHLY" : "ANNUAL"
  return `STRIPE_ORG_BILLING_${tierPart}_${intervalPart}_PRICE_ID`
}

function emptyPriceConfig(): StripeOrganizationBillingConfig["prices"] {
  return {
    basic: {
      monthly: null,
      annual: null,
    },
    extended: {
      monthly: null,
      annual: null,
    },
  }
}
