import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
}

Object.assign(process.env, baseEnv)

const { parseEnv } = await import("../src/env.js")

const enabledBillingEnv = {
  STRIPE_ORG_BILLING_ENABLED: "true",
  STRIPE_ORG_BILLING_SECRET_KEY: "sk_test_organization_billing_secret",
  STRIPE_ORG_BILLING_WEBHOOK_SECRET: "whsec_organization_billing_webhook",
  STRIPE_ORG_BILLING_SUCCESS_URL: " https://den.example.test/billing/success/ ",
  STRIPE_ORG_BILLING_CANCEL_URL: "https://den.example.test/billing/cancel/",
  STRIPE_ORG_BILLING_PORTAL_RETURN_URL: "https://den.example.test/admin/billing/",
  STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID: "price_basic_monthly",
  STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID: "price_basic_annual",
  STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID: "price_extended_monthly",
  STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID: "price_extended_annual",
} as const

test("organization billing Stripe env is disabled by default", () => {
  const parsed = parseEnv(baseEnv)

  assert.deepEqual(parsed.organizationBilling.stripe, {
    enabled: false,
    secretKey: null,
    webhookSecret: null,
    successUrl: null,
    cancelUrl: null,
    portalReturnUrl: null,
    taxMode: "manual",
    prices: {
      basic: {
        monthly: null,
        annual: null,
      },
      extended: {
        monthly: null,
        annual: null,
      },
    },
  })
})

test("enabled organization billing Stripe env requires secrets, URLs, and price ids", () => {
  assert.throws(
    () =>
      parseEnv({
        ...baseEnv,
        STRIPE_ORG_BILLING_ENABLED: "true",
        STRIPE_ORG_BILLING_SECRET_KEY: "sk_test_organization_billing_secret",
      }),
    /STRIPE_ORG_BILLING_WEBHOOK_SECRET.*STRIPE_ORG_BILLING_SUCCESS_URL.*STRIPE_ORG_BILLING_CANCEL_URL.*STRIPE_ORG_BILLING_PORTAL_RETURN_URL.*STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID.*STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID.*STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID.*STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID/s,
  )
})

test("enabled organization billing Stripe env parses all values and tax mode", () => {
  const parsed = parseEnv({
    ...baseEnv,
    ...enabledBillingEnv,
    STRIPE_ORG_BILLING_TAX_MODE: "stripe_tax",
  })

  assert.deepEqual(parsed.organizationBilling.stripe, {
    enabled: true,
    secretKey: "sk_test_organization_billing_secret",
    webhookSecret: "whsec_organization_billing_webhook",
    successUrl: "https://den.example.test/billing/success",
    cancelUrl: "https://den.example.test/billing/cancel",
    portalReturnUrl: "https://den.example.test/admin/billing",
    taxMode: "stripe_tax",
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
  })
})

test("organization billing Stripe env rejects invalid tax modes", () => {
  assert.throws(
    () =>
      parseEnv({
        ...baseEnv,
        ...enabledBillingEnv,
        STRIPE_ORG_BILLING_TAX_MODE: "automatic",
      }),
    /STRIPE_ORG_BILLING_TAX_MODE must be manual or stripe_tax/,
  )
})

test("enabled organization billing Stripe env rejects non-Price IDs", () => {
  const cases = [
    ["STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID", "plan_legacy_basic"],
    ["STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID", "prod_basic"],
    ["STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID", "basic_monthly"],
    ["STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID", "not-a-stripe-price"],
  ] as const

  for (const [envVarName, value] of cases) {
    assert.throws(
      () =>
        parseEnv({
          ...baseEnv,
          ...enabledBillingEnv,
          [envVarName]: value,
        }),
      new RegExp(`${envVarName} must be a Stripe Price ID`),
    )
  }
})

test("resolveStripePriceId returns the configured Managed AI price ids", async () => {
  const { resolveStripePriceId } = await import("../src/billing/stripe-config.js")
  const config = parseEnv({
    ...baseEnv,
    ...enabledBillingEnv,
  }).organizationBilling.stripe

  assert.equal(resolveStripePriceId(config, { tier: "basic", interval: "monthly" }), "price_basic_monthly")
  assert.equal(resolveStripePriceId(config, { tier: "basic", interval: "annual" }), "price_basic_annual")
  assert.equal(resolveStripePriceId(config, { tier: "extended", interval: "monthly" }), "price_extended_monthly")
  assert.equal(resolveStripePriceId(config, { tier: "extended", interval: "annual" }), "price_extended_annual")
})

test("resolveStripePriceId fails closed when Stripe billing is disabled or a price is missing", async () => {
  const { resolveStripePriceId } = await import("../src/billing/stripe-config.js")
  const disabledConfig = parseEnv(baseEnv).organizationBilling.stripe
  const enabledConfig = parseEnv({
    ...baseEnv,
    ...enabledBillingEnv,
  }).organizationBilling.stripe

  assert.throws(
    () => resolveStripePriceId(disabledConfig, { tier: "basic", interval: "monthly" }),
    /Stripe organization billing is disabled/,
  )
  assert.throws(
    () =>
      resolveStripePriceId(
        {
          ...enabledConfig,
          prices: {
            ...enabledConfig.prices,
            basic: {
              ...enabledConfig.prices.basic,
              monthly: null,
            },
          },
        },
        { tier: "basic", interval: "monthly" },
      ),
    /Missing Stripe organization billing price id for basic monthly/,
  )
})

test("resolveStripePriceId rejects manually constructed non-Price IDs", async () => {
  const { resolveStripePriceId } = await import("../src/billing/stripe-config.js")
  const enabledConfig = parseEnv({
    ...baseEnv,
    ...enabledBillingEnv,
  }).organizationBilling.stripe

  assert.throws(
    () =>
      resolveStripePriceId(
        {
          ...enabledConfig,
          prices: {
            ...enabledConfig.prices,
            basic: {
              ...enabledConfig.prices.basic,
              monthly: "plan_legacy_basic",
            },
          },
        },
        { tier: "basic", interval: "monthly" },
      ),
    /STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID must be a Stripe Price ID/,
  )
})

test(".env.example documents organization Stripe billing without fake live secrets", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8")

  for (const key of [
    "STRIPE_ORG_BILLING_ENABLED",
    "STRIPE_ORG_BILLING_SECRET_KEY",
    "STRIPE_ORG_BILLING_WEBHOOK_SECRET",
    "STRIPE_ORG_BILLING_SUCCESS_URL",
    "STRIPE_ORG_BILLING_CANCEL_URL",
    "STRIPE_ORG_BILLING_PORTAL_RETURN_URL",
    "STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID",
    "STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID",
    "STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID",
    "STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID",
    "STRIPE_ORG_BILLING_TAX_MODE",
  ]) {
    assert.match(example, new RegExp(`^${key}=`, "m"), `.env.example missing ${key}`)
  }
  assert.match(example, /Den owns entitlement\/license decisions/)
  assert.match(example, /Stripe owns the payment lifecycle/)
  assert.doesNotMatch(example, /sk_live/i)
  assert.doesNotMatch(example, /rk_live/i)
  assert.doesNotMatch(example, /whsec_live/i)
})
