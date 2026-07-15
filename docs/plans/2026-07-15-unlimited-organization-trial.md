# Unlimited Organization Trial Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every existing and newly created Veslo organization a revocable Managed AI trial with no Veslo expiration, seat limit, or token limit while preserving usage accounting and Stripe handoff.

**Architecture:** Den keeps the entitlement organization-scoped and stores an explicit unlimited flag on manual access. A database migration backfills every non-Stripe organization, while the canonical organization creation transaction writes the same default for future organizations. Admin APIs and UI expose the state without sentinel quantities, and Stripe activation clears it.

**Tech Stack:** TypeScript, Node test runner, Drizzle ORM/MySQL migrations, Express, browser JavaScript, Playwright, Docker Compose production workflow.

---

### Task 1: Model unlimited billing entitlements

**Files:**
- Modify: `services/den/test/organization-billing-entitlements.test.ts`
- Modify: `services/den/src/billing/organization-billing.ts`

**Step 1: Write the failing tests**

Add a test proving an enabled unlimited manual grant permits Managed AI and BYOK/local-provider access with more active users than any finite quantity, returns `isUnlimited: true`, and returns `licenseLimit: null`. Add a finite-access assertion proving the existing numeric behavior remains unchanged.

```ts
const entitlement = deriveOrganizationBillingEntitlement({
  mode: "manual_access",
  status: "trialing",
  grace: false,
  manualAccess: { enabled: true, allowManagedAi: true, unlimited: true, licenseLimit: 0 },
  quantities: emptyQuantities,
  activeUserCount: 10_000,
  policy: defaultPolicy,
})
assert.equal(entitlement.canUseManagedAi, true)
assert.equal(entitlement.isUnlimited, true)
assert.equal(entitlement.licenseLimit, null)
```

**Step 2: Run the test to verify it fails**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-entitlements.test.ts`
Expected: FAIL because unlimited access is not modeled and the license limit is still numeric.

**Step 3: Implement the minimal domain change**

Add `unlimited` to `OrganizationManualAccess`, add `isUnlimited` to the derived entitlement, make `licenseLimit` nullable only for unlimited access, and calculate seat sufficiency as unlimited-or-numeric-capacity. Leave payment, organization, tier, and history checks unchanged.

**Step 4: Run the test to verify it passes**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-entitlements.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/test/organization-billing-entitlements.test.ts services/den/src/billing/organization-billing.ts
git commit -m "feat(den): model unlimited billing entitlement"
```

### Task 2: Persist and backfill unlimited trials

**Files:**
- Create: `services/den/drizzle/0020_unlimited_organization_trial.sql`
- Create: `services/den/drizzle/meta/0020_snapshot.json`
- Modify: `services/den/drizzle/meta/_journal.json`
- Modify: `services/den/src/db/schema.ts`
- Modify: `services/den/src/billing/repository.ts`
- Modify: `services/den/test/organization-billing-schema.test.ts`
- Modify: `services/den/test/organization-billing-repository.test.ts`

**Step 1: Write the failing schema and repository tests**

Require `manual_access_unlimited` in the schema, migration, and Drizzle journal. Require the migration to insert missing billing accounts and update non-Stripe accounts to unlimited trials while guarding configured Stripe subscriptions. Add repository tests for round-trip mapping, entitlement derivation, and skipped active-user validation for unlimited manual access.

**Step 2: Run tests to verify they fail**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-schema.test.ts test/organization-billing-repository.test.ts`
Expected: FAIL because the field and migration do not exist.

**Step 3: Implement schema and repository support**

Add a non-null boolean column defaulting false. Extend records and upserts with `manualAccessUnlimited`. In repository entitlement derivation pass the explicit flag, and in active-user validation skip the numeric limit only when unlimited is true.

Create a migration that:

```sql
ALTER TABLE `organization_billing_account`
  ADD `manual_access_unlimited` boolean NOT NULL DEFAULT false AFTER `manual_access_enabled`;

INSERT INTO `organization_billing_account` (...)
SELECT ..., 'manual_access', 'manual_trial', 'trialing', true, true, ...
FROM `org`
LEFT JOIN `organization_billing_account` ON ...
WHERE `organization_billing_account`.`id` IS NULL;

UPDATE `organization_billing_account`
SET ... unlimited trial fields ...
WHERE `stripe_subscription_id` IS NULL;
```

Generate or update the Drizzle snapshot and journal consistently with the repository convention.

**Step 4: Run tests to verify they pass**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-schema.test.ts test/organization-billing-repository.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/drizzle services/den/src/db/schema.ts services/den/src/billing/repository.ts services/den/test/organization-billing-schema.test.ts services/den/test/organization-billing-repository.test.ts
git commit -m "feat(den): persist and backfill unlimited trials"
```

### Task 3: Default newly created organizations transactionally

**Files:**
- Modify: `services/den/src/orgs.ts`
- Create: `services/den/test/default-organization-billing.test.ts`

**Step 1: Write the failing test**

Extract a dependency-injected helper around the default-organization write and test that a new organization transaction inserts the organization, owner membership, and billing account with:

```ts
{
  mode: "manual_access",
  source: "manual_trial",
  status: "trialing",
  manual_access_enabled: true,
  manual_access_unlimited: true,
  manual_access_expires_at: null,
}
```

Also prove an existing membership returns its organization without overwriting billing state, and a failed billing insert rolls back the whole transaction.

**Step 2: Run the test to verify it fails**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/default-organization-billing.test.ts`
Expected: FAIL because default organization creation does not create billing state transactionally.

**Step 3: Implement the transactional creation**

Use `db.transaction` for the three inserts. Keep the initial membership lookup idempotent. Export only the narrow dependency-injected helper needed by the test; keep `ensureDefaultOrg` as the production facade.

**Step 4: Run the test to verify it passes**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/default-organization-billing.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/orgs.ts services/den/test/default-organization-billing.test.ts
git commit -m "feat(den): default new organizations to unlimited trial"
```

### Task 4: Support unlimited trials in admin and Stripe handoff

**Files:**
- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/billing/stripe-webhooks.ts`
- Modify: `services/den/test/organization-billing-admin-routes.test.ts`
- Modify: `services/den/test/organization-billing-webhook.test.ts`

**Step 1: Write failing API tests**

Add platform-admin route tests that create an unlimited trial with no expiry or quantities, reject an unlimited trial with an expiry, serialize `manualAccess.unlimited`, return `licenseLimit: null`, revoke it by clearing the unlimited flag, and still reject trial creation over Stripe. Add webhook tests requiring active Stripe evidence to clear `manualAccessUnlimited`.

**Step 2: Run tests to verify they fail**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-admin-routes.test.ts test/organization-billing-webhook.test.ts`
Expected: FAIL because unlimited input and output are not supported and Stripe does not clear the field.

**Step 3: Implement API parsing, serialization, and Stripe clearing**

Parse `manualAccess.unlimited` strictly as a boolean. For an unlimited manual trial require `expiresAt=null`, bypass finite license validation, store zero quantities, and include the flag in admin output. On revoke and all active Stripe handoff paths explicitly write `manualAccessUnlimited: false`.

**Step 4: Run tests to verify they pass**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-admin-routes.test.ts test/organization-billing-webhook.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/admin.ts services/den/src/http/admin-runtime.ts services/den/src/billing/stripe-webhooks.ts services/den/test/organization-billing-admin-routes.test.ts services/den/test/organization-billing-webhook.test.ts
git commit -m "feat(den): expose unlimited trial controls"
```

### Task 5: Render and control unlimited trial in Admin

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/den/test/organization-billing-admin-ui-source.test.ts`
- Modify: `packages/e2e/specs/den-admin-billing-lifecycle.playwright.spec.ts`

**Step 1: Write failing UI source and E2E assertions**

Require the source to send `manualAccess: { enabled: true, unlimited: true, expiresAt: null }`, render `Unlimited trial` and `Unlimited` capacity, and revoke with `unlimited: false`. Update the billing lifecycle fixture and add the user-visible assertions.

**Step 2: Run tests to verify they fail**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-admin-ui-source.test.ts`
Expected: FAIL because the UI still requires a trial end date and finite quantities.

Run: `npx -y pnpm@10.27.0 --filter @neatech/veslo-e2e exec playwright test specs/den-admin-billing-lifecycle.playwright.spec.ts`
Expected: FAIL on the unlimited trial assertions.

**Step 3: Implement UI behavior**

Make active-trial detection accept explicit unlimited trials. Display `Unlimited trial`, `Unlimited` license total/limit/availability, and explanatory no-expiry text. Change the platform action to create an unlimited trial without an end date or selected license count. Preserve finite trial rendering for historical records and keep revoke available.

**Step 4: Run tests to verify they pass**

Run the two commands from Step 2.
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/public-admin services/den/test/organization-billing-admin-ui-source.test.ts packages/e2e/specs/den-admin-billing-lifecycle.playwright.spec.ts
git commit -m "feat(admin): manage unlimited organization trials"
```

### Task 6: Document durable behavior and verify the complete change

**Files:**
- Modify: `docs/features/organization-billing.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update canonical documentation**

Document the default unlimited trial, explicit stored state, no Veslo expiry/seat/token cap, continued usage accounting and upstream limits, revocation, migration scope, new-organization default, and Stripe replacement behavior.

**Step 2: Run the Den billing suite**

Run: `npx -y pnpm@10.27.0 exec tsx --test test/organization-billing-*.test.ts test/default-organization-billing.test.ts`
Expected: all tests PASS.

**Step 3: Build Den**

Run: `npx -y pnpm@10.27.0 --filter @neatech/den build`
Expected: exit 0 with no TypeScript errors.

**Step 4: Run the primary E2E scenario**

Run: `npx -y pnpm@10.27.0 --filter @neatech/veslo-e2e exec playwright test specs/den-admin-billing-lifecycle.playwright.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add docs/features/organization-billing.md docs/dev/state-and-config-reference.md
git commit -m "docs: define unlimited trial billing behavior"
```

### Task 7: Push, deploy, and verify production

**Files:**
- No source changes expected.

**Step 1: Review and push the exact branch**

Run: `git status --short --branch && git log --oneline origin/main..HEAD`
Expected: clean branch with only the reviewed unlimited-trial commits.

Run: `git push -u origin codex/unlimited-trial`
Expected: the exact local HEAD exists on the remote feature branch.

**Step 2: Dispatch the owned-server deployment with a fresh backup**

Run:

```bash
gh workflow run deploy-owned-server.yml \
  --repo neatechcz/veslo \
  --ref codex/unlimited-trial \
  -f branch=codex/unlimited-trial \
  -f install_backup_timer=true \
  -f run_backup_now=true
```

Expected: workflow dispatch succeeds. Follow the run to completion and require migration, Compose startup, and public health checks to pass.

**Step 3: Verify migrated production state**

On the owned-server runner/host, query only non-secret billing fields and prove that every organization without a Stripe subscription has enabled unlimited manual trial access and no expiry, while Stripe subscriptions were preserved.

Expected: zero non-Stripe organizations outside the unlimited trial state.

**Step 4: Verify new-organization behavior**

Create a disposable organization through the supported production signup/default-organization path, inspect its billing facade, then remove the disposable data only through an approved supported cleanup path.

Expected: `source=manual_trial`, `manualAccess.unlimited=true`, `licenseLimit=null`, `canUseManagedAi=true`.

**Step 5: Verify inference and usage accounting**

Use an authenticated existing trial organization to call the production Managed AI gateway with a minimal prompt. Confirm the response passes the former 402 billing gate and that the corresponding usage record exists.

Expected: provider response succeeds or reports a genuine upstream capacity condition, never `managed_ai_entitlement_denied`; usage is recorded for successful inference.
