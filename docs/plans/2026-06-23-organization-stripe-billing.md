# Organization Stripe Billing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build organization-scoped Stripe billing for Managed AI self-serve subscriptions and platform-admin Local Models custom licensing.

**Architecture:** Den is the authority for billing state, license limits, and entitlements; Stripe is the authority for hosted payment lifecycle. Stripe webhook events update Den read models, and runtime AI routes consult Den-derived entitlement snapshots before allowing Veslo-managed inference.

**Tech Stack:** Node.js, TypeScript, Express, Drizzle/MySQL, Stripe Billing/Checkout/Customer Portal/Webhooks, Den public-admin static UI, Veslo desktop/Den managed-AI gateway routes.

---

## References

- Design: `docs/plans/2026-06-23-organization-stripe-billing-design.md`
- Den schema: `services/den/src/db/schema.ts`
- Den env: `services/den/src/env.ts`
- Den admin contract: `services/den/src/http/admin.ts`
- Den admin runtime: `services/den/src/http/admin-runtime.ts`
- Den public admin UI: `services/den/public-admin/app.js`, `services/den/public-admin/app.css`
- Managed-AI proxy gate: `services/den/src/managed-ai/http/proxy.ts`
- Existing billing precedent: `services/den/src/billing/polar.ts`
- Existing org seat policy: `services/den/src/org-admin/policy.ts`, `services/den/src/org-admin/repository.ts`

Use @test-driven-development for each implementation task, @systematic-debugging for any failing test or unexpected Stripe behavior, and @verification-before-completion before committing or reporting completion.

## Mandatory Testing Standard

Every user-visible billing feature in this plan must be verified through complete E2E tests that run the Den admin locally. Unit or API tests are required for low-level logic, but they are not sufficient to mark a feature complete.

The E2E tests must exercise the local admin surface as the user would use it:

- load the Den admin from the locally running Den service,
- sign in or seed an organization/platform admin session,
- use the billing UI controls,
- verify the resulting admin UI state,
- verify the resulting entitlement/runtime behavior where the feature affects AI access,
- verify failure and recovery states, not only the happy path.

The only exception to live E2E execution is the external Stripe service. Do not rely on live Stripe in the required E2E suite. Instead, simulate Stripe by using a fake Stripe client, local webhook fixtures, and deterministic hosted URL responses. The simulation must cover every Stripe output and state that our code handles, including successful checkout, canceled/expired checkout, portal session creation, subscription creation/update/deletion, quantity changes, cancel-at-period-end, active, incomplete, past-due, unpaid, canceled, invoice payment succeeded, invoice payment failed, payment method updates, refunds or credit notes if supported by the handler, unknown events, duplicate events, and webhook signature errors.

## Task 1: Add Billing Domain Types And Pure Entitlement Tests

**Files:**

- Create: `services/den/src/billing/organization-billing.ts`
- Test: `services/den/test/organization-billing-entitlements.test.ts`

**Step 1: Write failing pure entitlement tests**

Create tests for the derived billing snapshot before adding implementation:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { deriveOrganizationBillingEntitlement } from "../src/billing/organization-billing.js"

test("active managed-ai billing allows managed inference and sums seats", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "active",
    grace: false,
    manualAccess: null,
    localModels: null,
    quantities: { managedAiBasic: 3, managedAiExtended: 2, localModels: 0 },
    activeUserCount: 5,
    policy: { allowByokWithoutPaidAccess: false },
  })

  assert.equal(entitlement.canUseManagedAi, true)
  assert.equal(entitlement.canReadHistory, true)
  assert.equal(entitlement.licenseLimit, 5)
  assert.equal(entitlement.activeUserCount, 5)
  assert.equal(entitlement.blockingReason, null)
})

test("unpaid managed-ai billing blocks managed inference but keeps history readable", () => {
  const entitlement = deriveOrganizationBillingEntitlement({
    mode: "managed_ai",
    status: "unpaid",
    grace: false,
    manualAccess: null,
    localModels: null,
    quantities: { managedAiBasic: 1, managedAiExtended: 0, localModels: 0 },
    activeUserCount: 1,
    policy: { allowByokWithoutPaidAccess: false },
  })

  assert.equal(entitlement.canUseManagedAi, false)
  assert.equal(entitlement.canReadHistory, true)
  assert.equal(entitlement.blockingReason, "payment_required")
})
```

Add coverage for:

- `past_due` with `grace=true` still allowing Managed AI,
- manual access overriding absent Stripe billing,
- Local Models enforcing seat count but not granting Managed AI usage,
- unpaid organization allowing BYOK only when policy enables it,
- requested license count lower than active users returning a validation error.

**Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-entitlements.test.ts
```

Expected: FAIL because `organization-billing.ts` does not exist.

**Step 3: Implement minimal pure domain model**

In `services/den/src/billing/organization-billing.ts`, add string-union types and pure helpers:

```ts
export type OrganizationBillingMode = "none" | "managed_ai" | "local_models" | "manual_access"
export type OrganizationBillingStatus = "none" | "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete"
export type BillingBlockingReason =
  | "payment_required"
  | "payment_failed"
  | "insufficient_licenses"
  | "tier_not_allowed"
  | "organization_access_disabled"

export function deriveOrganizationBillingEntitlement(input: OrganizationBillingEntitlementInput): OrganizationBillingEntitlement {
  // Keep this pure and deterministic; no database or Stripe calls.
}
```

Keep the implementation small: calculate seat limit from quantities, decide read access, decide Managed AI access, preserve grace-period semantics, and return a blocking reason only when needed.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-entitlements.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/billing/organization-billing.ts services/den/test/organization-billing-entitlements.test.ts
git commit -m "feat(den): add organization billing entitlement model"
```

## Task 2: Add Billing Schema And Migration

**Files:**

- Modify: `services/den/src/db/schema.ts`
- Create: `services/den/drizzle/00XX_organization_stripe_billing.sql`
- Test: `services/den/test/skill-registry-schema.test.ts` or create `services/den/test/organization-billing-schema.test.ts`

**Step 1: Write schema tests**

Create a schema source test that asserts all required table exports and enum values exist:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  OrganizationBillingAccountTable,
  OrganizationBillingEventTable,
  OrganizationBillingMode,
  OrganizationBillingSource,
} from "../src/db/schema.js"

test("organization billing schema exports core tables and enums", () => {
  assert.ok(OrganizationBillingAccountTable)
  assert.ok(OrganizationBillingEventTable)
  assert.deepEqual([...OrganizationBillingMode], ["none", "managed_ai", "local_models", "manual_access"])
  assert.ok(OrganizationBillingSource.includes("stripe_checkout"))
  assert.ok(OrganizationBillingSource.includes("stripe_invoice"))
  assert.ok(OrganizationBillingSource.includes("manual_external"))
})
```

**Step 2: Run failing schema test**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-schema.test.ts
```

Expected: FAIL because exports do not exist.

**Step 3: Add schema exports**

Add tables in `services/den/src/db/schema.ts` near other organization-owned tables:

- `organization_billing_account`
- `organization_billing_tier_allowlist`
- `organization_billing_event`

Minimum account fields:

- `id`
- `org_id`
- `mode`
- `source`
- `status`
- `stripe_customer_id`
- `stripe_subscription_id`
- `billing_interval`
- `managed_ai_basic_quantity`
- `managed_ai_extended_quantity`
- `local_models_quantity`
- `manual_access_enabled`
- `manual_access_expires_at`
- `local_models_unit_amount`
- `local_models_currency`
- `payment_problem_code`
- `payment_problem_message`
- `grace_until`
- `cancel_at_period_end`
- timestamps

Minimum event fields:

- `id`
- `org_id`
- `stripe_event_id`
- `stripe_event_type`
- `status`
- `payload`
- `error_message`
- `created_at`
- `processed_at`

Use a unique index on `stripe_event_id` for idempotency.

**Step 4: Add migration**

Create the matching SQL migration. Use existing migration style and update the drizzle journal if this repo requires generated migration metadata.

**Step 5: Run schema and migration tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-schema.test.ts test/drizzle-migration-format.test.ts test/drizzle-migration-ownership.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/db/schema.ts services/den/drizzle services/den/test/organization-billing-schema.test.ts
git commit -m "feat(den): add organization billing schema"
```

## Task 3: Add Stripe Billing Configuration

**Files:**

- Modify: `services/den/src/env.ts`
- Create: `services/den/src/billing/stripe-config.ts`
- Test: `services/den/test/organization-billing-env.test.ts`
- Modify: `services/den/.env.example`

**Step 1: Write env parsing tests**

Test that Stripe billing config parses disabled by default and validates required values when enabled:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { parseEnv } from "../src/env.js"

test("stripe organization billing is disabled by default", () => {
  const env = parseEnv(baseEnv())
  assert.equal(env.organizationBilling.stripe.enabled, false)
})

test("enabled stripe organization billing requires secret and webhook signing secret", () => {
  assert.throws(() => parseEnv({ ...baseEnv(), STRIPE_ORG_BILLING_ENABLED: "true" }), /STRIPE_ORG_BILLING_SECRET_KEY/)
})
```

**Step 2: Run failing test**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-env.test.ts
```

Expected: FAIL because config does not exist.

**Step 3: Implement config**

Add env fields:

- `STRIPE_ORG_BILLING_ENABLED`
- `STRIPE_ORG_BILLING_SECRET_KEY`
- `STRIPE_ORG_BILLING_WEBHOOK_SECRET`
- `STRIPE_ORG_BILLING_SUCCESS_URL`
- `STRIPE_ORG_BILLING_CANCEL_URL`
- `STRIPE_ORG_BILLING_PORTAL_RETURN_URL`
- `STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID`
- `STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID`
- `STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID`
- `STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID`
- `STRIPE_ORG_BILLING_TAX_MODE` with values `manual` or `stripe_tax`

`stripe-config.ts` should expose helpers that map `(tier, interval)` to configured Stripe price ids and fail closed when a price is missing.

**Step 4: Update `.env.example`**

Add commented example values and short comments explaining that Den owns entitlement and Stripe owns payment.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-env.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/env.ts services/den/src/billing/stripe-config.ts services/den/test/organization-billing-env.test.ts services/den/.env.example
git commit -m "feat(den): configure stripe organization billing"
```

## Task 4: Add Billing Repository And Active Seat Integration

**Files:**

- Create: `services/den/src/billing/repository.ts`
- Test: `services/den/test/organization-billing-repository.test.ts`
- Modify: `services/den/src/org-admin/repository.ts`
- Test: `services/den/test/org-admin-repository.test.ts`

**Step 1: Write repository tests**

Use an in-memory fake store first. Cover:

- creating or updating an organization billing account,
- computing active license limit,
- rejecting a requested decrease below active user count,
- applying manual access expiration,
- counting active memberships with `status === "active"` only.

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-repository.test.ts test/org-admin-repository.test.ts
```

Expected: FAIL because repository does not exist and org-admin still reads `org.seat_limit`.

**Step 3: Implement billing repository**

Add methods:

- `getBillingAccount(orgId)`
- `upsertBillingAccount(input)`
- `listAllowedTiers(orgId)`
- `setAllowedTiers(orgId, tiers)`
- `countActiveUsers(orgId)`
- `deriveEntitlement(orgId)`
- `assertRequestedQuantitiesCanCoverActiveUsers(input)`
- `recordBillingEvent(input)`

Keep database access behind interfaces so pure tests can cover logic without MySQL.

**Step 4: Integrate active seat checks**

Update `services/den/src/org-admin/repository.ts` so seat activation consults billing-derived limits when present. Preserve existing `org.seat_limit` behavior as a fallback until all callers move to billing.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-repository.test.ts test/org-admin-repository.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/billing/repository.ts services/den/src/org-admin/repository.ts services/den/test/organization-billing-repository.test.ts services/den/test/org-admin-repository.test.ts
git commit -m "feat(den): derive organization seats from billing"
```

## Task 5: Add Stripe Checkout, Portal, And Subscription Mutation Service

**Files:**

- Create: `services/den/src/billing/stripe.ts`
- Create: `services/den/src/billing/stripe-service.ts`
- Test: `services/den/test/organization-billing-stripe-service.test.ts`
- Modify: `services/den/package.json`

**Step 1: Add Stripe dependency**

Add the official `stripe` package to `services/den/package.json`.

**Step 2: Write service tests with a fake Stripe client**

Cover:

- checkout session uses only allowed price ids,
- checkout rejects requested seats below active user count,
- portal session requires an existing Stripe customer,
- adding seats uses immediate proration,
- reducing seats creates next-period behavior instead of immediate removal,
- cancellation sets cancel-at-period-end.

**Step 3: Run failing tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-stripe-service.test.ts
```

Expected: FAIL because service does not exist.

**Step 4: Implement service**

Keep the service thin and dependency-injected:

- `createManagedAiCheckoutSession(input)`
- `createBillingPortalSession(input)`
- `updateManagedAiSubscriptionQuantities(input)`
- `cancelManagedAiSubscriptionAtPeriodEnd(input)`
- `createLocalModelsStripeInvoiceOrSubscription(input)` as a platform-admin-only service hook.

Do not compute final price in Den. Pass Stripe price ids, quantities, interval, success URL, cancel URL, and metadata containing `orgId`, `billingMode`, and actor user id.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-stripe-service.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/package.json pnpm-lock.yaml services/den/src/billing/stripe.ts services/den/src/billing/stripe-service.ts services/den/test/organization-billing-stripe-service.test.ts
git commit -m "feat(den): add stripe billing service"
```

## Task 6: Add Stripe Webhook Handler

**Files:**

- Create: `services/den/src/http/organization-billing-webhook.ts`
- Create: `services/den/src/billing/stripe-webhooks.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/organization-billing-webhook.test.ts`

**Step 1: Write webhook tests**

Cover:

- invalid signature returns 400,
- duplicate Stripe event id is idempotent,
- `checkout.session.completed` links customer/subscription to org,
- `customer.subscription.updated` updates status and quantities,
- `invoice.payment_failed` stores payment problem state,
- `invoice.payment_succeeded` clears payment problem state,
- `customer.subscription.deleted` removes active Managed AI entitlement,
- unknown event type is stored as ignored without failing.

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-webhook.test.ts
```

Expected: FAIL because handler does not exist.

**Step 3: Implement webhook processing**

Use raw request body for Stripe signature verification. Keep event handling in `stripe-webhooks.ts` so it is testable without Express.

Persist each event before applying business changes. Mark event status as:

- `applied`
- `ignored`
- `failed`

**Step 4: Wire route in `index.ts`**

Mount the webhook route before JSON body parsing if the app currently uses a global JSON parser. If route ordering makes that hard, add an isolated `express.raw({ type: "application/json" })` parser for the webhook path.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-webhook.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/organization-billing-webhook.ts services/den/src/billing/stripe-webhooks.ts services/den/src/index.ts services/den/test/organization-billing-webhook.test.ts
git commit -m "feat(den): process stripe organization billing webhooks"
```

## Task 7: Add Admin Billing API Contract

**Files:**

- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Test: `services/den/test/admin-contract.test.ts`
- Test: `services/den/test/organization-billing-admin-routes.test.ts`

**Step 1: Write contract tests**

Assert that:

- `billing` is an organization-admin capability and allowed page,
- platform admins also receive billing capability,
- route deps include billing methods,
- serializers expose billing status and entitlement snapshot without Stripe secrets.

**Step 2: Run failing contract tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-contract.test.ts test/organization-billing-admin-routes.test.ts
```

Expected: FAIL because billing is not in the admin contract.

**Step 3: Add route deps and routes**

Add route deps:

- `getOrganizationBilling`
- `createOrganizationBillingCheckout`
- `createOrganizationBillingPortalSession`
- `updateOrganizationBillingPlan`
- `cancelOrganizationBilling`
- `updatePlatformOrganizationBilling`

Add routes under `/admin/api`:

- `GET /organizations/:orgId/billing`
- `POST /organizations/:orgId/billing/checkout`
- `POST /organizations/:orgId/billing/portal`
- `PATCH /organizations/:orgId/billing/plan`
- `POST /organizations/:orgId/billing/cancel`
- `PATCH /organizations/:orgId/billing/platform`

Organization admins can call only self-serve Managed AI routes for their org. Platform admins can call all routes.

**Step 4: Implement runtime deps**

In `admin-runtime.ts`, wire route deps to the billing repository and Stripe service. Record admin audit events for every mutation.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-contract.test.ts test/organization-billing-admin-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/admin.ts services/den/src/http/admin-runtime.ts services/den/test/admin-contract.test.ts services/den/test/organization-billing-admin-routes.test.ts
git commit -m "feat(den): expose organization billing admin api"
```

## Task 8: Add Den Public Admin Billing UI

**Files:**

- Modify: `services/den/public-admin/app.js`
- Modify: `services/den/public-admin/app.css`
- Test: `services/den/test/admin-managed-ai-ui.test.ts` or create `services/den/test/organization-billing-admin-ui.test.ts`

**Step 1: Write UI source tests**

Use existing static UI tests as precedent. Assert that:

- navigation includes Billing,
- billing page title and summary are present,
- Basic and Extended quantity controls are present,
- interval control is present,
- platform-only Local Models controls are gated on platform admin state,
- Customer Portal action exists,
- UI does not expose Stripe secret keys.

**Step 2: Run failing UI tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-admin-ui.test.ts
```

Expected: FAIL because UI does not include Billing.

**Step 3: Add billing state and rendering**

In `app.js`:

- add `billing` page to page normalization and navigation,
- load billing payload for selected organization,
- render license usage,
- render Managed AI self-serve form,
- render Checkout and Portal actions,
- render payment warning states,
- render platform-only Local Models/manual access controls.

In `app.css`, add compact form, status, and warning styles that match existing admin UI density.

**Step 4: Add action handlers**

Handlers should call the new admin billing endpoints and redirect to returned Stripe URLs where appropriate.

**Step 5: Run UI tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-admin-ui.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/public-admin/app.js services/den/public-admin/app.css services/den/test/organization-billing-admin-ui.test.ts
git commit -m "feat(den): add organization billing admin ui"
```

## Task 9: Enforce Entitlements In Managed AI Proxy

**Files:**

- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Create or modify: `services/den/src/managed-ai/auth/gateway-session.ts`
- Test: `services/den/test/managed-ai-proxy-billing-entitlement.test.ts`

**Step 1: Write proxy tests**

Cover:

- active Managed AI entitlement allows proxy request to continue,
- unpaid Managed AI entitlement returns 402 or 403 with `payment_required`,
- `past_due` in grace allows request and exposes a warning header or diagnostic payload if current route style allows,
- Local Models route/policy does not block BYOK/local-provider inference,
- existing `ai_access_not_configured` behavior remains intact after billing passes.

**Step 2: Run failing proxy tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/managed-ai-proxy-billing-entitlement.test.ts
```

Expected: FAIL because proxy does not consult billing.

**Step 3: Inject billing entitlement dependency**

Extend `ProxyDependencies` with an optional billing entitlement resolver:

```ts
billingEntitlements?: {
  getForGatewaySession(session: GatewaySession): Promise<OrganizationBillingEntitlement>
}
```

Resolve the org id from the gateway session. If gateway sessions do not currently carry an org id, add it to the session creation/read model in a separate small step with tests.

**Step 4: Add gate before provider routing**

After auth and before AI access lookup, check entitlement:

- if no resolver exists, preserve current behavior for tests/dev,
- if blocked, return a clear billing error,
- if allowed, store entitlement in `res.locals` for provider routes or diagnostics.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/managed-ai-proxy-billing-entitlement.test.ts test/managed-ai-proxy-auth.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/auth/gateway-session.ts services/den/test/managed-ai-proxy-billing-entitlement.test.ts
git commit -m "feat(den): gate managed ai by organization billing"
```

## Task 10: Add User Transfer And Single-Organization Enforcement

**Files:**

- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/org-admin/repository.ts`
- Test: `services/den/test/multi-tenant-rules.test.ts`
- Test: `services/den/test/organization-billing-admin-routes.test.ts`

**Step 1: Write tests**

Cover:

- organization admin cannot add a user already active in another organization,
- platform admin can transfer a user to another organization,
- transfer respects target organization's license limit,
- transfer preserves user history for admins,
- disabled/removed memberships do not count as active seats.

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/multi-tenant-rules.test.ts test/organization-billing-admin-routes.test.ts
```

Expected: FAIL for transfer flow and single-org constraints.

**Step 3: Implement single-org checks**

Before creating or activating membership, check for an existing active membership in another org. Return a stable error such as `user_already_belongs_to_another_org`.

**Step 4: Implement platform-admin transfer route**

Add a platform-admin-only route under admin API:

- `POST /organizations/:orgId/members/transfer`

Body:

```json
{ "userId": "user_...", "role": "member" }
```

The route disables/removes prior active membership and creates/activates target membership in one transaction after checking target license capacity.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/multi-tenant-rules.test.ts test/organization-billing-admin-routes.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/admin-runtime.ts services/den/src/org-admin/repository.ts services/den/test/multi-tenant-rules.test.ts services/den/test/organization-billing-admin-routes.test.ts
git commit -m "feat(den): enforce single organization membership"
```

## Task 11: Add Durable Documentation

**Files:**

- Create: `docs/features/organization-billing.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `docs/dev/documentation-map.md`

**Step 1: Write docs**

Document shipped behavior only:

- Managed AI subscriptions,
- Local Models custom licensing,
- license limits,
- payment grace behavior,
- entitlement snapshot semantics,
- Stripe env/config,
- webhook operational notes,
- admin UI scope,
- non-goals deferred from MVP.

**Step 2: Add documentation map entry**

Add the new feature doc to `docs/dev/documentation-map.md`.

**Step 3: Run docs/source sanity checks**

Run:

```bash
rg -n "organization billing|Stripe|Local Models|billing entitlement" docs/features docs/dev
git diff --check -- docs/features/organization-billing.md docs/features/session-runtime.md docs/dev/state-and-config-reference.md docs/dev/cloud-deployments.md docs/dev/documentation-map.md
```

Expected: relevant docs mention the shipped behavior and whitespace check passes.

**Step 4: Commit**

```bash
git add docs/features/organization-billing.md docs/features/session-runtime.md docs/dev/state-and-config-reference.md docs/dev/cloud-deployments.md docs/dev/documentation-map.md
git commit -m "docs: document organization billing behavior"
```

## Task 12: End-To-End Verification

**Files:**

- Create or modify: `packages/e2e/specs/organization-billing.spec.ts`
- Modify only if needed: `packages/e2e/helpers/live-admin-client.ts`
- Modify only if needed: `packages/e2e/helpers/desktop-auth-seed.ts`
- Create: `packages/e2e/helpers/fake-stripe-billing.ts`
- Create: `services/den/test/fixtures/stripe-organization-billing-events.ts`

**Step 1: Add E2E scenario**

Use the real locally running Den admin for all billing UI behavior. Use the real Tauri desktop runtime for app/runtime behavior. Use Den test hooks, a fake Stripe client, and local Stripe webhook fixtures for Stripe responses; do not call live Stripe in the required E2E suite.

Core scenario:

1. Seed an organization admin.
2. Open the local Den admin billing page.
3. Create Managed AI checkout from the UI with Basic and Extended quantities.
4. Simulate `checkout.session.completed` and subscription activation.
5. Verify the Den admin shows active billing, license usage, Customer Portal access, and the selected quantities.
6. Verify desktop can start a Managed AI request.
7. Simulate `invoice.payment_failed` and `past_due`.
8. Verify Den admin shows the payment warning while inference remains available during grace.
9. Simulate final `unpaid`.
10. Verify history/settings remain readable.
11. Verify new Managed AI inference is blocked with a payment-required message.
12. Configure Local Models custom billing from the platform admin UI.
13. Verify active user limit remains enforced.
14. Verify local/BYOK inference is not blocked by Managed AI entitlement.

Additional required E2E coverage:

- canceled or expired checkout returns to the billing page without granting access,
- adding seats applies immediately in the UI and entitlement snapshot,
- reducing seats and Extended-to-Basic downgrade appear as next-period changes,
- reducing below active user count is rejected in the UI,
- deactivating a user releases a license,
- Customer Portal action opens the simulated portal URL,
- cancel-at-period-end remains active until period end and then blocks Managed AI after the simulated final event,
- platform admin allowlist changes alter which Managed AI tiers the org admin can select,
- manual access/admin override enables Managed AI without showing trial language,
- Local Models custom price, interval, billing source, and quantity are visible to platform admin and read-only for organization admin,
- single-organization membership and platform-admin transfer behavior are covered.

Required Stripe simulation matrix:

- checkout session: completed, canceled, expired,
- portal session: URL created, missing customer error,
- subscription: created, updated, deleted,
- subscription status: active, incomplete, past_due, unpaid, canceled,
- subscription quantities: Basic only, Extended only, mixed Basic/Extended, quantity increase, scheduled quantity decrease, scheduled downgrade,
- invoice: payment succeeded, payment failed,
- payment method: attached or updated if the handler supports it,
- refund or credit note events if the handler supports them,
- webhook processing: valid signature, invalid signature, duplicate event id, unknown event type.

**Step 2: Follow desktop test preflight**

Before any desktop E2E run, follow `docs/dev/testing-playbook.md`:

- detect Veslo dev/test processes from this repo,
- terminate internally started instances,
- verify no relevant process remains,
- launch the intended desktop runtime from `packages/desktop`.

Do not use `packages/web` or Vite as the app runtime.

**Step 3: Start the local admin under test**

Start Den locally with the fake Stripe billing configuration enabled. The test harness should launch or verify the local Den service, then open its hosted admin page. Do not test billing through static files alone.

Expected: the local admin page loads with the seeded admin session and billing navigation available.

**Step 4: Run focused Den and app checks**

Run:

```bash
pnpm --filter @neatech/den test -- test/organization-billing-*.test.ts test/managed-ai-proxy-billing-entitlement.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Run local-admin billing E2E**

Run the focused local-admin E2E spec:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/organization-billing.spec.ts
```

Expected: PASS with all local admin billing features covered and all Stripe outputs simulated through fixtures/fakes.

**Step 6: Run desktop E2E**

Run the focused WebdriverIO spec against the real Tauri runtime if it is split from the local-admin billing spec:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/organization-billing.spec.ts
```

Expected: PASS against the real Tauri desktop runtime.

**Step 7: Run full relevant suite before PR**

Run:

```bash
pnpm --filter @neatech/den test
pnpm typecheck
pnpm test:e2e
```

Expected: PASS.

If desktop E2E is blocked by an already-running Veslo process from this repo and the task rules do not allow terminating or reusing it, follow `AGENTS.md`: schedule a 10-minute retry automation and keep retrying until the real Tauri-runtime test completes or the user changes scope.

**Step 8: Commit**

```bash
git add packages/e2e/specs/organization-billing.spec.ts packages/e2e/helpers/live-admin-client.ts packages/e2e/helpers/desktop-auth-seed.ts packages/e2e/helpers/fake-stripe-billing.ts services/den/test/fixtures/stripe-organization-billing-events.ts
git commit -m "test: verify organization billing runtime behavior"
```
