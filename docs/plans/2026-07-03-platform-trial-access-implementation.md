# Platform Trial Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add platform-admin trial access for organizations using the existing Den billing workspace and backend manual-access model.

**Architecture:** Use the existing organization billing account as the source of truth. Platform trial grants are stored as `manual_access` with `manual_trial` source, Basic/Extended quantities, and `manual_access_expires_at`; Stripe webhooks clear trial access once a subscription becomes active. The admin UI reuses the existing Basic/Extended billing controls and adds trial end-date actions only for platform admins.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL, static Den admin HTML/JS, Node test runner, Playwright.

---

### Task 1: Backend Trial Grant Rules

**Files:**
- Modify: `services/den/src/http/admin-runtime.ts`
- Test: `services/den/test/organization-billing-admin-routes.test.ts`

**Step 1: Write failing route tests**

Add focused tests proving:

- platform admin can grant a trial with Basic/Extended quantities and expiry
- organization admin cannot grant a trial
- platform admin cannot grant a trial when `stripeSubscriptionId` is configured
- missing/past expiry returns `invalid_manual_access_expires_at`

Use the existing `runtimeBillingRouteDeps` helper and call:

```ts
await fetch(`${baseUrl}/organizations/org_1/billing/platform`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    quantities: { managedAiBasic: 2, managedAiExtended: 1 },
    manualAccess: {
      enabled: true,
      expiresAt: "2026-07-17T23:59:59.000Z",
    },
  }),
})
```

Expected trial summary:

```ts
assert.equal(payload.billing.account.mode, "manual_access")
assert.equal(payload.billing.account.source, "manual_trial")
assert.equal(payload.billing.account.manualAccess.enabled, true)
assert.equal(payload.billing.account.quantities.managedAiBasic, 2)
assert.equal(payload.billing.account.quantities.managedAiExtended, 1)
```

**Step 2: Verify the tests fail**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-routes.test.ts
```

Expected: FAIL because the current platform billing route does not enforce the trial-specific expiry/subscription rules.

**Step 3: Implement minimal backend validation**

In `readPlatformBillingUpdate` or a small helper it calls:

- detect trial intent when `mode === "manual_access"` and `source === "manual_trial"`
- require `manualAccess.expiresAt`
- require expiry to be future relative to `new Date()`
- reject trial grant/edit when an existing account has `stripeSubscriptionId`
- return `stripe_subscription_exists` for that rejection

Keep non-trial manual access behavior unchanged unless the request explicitly uses `manual_trial`.

**Step 4: Verify route tests pass**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-routes.test.ts
```

Expected: PASS.

---

### Task 2: Trial Revoke Behavior

**Files:**
- Modify: `services/den/src/http/admin-runtime.ts`
- Test: `services/den/test/organization-billing-admin-routes.test.ts`
- Test: `services/den/test/organization-billing-entitlements.test.ts`

**Step 1: Write failing tests**

Add route coverage for revoking a trial:

```ts
body: JSON.stringify({
  mode: "none",
  source: null,
  status: "none",
  quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
  manualAccess: { enabled: false, expiresAt: null },
})
```

Assert the resulting entitlement blocks Managed AI and has no grace warning.

**Step 2: Verify the tests fail**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-routes.test.ts test/organization-billing-entitlements.test.ts
```

Expected: FAIL if revoke does not fully clear manual access/quantities.

**Step 3: Implement revoke support**

Make sure platform billing update can set `manualAccess.expiresAt` to `null`, disable manual access, clear quantities, and return a blocked entitlement without grace.

**Step 4: Verify tests pass**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-routes.test.ts test/organization-billing-entitlements.test.ts
```

Expected: PASS.

---

### Task 3: Stripe Webhook Clears Active Trial

**Files:**
- Modify: `services/den/src/billing/stripe-webhooks.ts`
- Test: `services/den/test/organization-billing-webhook.test.ts`

**Step 1: Write failing webhook test**

Seed an organization billing account with:

```ts
{
  mode: "manual_access",
  source: "manual_trial",
  status: "active",
  manualAccessEnabled: true,
  manualAccessExpiresAt: new Date("2026-07-17T23:59:59.000Z"),
  managedAiBasicQuantity: 2,
  managedAiExtendedQuantity: 1,
}
```

Then process `checkout.session.completed` or an active `customer.subscription.updated` event for the same org.

Assert:

```ts
assert.equal(account.mode, "managed_ai")
assert.equal(account.source, "stripe_checkout") // or subscription source for update
assert.equal(account.manualAccessEnabled, false)
assert.equal(account.manualAccessExpiresAt, null)
```

**Step 2: Verify the test fails**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-webhook.test.ts
```

Expected: FAIL until webhook upserts clear the manual trial fields.

**Step 3: Clear trial fields in Stripe account upserts**

When Stripe checkout/subscription events upsert the billing account, explicitly set:

```ts
manualAccessEnabled: false,
manualAccessExpiresAt: null,
```

Do this only in Stripe-owned event application, not in generic repository merge behavior.

**Step 4: Verify webhook tests pass**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-webhook.test.ts
```

Expected: PASS.

---

### Task 4: Platform Trial UI Source Test

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Test: `services/den/test/organization-billing-admin-ui-source.test.ts`

**Step 1: Write failing source test**

Assert the admin UI includes:

- `billing-trial-end-date`
- `billing-create-trial-button`
- `billing-revoke-trial-button`
- request to `/organizations/${encodeURIComponent(orgId)}/billing/platform`
- display text `Trial access is active`

**Step 2: Verify the test fails**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-ui-source.test.ts
```

Expected: FAIL because the current UI has placeholder platform controls only.

**Step 3: Add minimal static UI hooks**

In the platform-only billing controls area, add:

- date input labeled `Trial ends on`
- `Create trial` button
- `Revoke trial` button
- optional note input only if it fits without clutter

Keep the existing Basic/Extended quantity inputs as the source for trial quantities.

**Step 4: Add JS wiring**

In `app.js`:

- add element references
- render trial status based on `account.mode === "manual_access"` and `account.source === "manual_trial"`
- submit trial via `PATCH /organizations/:orgId/billing/platform`
- revoke trial via the same route
- refresh selected billing after success
- disable trial creation when `account.stripe.subscriptionConfigured === true`

**Step 5: Verify source test passes**

Run:

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-admin-ui-source.test.ts
```

Expected: PASS.

---

### Task 5: Playwright Trial UI Flow

**Files:**
- Modify: `packages/e2e/specs/den-admin-billing-lifecycle.playwright.spec.ts`

**Step 1: Write failing Playwright tests**

Add coverage that:

- platform admin creates a trial using Basic and Extended quantity inputs
- org admin sees `Trial access is active`
- checkout remains available during trial
- platform admin edits trial seats/end date
- platform admin revokes trial and UI shows blocked access
- platform admin cannot create trial when Stripe subscription is configured

Use the existing harness and add handling for `PATCH /billing/platform`.

**Step 2: Verify tests fail**

Run:

```bash
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-lifecycle
```

Expected: FAIL until UI is wired.

**Step 3: Finish UI behavior**

Adjust rendering and handlers until the user flow works in the harness.

**Step 4: Verify Playwright lifecycle passes**

Run:

```bash
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-lifecycle
```

Expected: PASS.

---

### Task 6: Integrated Local Admin Verification

**Files:**
- Modify: `packages/e2e/specs/den-admin-billing-integrated.playwright.spec.ts`

**Step 1: Add integrated assertions**

For platform admin billing view, assert the trial controls are visible. For organization admin billing view, assert trial controls are hidden.

**Step 2: Run integrated suite against local Den**

Run with the running local backend:

```bash
VESLO_E2E_DEN_ADMIN_BASE=http://127.0.0.1:8788 \
VESLO_E2E_DEN_DB_CONTAINER=veslo-manual-den-db \
VESLO_E2E_DEN_BILLING_ORG_ID=76c72116-2923-4457-910c-112d55b42844 \
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-integrated
```

Expected: PASS.

---

### Task 7: Documentation And Full Verification

**Files:**
- Modify: `docs/features/organization-billing.md`
- Modify: `docs/dev/state-and-config-reference.md` only if new env/config is added
- Modify: `docs/dev/documentation-map.md` only if new durable docs are added

**Step 1: Update durable feature docs**

Document platform trials:

- platform-admin only
- Stripe subscription guard
- trial expiry/revoke has no grace
- Stripe activation clears trial
- org can buy during trial

**Step 2: Run focused backend suite**

```bash
cd services/den
pnpm exec tsx --test test/organization-billing-*.test.ts test/managed-ai-proxy-entitlement.test.ts test/managed-ai-codex-only-runtime.test.ts
```

Expected: PASS.

**Step 3: Run UI suites**

```bash
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-lifecycle
VESLO_E2E_DEN_ADMIN_BASE=http://127.0.0.1:8788 VESLO_E2E_DEN_DB_CONTAINER=veslo-manual-den-db VESLO_E2E_DEN_BILLING_ORG_ID=76c72116-2923-4457-910c-112d55b42844 pnpm --filter @neatech/veslo-e2e test:den-admin-billing-integrated
```

Expected: PASS.

**Step 4: Run build and hygiene**

```bash
pnpm --filter @neatech/den build
git diff --check
rg -n "<known-secret-prefixes>" --glob '!node_modules/**' --glob '!services/den/.env.local' --glob '!packages/e2e/test-results/**' .
graphify update .
```

Expected: build passes, whitespace clean, only fake test secrets are found, graphify updates.

**Step 5: Reset manual test state**

```bash
docker exec -i veslo-manual-den-db mysql -uden -pden den --batch --execute "DELETE FROM organization_billing_event WHERE org_id='76c72116-2923-4457-910c-112d55b42844'; DELETE FROM organization_billing_account WHERE org_id='76c72116-2923-4457-910c-112d55b42844';"
curl -sS http://127.0.0.1:8788/health
```

Expected: local manual backend remains healthy with a clean billing state.
