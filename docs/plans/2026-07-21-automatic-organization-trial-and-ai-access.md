# Automatic Organization Trial and AI Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every organization one non-resetting 14-day trial, make AI Access enabled by default, and reduce organization-member AI administration to an enabled switch plus the platform-admin switch.

**Architecture:** DEN owns an idempotent organization-trial initializer used for new personal organizations and startup reconciliation. The standalone AI Gateway treats a missing per-user policy as default-enabled, derives provider and credential state from the global model policy and healthy infrastructure, and preserves explicit disabled records. The Gateway admin API accepts only `enabled`, while the hosted admin web keeps infrastructure choices exclusively in AI Infrastructure.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL, Node test runner through `tsx --test`, vanilla browser JavaScript, Playwright.

---

## Guardrails

- Do not modify `packages/app`, `packages/desktop`, or `packages/server`.
- Do not change the local Veslo server API contract.
- Follow @test-driven-development for every behavior change: add one failing test, run it and confirm the intended failure, then write production code.
- Preserve explicit administrator billing and AI Access decisions.
- Use only organization-qualified admin AI Access routes.
- Keep the active model global and infrastructure-owned.

### Task 1: Add the DEN automatic-trial domain service

**Files:**
- Create: `services/den/src/billing/automatic-organization-trial.ts`
- Create: `services/den/test/automatic-organization-trial.test.ts`
- Modify: `services/den/src/billing/repository.ts`

**Step 1: Write the failing service tests**

Create tests that use a fake atomic store and a fixed clock. Cover:

```ts
test("grants an unconfigured organization one 14-day unlimited trial", async () => {
  const result = await service.ensureTrial("org_1")
  assert.equal(result.granted, true)
  assert.equal(result.expiresAt.toISOString(), "2026-08-04T00:00:00.000Z")
  assert.deepEqual(store.grants[0], {
    orgId: "org_1",
    mode: "manual_access",
    source: "manual_trial",
    status: "active",
    manualAccessEnabled: true,
    manualAccessUnlimited: true,
    manualAccessExpiresAt: new Date("2026-08-04T00:00:00.000Z"),
  })
})

test("does not replace any existing billing account", async () => {
  store.configured.add("org_1")
  assert.equal((await service.ensureTrial("org_1")).granted, false)
  assert.equal(store.grants.length, 0)
})

test("reconciliation grants each unconfigured organization only once", async () => {
  store.organizationIds = ["org_1", "org_2"]
  store.configured.add("org_2")
  assert.deepEqual(await service.reconcile(), { scanned: 2, granted: 1 })
  assert.deepEqual(await service.reconcile(), { scanned: 2, granted: 0 })
})
```

The fake store must model the atomic `grantTrialIfUnconfigured` contract so repeated and concurrent calls cannot extend expiry.

**Step 2: Run the new test and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial.test.ts
```

Expected: FAIL because the automatic-trial module does not exist.

**Step 3: Implement the minimal service**

Create an exported service with these contracts:

```ts
export const AUTOMATIC_ORGANIZATION_TRIAL_DAYS = 14

export type AutomaticOrganizationTrialGrant = {
  orgId: string
  mode: "manual_access"
  source: "manual_trial"
  status: "active"
  manualAccessEnabled: true
  manualAccessUnlimited: true
  manualAccessExpiresAt: Date
}

export type AutomaticOrganizationTrialStore = {
  listOrganizationIds(): Promise<string[]>
  grantTrialIfUnconfigured(input: AutomaticOrganizationTrialGrant): Promise<boolean>
}

export function createAutomaticOrganizationTrialService(deps: {
  store: AutomaticOrganizationTrialStore
  now?: () => Date
}): {
  ensureTrial(orgId: string): Promise<{ granted: boolean; expiresAt: Date }>
  reconcile(): Promise<{ scanned: number; granted: number }>
}
```

Compute expiry from the fixed creation/reconciliation time. Never update an existing account and never derive a fresh expiry after the atomic store reports that a grant already exists.

Add an atomic Drizzle-backed store factory in the same module or billing repository. It must lock the organization, reject an existing billing account or automatic-trial history marker, insert the billing account, and record a stable history marker in one transaction. Use the existing billing event table for the marker rather than adding another schema table.

**Step 4: Run focused DEN tests and verify GREEN**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial.test.ts test/organization-billing-repository.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/billing/automatic-organization-trial.ts services/den/src/billing/repository.ts services/den/test/automatic-organization-trial.test.ts
git commit -m "feat(den): add automatic organization trial service"
```

### Task 2: Wire trials into new-organization creation and rollout reconciliation

**Files:**
- Modify: `services/den/src/orgs.ts`
- Modify: `services/den/src/index.ts`
- Modify: `services/den/test/signup-gate.test.ts`
- Modify: `services/den/test/organization-billing-startup-source.test.ts`
- Create: `services/den/test/automatic-organization-trial-wiring.test.ts`

**Step 1: Write the failing wiring tests**

Add source/runtime contract tests proving:

- the default personal-organization path calls automatic trial initialization after creating the organization and membership;
- initialization receives the returned organization id;
- startup runs reconciliation after tables are ensured and before `app.listen`;
- adding or activating a member does not call trial initialization or change expiry;
- trial initialization failure prevents signup completion instead of silently creating a non-trial organization.

Use an injectable `createEnsureDefaultOrg` helper if needed so the new-organization flow can be exercised without a real MySQL instance.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial-wiring.test.ts test/organization-billing-startup-source.test.ts test/signup-gate.test.ts
```

Expected: FAIL because the creation and bootstrap paths do not invoke the trial service.

**Step 3: Implement the minimal wiring**

- Construct one default automatic-trial service from the DEN database.
- Make the default-organization creator initialize trial exactly once for a newly inserted organization.
- Do not initialize or refresh a trial when a member joins an existing organization.
- In `bootstrap`, run the idempotent reconciliation after schema setup and before accepting requests.
- Log only counts (`scanned`, `granted`); never log billing secrets or user data.

**Step 4: Run focused and full DEN tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial-wiring.test.ts test/automatic-organization-trial.test.ts test/organization-billing-startup-source.test.ts test/signup-gate.test.ts
pnpm --dir services/den test
```

Expected: PASS with the existing environment-dependent skip only.

**Step 5: Commit**

```bash
git add services/den/src/orgs.ts services/den/src/index.ts services/den/test/signup-gate.test.ts services/den/test/organization-billing-startup-source.test.ts services/den/test/automatic-organization-trial-wiring.test.ts
git commit -m "feat(den): grant organization trials automatically"
```

### Task 3: Add server-derived default AI Access in the Gateway

**Files:**
- Create: `services/ai-gateway/src/access/automatic-user-access.ts`
- Create: `services/ai-gateway/test/automatic-user-access.test.ts`
- Modify: `services/ai-gateway/src/access/repository.ts`

**Step 1: Write failing service tests**

Cover these exact states:

```ts
test("missing access defaults to enabled and persists infrastructure-derived routing", async () => {
  const access = await service.getOrCreateUserAiAccess("user_1")
  assert.equal(access.enabled, true)
  assert.equal(access.provider, "codex_oauth")
  assert.equal(access.credentialId, "cred_healthy")
  assert.equal(access.assignmentOrigin, "auto_assigned")
})

test("explicit disabled access is returned without model or credential work", async () => {
  const access = await service.getOrCreateUserAiAccess("user_1")
  assert.equal(access.enabled, false)
  assert.equal(modelReads, 0)
  assert.equal(capabilityReads, 0)
})

test("missing healthy credential keeps access enabled with infrastructure unavailable", async () => {
  const access = await service.getOrCreateUserAiAccess("user_1")
  assert.equal(access.enabled, true)
  assert.equal(access.provider, "codex_oauth")
  assert.equal(access.credentialId, null)
})

test("admin re-enable derives current provider and credential", async () => {
  const input = await service.buildEnabledUpdate("user_1", "admin_assigned")
  assert.deepEqual(input, {
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_healthy",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    assignmentOrigin: "admin_assigned",
  })
})
```

Also test concurrent missing-record initialization and a transient capability result. The service may store a nullable internal credential when infrastructure is unavailable, but it must never change the active model.

**Step 2: Run and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/automatic-user-access.test.ts
```

Expected: FAIL because the service does not exist.

**Step 3: Implement the service**

Define:

```ts
export type AutomaticUserAiAccess = {
  getOrCreateUserAiAccess(userId: string): Promise<UserAiAccessPolicyRecord>
  buildEnabledUpdate(
    userId: string,
    assignmentOrigin: AiAccessAssignmentOrigin,
  ): Promise<UpsertUserAiAccessPolicyInput>
}
```

Rules:

- Return any existing record unchanged when it is disabled.
- For a missing record, read the current global policy and derive the provider from `activeModel.provider`.
- Use the platform capability verifier to select a healthy compatible credential for providers that require a pinned credential.
- Persist `auto_assigned`, the active model, and the same-provider enabled model roster.
- If no credential is available, persist enabled access with a nullable credential so later inference reports infrastructure failure rather than user denial.
- Make missing-policy failure typed and distinguishable from explicit access denial.

**Step 4: Run and verify GREEN**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/automatic-user-access.test.ts test/mysql-ai-access-mutation.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/access/automatic-user-access.ts services/ai-gateway/src/access/repository.ts services/ai-gateway/test/automatic-user-access.test.ts
git commit -m "feat(ai-gateway): derive default user AI access"
```

### Task 4: Use automatic access for self reads and inference

**Files:**
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/ai-gateway/src/http/user-credentials.ts`
- Modify: `services/ai-gateway/src/http/proxy-dependencies.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/test/runtime-persistence.test.ts`
- Modify: `services/ai-gateway/test/user-credentials.test.ts`
- Modify: `services/ai-gateway/test/proxy-access-policy.test.ts`
- Modify: `services/ai-gateway/test/proxy-entitlement-order.test.ts`

**Step 1: Change tests to the new desired behavior**

- Replace the self-access test that expects `{ aiAccess: null }` for a missing record with an enabled server-derived response.
- Add a proxy test proving a paid/entitled user with no stored policy is initialized and proceeds to model/provider routing.
- Keep a test proving an explicit disabled record returns `403` before provider work.
- Keep entitlement denial before any automatic user-access write.
- Add a missing-infrastructure test that returns a stable `503`, not `403 ai_access_not_configured`.
- Prove the explicit user-id compatibility aliases return the same derived access as `/me` and still reject identity mismatch.

**Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/user-credentials.test.ts test/proxy-access-policy.test.ts test/proxy-entitlement-order.test.ts test/runtime-persistence.test.ts
```

Expected: FAIL because routes still treat a missing record as denied/null.

**Step 3: Wire one shared automatic-access service**

- Create the service from the shared runtime repositories, capability verifier, status provider, and transports.
- Inject it into user credential and proxy dependencies.
- Self-access routes call `getOrCreateUserAiAccess` after authentication.
- Inference keeps the order authentication → DEN entitlement → automatic/explicit user access → global model → provider.
- Preserve explicit disabled access as `403`.
- Map missing model or credential infrastructure to stable `503` errors.
- Do not change any URL consumed by the application or local Veslo server.

**Step 4: Run focused and full Gateway tests**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/user-credentials.test.ts test/proxy-access-policy.test.ts test/proxy-entitlement-order.test.ts test/runtime-persistence.test.ts
pnpm --dir services/ai-gateway test
```

Expected: PASS with existing environment-dependent skips only.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/runtime/default-runtime.ts services/ai-gateway/src/http/user-credentials.ts services/ai-gateway/src/http/proxy-dependencies.ts services/ai-gateway/src/http/proxy.ts services/ai-gateway/test/runtime-persistence.test.ts services/ai-gateway/test/user-credentials.test.ts services/ai-gateway/test/proxy-access-policy.test.ts services/ai-gateway/test/proxy-entitlement-order.test.ts
git commit -m "feat(ai-gateway): auto-enable authenticated user access"
```

### Task 5: Reduce the admin AI Access API to an enabled switch

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`
- Modify: `services/ai-gateway/test/admin-openai-compatible.test.ts`

**Step 1: Write failing admin API tests**

Add/replace tests proving:

- `{ enabled: false }` is accepted and persists an explicit `admin_assigned` deny;
- `{ enabled: true }` derives the active provider and compatible credential server-side;
- `provider`, `credentialId`, `defaultModel`, and `allowedModels` are rejected before membership or writes with `400 user_ai_access_routing_not_supported`;
- a missing or non-boolean `enabled` field is rejected;
- organization and actor audit scope remains exact;
- GET returns automatically enabled access for a member without a stored record;
- no response field is used as an editable assignment option.

**Step 2: Run and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-user-access.test.ts test/admin-actions.test.ts test/admin-openai-compatible.test.ts
```

Expected: FAIL because the route accepts provider and credential input and requires them for enablement.

**Step 3: Implement the enabled-only contract**

- Narrow `UpdateUserAiAccessInput` to `{ enabled: boolean }`.
- Reject technical routing fields at the HTTP boundary rather than ignoring them.
- On disable, write `provider: null`, `credentialId: null`, empty model fields, and `admin_assigned` through the audited mutation.
- On enable, call the automatic-access service's server-derived update builder, then write through the audited mutation.
- Keep the organization-qualified membership and capability guards unchanged.
- Remove manual credential-option preparation from the user mutation path.

**Step 4: Run focused admin tests and the Gateway suite**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-user-access.test.ts test/admin-actions.test.ts test/admin-openai-compatible.test.ts
pnpm --dir services/ai-gateway test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-user-access.test.ts services/ai-gateway/test/admin-actions.test.ts services/ai-gateway/test/admin-openai-compatible.test.ts
git commit -m "feat(ai-gateway): make user AI access enabled-only"
```

### Task 6: Simplify the Gateway admin member modal

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/admin-route-state.js`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-route-state.test.ts`

**Step 1: Write failing UI contract tests**

Assert that the AI Access member editor:

- has `#user-ai-access-enabled` and `#user-platform-admin`;
- contains no provider or credential selects;
- submits exactly `{ enabled }` to the qualified AI Access endpoint;
- lets a platform admin submit `{ platformAdmin }` through the DEN-owned user endpoint while in the organization AI Access route;
- does not let an organization admin elevate platform administration;
- hides name, email, organization, organization role, invitation, disable, and delete controls in the AI Access edit route;
- leaves the separate Platform Users create flow and Members role flow available on their own routes.

Update route-state tests so a platform admin has `setPlatformAdmin` in an organization AI Access route and `buildAdminUserUpdatePayload` emits only `{ platformAdmin }` there.

**Step 2: Run and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts
```

Expected: FAIL because the modal still contains and submits provider/credential choices.

**Step 3: Implement the minimal UI**

- Remove provider and credential controls from HTML.
- Remove their DOM references, option rendering, change handlers, and form readers.
- Keep status copy read-only and describe server-selected infrastructure.
- Make the AI Access PUT body exactly `{ enabled: els.userAiAccessEnabled.checked }`.
- Let only a platform admin see and edit the platform-admin switch in this organization route.
- Keep all other existing edit controls hidden by route-scoped permissions.
- On a partial save failure, reload the current route's authoritative data before showing the error.

**Step 4: Run and verify GREEN**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/admin-route-state.js services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-route-state.test.ts
git commit -m "feat(ai-gateway): simplify member AI access editor"
```

### Task 7: Verify the real hosted admin UI in Playwright

**Files:**
- Modify: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`

**Step 1: Update the browser test first**

Replace the existing provider/credential interaction in the qualified AI Access test with assertions that:

```ts
await expect(page.locator("#user-ai-access-enabled")).toBeVisible()
await expect(page.locator("#user-platform-admin")).toBeVisible()
await expect(page.locator("#user-ai-access-provider")).toHaveCount(0)
await expect(page.locator("#user-ai-access-credential")).toHaveCount(0)
```

After switching AI Access off and saving, assert the captured PUT body is exactly `{ enabled: false }`. Add a platform-admin toggle save and verify its separate PATCH body is exactly `{ platformAdmin: true|false }`. Add an organization-admin session case proving the platform-admin control is absent or disabled and no elevation request is emitted.

Keep the delayed-response organization switch assertion so stale saves cannot mutate the destination organization.

**Step 2: Run and verify RED**

Run:

```bash
pnpm --dir packages/e2e exec playwright test ./specs/ai-gateway-admin-data-isolation.playwright.spec.ts --grep "AI Access"
```

Expected: FAIL because the old selects still exist and the old three-field body is submitted.

**Step 3: Make only test-harness fixture changes required by the new contract**

Update mocked AI Access PUT responses to accept `{ enabled }` and derive read-only routing fields in the fixture response. Do not reintroduce provider/credential controls.

**Step 4: Run the complete admin UI suite**

Run:

```bash
pnpm --dir packages/e2e test:ai-gateway-admin-data-isolation
```

Expected: 43+ focused admin API tests pass and all Playwright admin data-isolation tests pass.

**Step 5: Commit**

```bash
git add packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts
git commit -m "test(ai-gateway): cover automatic member AI access UI"
```

### Task 8: Update canonical documentation and run final gates

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/features/organization-billing.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `services/ai-gateway/test/global-model-policy-docs.test.ts`
- Modify: `docs/plans/2026-07-21-automatic-organization-trial-and-ai-access-design.md` only if implementation required an approved clarification

**Step 1: Write/update documentation contract tests first**

Modify the existing Gateway documentation tests so they require:

- 14-day organization trial inheritance;
- no trial reset on membership changes;
- default-enabled missing AI Access;
- explicit disabled override preservation;
- server-derived provider and credential routing;
- enabled-only admin mutation;
- unchanged self/user-id compatibility routes;
- no changes to the installed app or local Veslo server.

**Step 2: Run documentation tests and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test test/global-model-policy-docs.test.ts
```

Expected: FAIL until canonical docs reflect the new behavior.

**Step 3: Update canonical docs**

Remove statements that require manual per-user provider/credential assignment. Document trial ownership, automatic initialization, explicit deny behavior, and infrastructure failure semantics.

**Step 4: Run all proportional verification**

Run in this order:

```bash
pnpm --dir services/den test
pnpm --dir services/den typecheck
pnpm --dir services/ai-gateway test
pnpm --dir services/ai-gateway typecheck
pnpm --dir packages/e2e test:ai-gateway-admin-data-isolation
pnpm check
git diff --check
git status --short
```

Expected:

- DEN and Gateway suites pass with only documented environment-dependent skips.
- The real browser admin suite passes.
- Repository `pnpm check` passes.
- No file under `packages/app`, `packages/desktop`, or `packages/server` is modified.

**Step 5: Review the scope diff**

Run:

```bash
git diff --name-only main...HEAD
```

Expected: only DEN, AI Gateway, the admin Playwright spec, and canonical documentation/plan files.

**Step 6: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/features/organization-billing.md docs/features/session-runtime.md services/ai-gateway/test/global-model-policy-docs.test.ts
git commit -m "docs: document automatic trial and AI access"
```

**Step 7: Apply @verification-before-completion**

Re-run any failed focused command after its fix and report exact pass, skip, and failure counts. Do not claim completion from stale output.
