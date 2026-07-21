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

## Automatic Domain-Bound Trials

DEN grants at most one automatic 14-day trial for a registered company domain. The trial belongs to the organization, so its active members inherit the organization's trial entitlement rather than receiving individual trials.

Automatic trial rules:

- an organization without a registered domain receives no automatic trial
- a domain registration or rename requires at least one active organization member with a verified email on that normalized exact domain
- registration policy decides whether a domain is allowed; trial code trusts registered domains and does not classify public email providers
- every current organization domain must be historically unclaimed before DEN grants a new trial
- one grant consumes every domain currently registered to that organization, and a domain added later is consumed by the same existing trial
- the unique claim ledger is immutable during normal domain administration, so deleting, disabling, renaming, transferring, or later re-registering a domain never restores trial eligibility
- existing manual or automatic trial state keeps its configured expiry while reconciliation backfills claims for all current domains
- paid or other non-trial billing configuration is preserved and does not consume domain claims merely by existing
- membership changes, including adding, removing, disabling, or reactivating members, never reset or extend the organization trial
- startup reconciliation is idempotent and reports only scanned and newly granted counts

Organization domains and trial claims are different records: a domain record represents current routing and may be changed, while its historical trial claim remains permanent. A historical claim never blocks registration; it only prevents the domain from funding another automatic trial.

## Platform Trials

Platform trials are temporary platform-admin grants for organizations that need free Managed AI access before or outside Stripe billing. In the standalone Gateway organization Billing page, platform admins use the same Basic and Extended license quantity controls as checkout, choose a trial end date, and click `Create trial`.

Trial rules:

- platform trials are stored as manual access with source `manual_trial`
- only platform admins can create or revoke them
- a trial requires a future end date and a Basic/Extended seat count
- a trial cannot be granted while the organization already has a Stripe subscription configured
- an organization can still start Stripe Checkout while the trial is active
- once Stripe reports an active or trialing subscription, Stripe-owned billing clears the platform trial immediately
- revoking a trial disables access immediately and behaves like unpaid access with no grace period
- after a trial expires, entitlement derivation treats the organization as unpaid unless another active billing source exists
- when an existing manual trial has registered domains, the automatic reconciliation path claims those domains without changing its administrator-set expiry

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

Stripe webhook application also owns the handoff from platform trial to paid subscription. Checkout completion clears active trial fields, and subscription or invoice events clear them only when the event carries active or trialing subscription evidence. Non-active Stripe events preserve an active platform trial until Stripe becomes active or the trial is revoked or expires.

## Entitlements

DEN is the billing source of truth and exposes the user-authenticated minimal facade `GET /v1/managed-ai/entitlement`. The response contains only `orgId` and `canUseManagedAi`; it does not expose subscription, payment, seat, or Stripe details. A single active membership can resolve automatically. Multi-organization users must provide an explicit organization id, while inactive or cross-organization ids fail with safe organization-context errors.

AI Gateway resolves each Managed AI inference request in this order: authenticated session, billing entitlement, user enablement/provider assignment, the single global active model, then credential/lease/token brokerage. It briefly caches both allow and deny decisions and coalesces concurrent lookups, but does not cache failed or malformed DEN responses. The entitlement check belongs to inference authorization, not to every AI-access read.

Verified signup resolves an active organization membership before Managed AI can be assigned. Self-access can lazily create a missing enabled assignment after authentication without a billing entitlement check; an inference request can do so only after positive DEN entitlement. An organization-qualified admin GET is guarded by admin authentication, the target's active membership, and authorization for the named organization, without a billing entitlement check. An administrator can disable an individual's AI access, and that explicit disabled record remains disabled. End users do not choose a model or provider: the single global active model is the exclusive runtime model authority, while AI Infrastructure credential routing selects compatible backend infrastructure.

An organization that is resolved successfully but cannot use Managed AI receives HTTP `402` with `error: "managed_ai_entitlement_denied"`. DEN/network/malformed-response failure receives HTTP `503` with `error: "managed_ai_entitlement_unavailable"`. Both stop before AI-access, model, credential, lease, or provider calls. History/settings reads remain allowed by the entitlement model. Local Models mode can allow BYOK/local-provider usage without granting Managed AI inference.

Organization context exists only inside an explicit organization workspace in admin. Platform pages never retain an organization id, and the runtime organization id is bound to authenticated in-memory authorization rather than accepted from a later provider request.

The active license limit is the sum of Basic and Extended quantities. License validation uses active organization memberships and excludes removed/disabled memberships and globally disabled users.
