# Organization Stripe Billing Design

## Status

Design approved for implementation planning.

## Goal

Add organization billing for Veslo so organization admins can pay for seat-based application access through Stripe, while Den remains the product authority for organization access, license limits, tier availability, Local Models agreements, and AI inference policy.

## Core Direction

Den is the authority for licenses and entitlements. Stripe is the authority for payment collection and billing lifecycle.

Den should decide what an organization is allowed to buy, how many active users it may have, whether Veslo-managed AI inference is allowed, and whether any manual or custom access override applies. Stripe should handle Checkout, subscriptions, invoices, payment methods, failed payments, dunning, Customer Portal, and hosted billing confirmation.

The desktop app remains the authoritative runtime under test. Billing is cloud-backed organization state and should not make cloud execution the default runtime.

## MVP Scope

The MVP includes two billing branches.

### Managed AI Self-Serve

Organization admins can buy public seat-based Managed AI licenses through Stripe Checkout:

- Basic Managed AI: CZK 2,000 or EUR 80 per seat per month, excluding VAT.
- Extended Managed AI: CZK 5,000 or EUR 200 per seat per month, excluding VAT.
- Annual billing is supported at 10 months for the price of 12.
- Monthly and annual billing are both supported.
- The whole organization uses one billing interval at a time.
- The organization can buy any combination of Basic and Extended seats.
- Total purchased seats define the maximum number of active, non-deactivated organization users.
- Extended seats increase the shared organization AI usage allowance, but Den computes the concrete limits from internal configuration, not from Stripe metadata.

Self-serve in the MVP uses online Stripe Checkout only. Stripe invoice-based sales for Managed AI can be added later or performed by platform admins outside the self-serve path.

### Local Models Custom Billing

Local Models customers are handled as custom organization tariffs:

- Only platform admins can enable Local Models billing for an organization.
- The price is a custom per-user license price negotiated with that organization.
- Monthly and annual intervals are supported.
- Billing source can be Stripe invoice/subscription or manual external billing.
- Local Models licenses still define the active user limit.
- Local Models does not grant Veslo-managed AI usage allowance.
- Local Models inference should remain allowed because the customer uses its own models.
- The MVP does not enforce update blocking or other non-payment restrictions for Local Models. Those restrictions are intentionally deferred.

Local Models should not appear as a public catalog tier. Organization admins may see their current Local Models billing state after a platform admin configures it, but they cannot self-enable it.

## Non-Goals

The first release does not implement:

- Per-user assignment of Basic or Extended licenses.
- Multiple organizations per user.
- Billing-admin permission separate from organization owner/admin.
- Customer-controlled Local Models self-serve purchase.
- Local Models update enforcement.
- Full usage enforcement for AI quotas beyond deriving the entitlement inputs.
- B2C checkout.
- Customer-managed Stripe Portal quantity changes.
- Cloud/sync/storage add-ons.

## Organization And User Rules

For the MVP, a user can belong to only one organization.

The first user of an organization is the organization admin/owner and can manage billing for that organization. A separate `billing_admin` permission is deferred.

Billing may be managed by:

- the organization admin/owner for self-serve Managed AI,
- platform admins for every billing mode and override,
- platform admins for user transfer between organizations.

Organization admins can deactivate users. A deactivated user:

- does not count against the license limit,
- cannot access the organization,
- leaves history and audit records visible to authorized admins.

The system must not allow reducing the total license count below the current count of active, non-deactivated organization members.

## Billing Model

Den should separate the billing model into three concepts.

### Catalog Tiers

Catalog tiers describe what can be purchased:

- `managed_ai_basic`
- `managed_ai_extended`
- future allowlisted Managed AI tiers
- `local_models_custom` as a special non-public custom mode

Public tiers are visible by default. Organization-specific tier availability is controlled by Den allowlists, not by Stripe metadata. Stripe prices are used only after Den has decided that the selected tier is allowed.

### Organization Billing Account

Each organization should have a billing account record with:

- billing mode: none, managed AI, Local Models, manual access, or future modes,
- active Stripe customer id when applicable,
- active Stripe subscription id when applicable,
- current subscription status from Stripe,
- current billing interval,
- current billing source,
- current purchased quantities per tier,
- pending scheduled quantity decreases or downgrades,
- cancellation-at-period-end state,
- payment problem state and last failure details,
- manual access flag and optional expiration,
- custom Local Models price per license and interval,
- allowed catalog tiers for the organization.

The billing account is the local Den read model used by the product. Stripe webhook events update this read model.

### Entitlement Snapshot

Den should expose a derived entitlement snapshot for the active organization:

- whether Veslo-managed AI inference is allowed,
- whether BYOK/local-provider inference is allowed,
- whether history and settings are readable,
- whether the organization is in grace period,
- whether payment action is required,
- billing mode and billing source,
- total purchased active-user limit,
- active user count,
- per-tier quantities,
- AI usage policy inputs derived from quantities,
- user-facing billing warning or blocking reason.

The entitlement snapshot should be cheap to read and should not require a live Stripe API call.

## Stripe Integration

### Product And Price Structure

Stripe should represent Managed AI tiers as recurring prices suitable for subscription items:

- Basic monthly
- Basic annual
- Extended monthly
- Extended annual

Each recurring price should support CZK and EUR. Annual prices should encode the 10-month annual amount directly in Stripe. Den should not calculate annual discounts at runtime.

Den UI should not guarantee the final amount. It may show selected tiers and quantities, but Stripe Checkout is the final confirmation for currency, tax, billing address, and total.

### Checkout

When an organization admin starts self-serve Managed AI checkout:

1. Den validates the user can manage billing.
2. Den validates the selected tiers are allowed for the organization.
3. Den validates the requested total seats are at least the active user count.
4. Den creates a Stripe Checkout Session with subscription line items for the selected tier quantities and interval.
5. Stripe collects company billing details.
6. After completion, Stripe webhook events update Den.
7. Den exposes the updated entitlement snapshot.

Checkout cancellation should return the organization to its previous state without granting access.

### Customer Portal

Stripe Customer Portal is used for:

- payment method management,
- invoices,
- hosted cancellation flow.

Den remains responsible for license quantity changes. Customer Portal should not be the primary path for changing Basic or Extended quantities.

### Subscription Changes

Quantity and tier changes should follow these rules:

- Adding seats takes effect immediately and uses Stripe proration.
- Reducing seats takes effect at the next billing period.
- Downgrading Extended seats to Basic takes effect at the next billing period.
- Canceling a subscription cancels at period end.
- The active organization must keep access until the paid period ends unless Stripe marks the subscription as finally unpaid after dunning.

Scheduled decreases and downgrades should remain visible in Den so admins understand current versus next-period entitlements.

### Failed Payments And Grace

Stripe dunning and retry rules define the grace period.

During grace:

- access remains active,
- Den admin UI shows a payment warning,
- Stripe emails handle payment communication,
- Den does not send custom billing emails in the MVP.

After Stripe marks the subscription as unpaid or otherwise finally failed:

- Veslo-managed AI inference is blocked,
- history and billing administration remain readable,
- the user sees a clear payment-required reason.

## Tax And Billing Details

MVP online payments are B2B.

The catalog prices are exclusive of VAT. The first commercial focus is Czech companies, but Checkout should not hard-block other countries. Stripe Checkout should collect company billing details and the final hosted confirmation should own currency, address, tax-related collection, and total amount.

Tax handling should be configuration-driven:

- MVP can use manual tax configuration.
- The architecture should allow enabling Stripe Tax later without changing the Den entitlement model.
- Stripe Tax is not required to ship the initial CZ-focused rollout.

## Admin UI

Billing is added to the existing Den admin page where organizations and users already live.

### Organization Admin View

Organization admins can see:

- current billing state,
- active users versus purchased licenses,
- available self-serve Managed AI tiers,
- Basic and Extended quantity controls,
- monthly or annual interval selection,
- Checkout action when no active subscription exists,
- Customer Portal action when a Stripe customer/subscription exists,
- payment problem warnings,
- pending next-period quantity or tier changes.

The organization admin view should not expose platform-only controls such as tier allowlists, manual external access, or custom Local Models tariff setup.

### Platform Admin View

Platform admins can manage:

- organization tier allowlists,
- manual access or invoice access,
- optional access expiration,
- Local Models custom billing mode,
- custom per-license Local Models price,
- billing interval,
- billing source: Stripe invoice/subscription or manual external,
- user deactivation,
- platform-only user transfer between organizations,
- Stripe problem states and webhook/audit diagnostics.

### Unified Billing Form

The billing form should be one form with a billing type selector:

- Managed AI catalog billing,
- Local Models custom billing,
- manual access or external billing.

Fields should appear only when relevant to the selected type.

## Runtime Enforcement

Veslo-managed AI inference must check the Den entitlement snapshot before starting a request.

Expected enforcement states:

- Active Managed AI subscription: Veslo-managed AI inference is allowed according to internal usage configuration.
- Manual access/admin override: inference is allowed according to the override policy.
- Local Models: local/BYOK inference is allowed; Veslo-managed AI allowance is not granted unless separately configured.
- No paid access: history and settings are readable; Veslo-managed AI inference is blocked.
- Past due in grace: inference remains allowed, with admin warning.
- Final unpaid/failure: Veslo-managed AI inference is blocked.

BYOK and local-provider inference should remain organization-policy-driven. The default for unpaid organizations should block Veslo-managed AI. Platform admins can decide whether unpaid organizations may use BYOK or local providers.

## Error States

The product should represent these states explicitly:

- payment required,
- payment failed,
- update payment method,
- insufficient licenses,
- selected tier not allowed,
- checkout canceled,
- checkout pending,
- subscription sync pending,
- Stripe webhook stale or failed,
- requested license count below active user count,
- user already belongs to another organization,
- organization access disabled.

Payment and billing failures must not prevent reading history, viewing settings, or reaching billing recovery actions.

## Webhook And Audit Requirements

Webhook handling should cover the full relevant Stripe billing lifecycle:

- checkout sessions,
- customers,
- subscriptions,
- subscription items,
- invoices,
- payment intents,
- setup intents where used,
- payment methods,
- refunds,
- credit notes,
- payment failure and recovery events.

The handler should be idempotent and safe for retries. Unknown or irrelevant event types should be logged and stored for diagnostics without breaking entitlement calculation.

Den should store enough event metadata to answer:

- which Stripe event last changed the organization billing state,
- whether a webhook event was ignored, applied, or failed,
- why a subscription is blocked, in grace, or active,
- which admin changed a manual or Local Models billing setting.

## Testing Strategy

Prefer E2E tests around Den admin and desktop inference gating, with lower-level tests only where E2E is unreliable or too slow.

Primary scenarios:

- organization admin creates a Managed AI subscription through a test or mocked Stripe checkout flow,
- Stripe webhook updates Den billing state,
- entitlement snapshot allows Veslo-managed AI inference,
- failed payment moves the organization into warning/grace,
- final unpaid state blocks inference but keeps history readable,
- license limit blocks adding or activating users,
- deactivating a user releases a license,
- platform admin enables Local Models custom billing,
- Local Models enforces active user count but does not block local inference,
- Customer Portal link is available for an active Stripe customer/subscription.

Focused lower-level tests should cover:

- webhook idempotency,
- Stripe event mapping,
- entitlement snapshot derivation,
- allowlist validation,
- active user count validation,
- scheduled downgrade/decrease calculation,
- manual access expiration,
- Local Models custom billing validation.

## Documentation Updates After Implementation

After implementation, promote shipped behavior out of this plan into durable documentation:

- organization billing and entitlement behavior in `docs/features/`,
- Den and Stripe configuration in `docs/dev/`,
- state/config keys and environment variables in `docs/dev/state-and-config-reference.md`,
- any desktop inference gating contract in the relevant runtime docs.

This design document remains historical planning material after the feature ships.
