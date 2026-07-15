# Organization Billing

Den owns organization billing state, Stripe payment events, and the entitlement decision for Veslo Managed AI.

## Admin Flow

Organization admins use the organization-scoped Billing page in standalone AI Gateway admin to:

- read billing status, entitlement state, active user count, and license limit
- start a Stripe Checkout subscription for Basic and Extended Managed AI seats
- open the Stripe Customer Portal for an existing Stripe customer
- update subscription quantities for an existing Stripe subscription
- request cancellation at period end

Platform admins can also set manual access, local-model billing metadata, billing status, and per-organization tier allowlists.

The standalone AI Gateway admin exposes these controls through organization-scoped facades backed by Den's canonical admin billing API. It forwards the signed-in Den token and preserves Den's response status and body, including validation details. Stripe configuration and mutations remain owned by Den; the gateway does not store Stripe secrets or duplicate Stripe logic. Self-service billing actions are available to an authorized administrator of that organization, while manual/platform billing controls are both hidden from organization admins and rejected server-side unless the caller is a platform admin.

## Platform Trials

Every organization currently receives an unlimited platform trial for Managed AI. Existing organizations without a configured Stripe subscription are backfilled during the retry-safe billing migration, and Den startup inserts any still-missing billing rows without changing existing billing accounts. The canonical personal-organization creation path writes the trial in the same transaction as the organization and owner membership and repairs a missing row when it encounters an existing personal organization. Existing Stripe subscription accounts remain Stripe-owned.

The default trial has no Veslo-defined expiration, seat cap, or token cap. Managed-AI usage is still recorded, and upstream Codex/provider account capacity, rate, and weekly limits continue to apply. This is an organization entitlement, not a gateway bypass: user assignment, active model policy, credential eligibility, and organization context are still enforced.

In Admin Billing, the state is labeled `Unlimited trial` and its license capacity is displayed as `Unlimited`. Platform admins can enable or revoke it explicitly.

Trial rules:

- platform trials are stored as manual access with source `manual_trial`
- unlimited trials store an explicit unlimited flag, a null expiry, and zero synthetic seat quantities
- only platform admins can create or revoke them
- the current default trial requires neither an end date nor a Basic/Extended seat count
- the API retains finite-trial support for historical or future policy changes; finite trials require a future end date and enough seats
- a trial cannot be granted while the organization already has a Stripe subscription configured
- an organization can still start Stripe Checkout while the trial is active
- once Stripe reports an active or trialing subscription, Stripe-owned billing clears the enabled, unlimited, and expiry fields immediately
- revoking a trial disables access immediately and behaves like unpaid access with no grace period
- after a finite trial expires, entitlement derivation treats the organization as unpaid unless another active billing source exists

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

Stripe webhook application also owns the handoff from platform trial to paid subscription. Checkout completion clears active trial fields, and subscription or invoice events clear them only when the event carries active or trialing subscription evidence. Non-active Stripe events preserve an active platform trial until Stripe becomes active or the trial is revoked; finite trials can also expire.

## Entitlements

DEN is the billing source of truth and exposes the user-authenticated minimal facade `GET /v1/managed-ai/entitlement`. The response contains only `orgId` and `canUseManagedAi`; it does not expose subscription, payment, seat, or Stripe details. A single active membership can resolve automatically. Multi-organization users must provide an explicit organization id, while inactive or cross-organization ids fail with safe organization-context errors.

AI Gateway resolves each Managed AI proxy request in this order: authenticated session, billing entitlement, user enablement/provider assignment, global active model, then credential/lease/token brokerage. It briefly caches both allow and deny decisions and coalesces concurrent lookups, but does not cache failed or malformed DEN responses.

An organization that is resolved successfully but cannot use Managed AI receives HTTP `402` with `error: "managed_ai_entitlement_denied"`. DEN/network/malformed-response failure receives HTTP `503` with `error: "managed_ai_entitlement_unavailable"`. Both stop before AI-access, model, credential, lease, or provider calls. History/settings reads remain allowed by the entitlement model. Local Models mode can allow BYOK/local-provider usage without granting Managed AI inference.

Organization context exists only inside an explicit organization workspace in admin. Platform pages never retain an organization id, and the runtime organization id is bound to authenticated in-memory authorization rather than accepted from a later provider request.

For paid and finite-trial access, the active license limit is the sum of Basic and Extended quantities. License validation uses active organization memberships and excludes removed/disabled memberships and globally disabled users. Unlimited trials expose `isUnlimited=true` and a null license limit instead of a synthetic high number.
