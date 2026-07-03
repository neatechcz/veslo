# Organization Billing

Den owns organization billing state, Stripe payment events, and the entitlement decision for Veslo Managed AI.

## Admin Flow

Organization admins can use Den Admin Billing to:

- read billing status, entitlement state, active user count, and license limit
- start a Stripe Checkout subscription for Basic and Extended Managed AI seats
- open the Stripe Customer Portal for an existing Stripe customer
- update subscription quantities for an existing Stripe subscription
- request cancellation at period end

Platform admins can also set manual access, local-model billing metadata, billing status, and per-organization tier allowlists.

## Stripe Sandbox and Live Switch

Stripe billing is disabled by default. Enable it only with environment configuration:

- `STRIPE_ORG_BILLING_ENABLED=true`
- `STRIPE_ORG_BILLING_SECRET_KEY`
- `STRIPE_ORG_BILLING_WEBHOOK_SECRET`
- `STRIPE_ORG_BILLING_SUCCESS_URL`
- `STRIPE_ORG_BILLING_CANCEL_URL`
- `STRIPE_ORG_BILLING_PORTAL_RETURN_URL`
- `STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID`
- `STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID`
- `STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID`
- `STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID`
- `STRIPE_ORG_BILLING_TAX_MODE`

Sandbox uses `sk_test`, `pk_test`, `whsec`, and test-mode `price_` ids. Live mode uses the same variables with live Stripe keys, live webhook secret, and live `price_` ids. No code change is needed for the switch; rotate only environment values after Stripe live products, prices, customer portal, tax settings, and webhook endpoint are configured.

The UI and API never accept Stripe Price IDs from callers. Admins choose interval and Basic/Extended quantities; Den resolves those choices to configured Stripe Price IDs.

## Webhooks

The Stripe webhook endpoint is:

`POST /v1/organization-billing/stripe/webhook`

It is mounted before the global JSON parser so Stripe signature verification uses the raw request body. Handled events:

- `checkout.session.completed`
- `customer.subscription.updated`
- `invoice.payment_failed`
- `invoice.payment_succeeded`
- `customer.subscription.deleted`

Den records Stripe event ids for idempotency. Duplicate applied or ignored events do not apply mutations twice. Failed application attempts stay retryable for Stripe redelivery.

## Entitlements

Managed AI proxy requests are organization-billing gated before AI-access policy lookup, lease acquisition, token brokerage, or upstream provider calls.

Unpaid, canceled, missing-payment, or local-model-only organizations receive HTTP `402` with `error: "payment_required"` for Den Managed AI inference. History/settings reads remain allowed by the entitlement model. Local Models mode can allow BYOK/local-provider usage without granting Den Managed AI inference.

The active license limit is the sum of Basic and Extended quantities. License validation uses active organization memberships and excludes removed/disabled memberships and globally disabled users.
