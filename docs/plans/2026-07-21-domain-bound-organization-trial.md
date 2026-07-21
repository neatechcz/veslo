# Domain-Bound Organization Trial Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Grant one 14-day organization trial per registered company domain only after an active organization member has verified an email on that exact domain.

**Architecture:** DEN keeps current domain ownership in `organization_domain` and adds an immutable unique domain-claim ledger for historical trial consumption. Signup provisioning runs only after trusted email verification, while manual domain mutations validate an active verified member before writing. The trial transaction claims every current organization domain and creates the existing billing account/event atomically; removing or moving a domain never deletes its claim.

**Tech Stack:** TypeScript, Better Auth 1.4, Express, Drizzle ORM, MySQL, Node test runner, Playwright, pnpm.

---

## Execution dependency

Execute this plan from the dedicated `codex/domain-bound-trial` worktree after
the separately approved email-verification hard-gate implementation has been
integrated into `dev_vaclav`. Rebase or merge that completed work before Task 4.
Do not duplicate its mail transport, session-gate, hosted onboarding, or Tauri
changes here. This plan owns only verified organization provisioning, domain
proof, and domain-bound trial behavior.

### Task 1: Add the immutable trial-domain claim ledger

**Files:**
- Create: `services/den/drizzle/0023_organization_trial_domain_claims.sql`
- Create: `services/den/test/organization-trial-domain-schema.test.ts`
- Modify: `services/den/drizzle/meta/_journal.json`
- Modify: `services/den/src/db/schema.ts:168-260`
- Modify: `services/den/src/index.ts:742-790`

**Step 1: Write the failing schema and migration test**

Create a test that imports the expected table and checks the migration,
bootstrap DDL, immutable-domain uniqueness, organization lookup index, and
journal entry:

```ts
test("trial domain claims have one immutable row per normalized domain", async () => {
  const schema = await import("../src/db/schema.js")
  assert.ok(schema.OrganizationTrialDomainClaimTable)

  const migration = await readFile(
    new URL("../drizzle/0023_organization_trial_domain_claims.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /CREATE TABLE `organization_trial_domain_claim`/)
  assert.match(migration, /`domain` varchar\(255\) NOT NULL/)
  assert.match(migration, /CREATE UNIQUE INDEX `organization_trial_domain_claim_domain`/)
  assert.match(migration, /CREATE INDEX `organization_trial_domain_claim_org_id`/)
})
```

Also assert that `services/den/src/index.ts` creates and indexes the table for
the repository's compatibility bootstrap path.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/organization-trial-domain-schema.test.ts test/drizzle-migration-format.test.ts
```

Expected: FAIL because the table, migration, and journal entry do not exist.

**Step 3: Implement the minimal schema and migration**

Add the Drizzle table:

```ts
export const OrganizationTrialDomainClaimTable = mysqlTable(
  "organization_trial_domain_claim",
  {
    id: id().primaryKey(),
    domain: varchar("domain", { length: 255 }).notNull(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    claimed_at: timestamp("claimed_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_trial_domain_claim_domain").on(table.domain),
    index("organization_trial_domain_claim_org_id").on(table.org_id),
  ],
)
```

Create migration `0023_organization_trial_domain_claims.sql` with one statement
per breakpoint. Add journal index `24` with a new monotonically increasing
timestamp. Mirror the table in `ensureTables()` and add both indexes with
`ensureIndex`.

Do not add a delete path or cascading foreign key. The row must survive current
organization-domain deletion and organization lifecycle cleanup.

**Step 4: Run the focused tests and typecheck**

Run:

```bash
pnpm --dir services/den exec tsx --test test/organization-trial-domain-schema.test.ts test/drizzle-migration-format.test.ts test/admin-gateway-org-schema.test.ts
pnpm --dir services/den typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/drizzle/0023_organization_trial_domain_claims.sql services/den/drizzle/meta/_journal.json services/den/src/db/schema.ts services/den/src/index.ts services/den/test/organization-trial-domain-schema.test.ts
git commit -m "feat(den): add immutable trial domain claims"
```

### Task 2: Make automatic trial grants domain-aware and atomic

**Files:**
- Modify: `services/den/src/billing/automatic-organization-trial.ts`
- Modify: `services/den/test/automatic-organization-trial.test.ts`
- Create: `services/den/test/automatic-organization-trial-store.test.ts`

**Step 1: Write failing service behavior tests**

Extend the fake store around observable outcomes and add separate tests for:

```ts
test("organization without a registered domain receives no automatic trial", async () => {
  store.domainsByOrg.set("org_1", [])
  assert.equal((await service.ensureTrial("org_1")).granted, false)
  assert.deepEqual(store.grants, [])
})

test("one trial consumes every registered organization domain", async () => {
  store.domainsByOrg.set("org_1", ["alpha.example", "beta.example"])
  assert.equal((await service.ensureTrial("org_1")).granted, true)
  assert.deepEqual(store.claims, new Map([
    ["alpha.example", "org_1"],
    ["beta.example", "org_1"],
  ]))
})

test("one historical domain claim blocks a mixed domain set", async () => {
  store.domainsByOrg.set("org_2", ["used.example", "fresh.example"])
  store.claims.set("used.example", "org_1")
  assert.equal((await service.ensureTrial("org_2")).granted, false)
  assert.equal(store.claims.has("fresh.example"), false)
})
```

Add cases proving that an existing `manual_trial` account or historical
automatic-trial event backfills every current domain without changing expiry,
while an existing paid or administrator-owned non-trial account is preserved
without consuming claims. Add deletion/re-registration and concurrent-claim
cases.

**Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial.test.ts test/automatic-organization-trial-store.test.ts
```

Expected: FAIL because the store grants by organization ID without reading or
claiming domains.

**Step 3: Implement the store contract and pure service result**

Keep callers compatible with `{ granted, expiresAt }`, but let the store own the
complete decision:

```ts
export type AutomaticOrganizationTrialStore = {
  listOrganizationIds(): Promise<string[]>
  grantOrSyncDomainTrial(input: AutomaticOrganizationTrialGrant): Promise<{
    granted: boolean
  }>
}
```

`ensureTrial()` must call `grantOrSyncDomainTrial` and never derive an email
domain itself.

**Step 4: Implement the serializable Drizzle transaction**

Within one transaction:

1. lock the organization;
2. read every current `organization_domain` row in normalized stable order;
3. return without a grant when the list is empty;
4. lock/read the billing account and automatic-trial history marker;
5. for an existing trial, insert any missing same-organization claims without
   changing billing dates;
6. for an unconfigured organization, reject the complete set if any domain is
   already claimed;
7. insert every claim, the billing account, and the billing event; and
8. treat a unique-domain race as `granted: false` after transaction rollback.

Use `OrganizationDomainTable`, `OrganizationTrialDomainClaimTable`,
`OrganizationBillingAccountTable`, and `OrganizationBillingEventTable`. Keep
the existing 14-day calculation and unlimited organization inheritance.

Do not use owner/member email as a fallback. Do not delete claims.

**Step 5: Run focused and regression tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial.test.ts test/automatic-organization-trial-store.test.ts test/automatic-organization-trial-wiring.test.ts test/organization-billing-repository.test.ts
pnpm --dir services/den typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/billing/automatic-organization-trial.ts services/den/test/automatic-organization-trial.test.ts services/den/test/automatic-organization-trial-store.test.ts
git commit -m "feat(den): bind organization trials to domains"
```

### Task 3: Require verified organization-member evidence for domain mutations

**Files:**
- Create: `services/den/src/org-admin/domain-verification.ts`
- Create: `services/den/test/organization-domain-verification.test.ts`
- Modify: `services/den/src/http/admin-runtime.ts:1830-1985`
- Modify: `services/den/test/admin-routes.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing verification-policy tests**

Design the verifier around an injected member reader so the policy is tested
without mocking Drizzle internals:

```ts
test("active verified exact-domain member proves organization ownership", async () => {
  const verifier = createOrganizationDomainVerifier({
    async listMembers() {
      return [{
        userId: "user_1",
        email: " Owner@Team.Example.com ",
        emailVerified: true,
        membershipStatus: "active",
      }]
    },
  })

  assert.deepEqual(
    await verifier.requireVerifiedMember("org_1", "team.example.com"),
    { userId: "user_1" },
  )
})
```

Separate tests reject unverified email, disabled/removed membership, a matching
user in another organization, and parent/subdomain mismatches. Use a typed
`OrganizationDomainVerifiedMemberRequiredError`.

**Step 2: Run the verifier tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/organization-domain-verification.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the verifier and Drizzle reader**

The production reader joins active `OrgMembershipTable` rows to
`AuthUserTable`, selects only verified users for the exact organization, and
normalizes each candidate with the existing `normalizeEmailDomain` helper.
Return the deterministic first matching user ID; never accept the request actor
alone as proof.

**Step 4: Write failing admin HTTP behavior tests**

Add route/service cases proving:

- POST domain without proof returns HTTP 409 and
  `{ error: "domain_verified_member_required" }`;
- PATCH to a different domain performs the same check;
- enabled/self-signup-only PATCH does not require a second proof;
- a rejected request writes neither domain nor audit; and
- a verified create invokes `automaticOrganizationTrialService.ensureTrial`
  only after the domain exists.

Extend the AI Gateway DEN facade regression test to preserve the exact 409
status and safe error body instead of mapping it to a generic 5xx.

**Step 5: Run the HTTP tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/admin-routes.test.ts test/organization-domain-verification.test.ts
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because admin domain mutations do not verify member evidence or
trigger domain-bound trial synchronization.

**Step 6: Wire verification and trial synchronization**

In create and domain-changing update paths:

```ts
const evidence = await organizationDomainVerifier.requireVerifiedMember(
  context.organization.id,
  domain,
)
```

Map the typed failure to 409. After the domain insert/update, call the
transaction-compatible trial service so an unconfigured organization can gain
its first trial and an existing trial can consume the newly added domain. A
historical claim may suppress the trial but must not reject otherwise valid
domain registration.

Include `verifiedMemberUserId` in the existing safe organization audit summary.
Deletion and disable paths must contain no claim deletion.

**Step 7: Run tests and typechecks**

Run the command from Step 5, then:

```bash
pnpm --dir services/den typecheck
pnpm --dir services/ai-gateway typecheck
```

Expected: PASS.

**Step 8: Commit**

```bash
git add services/den/src/org-admin/domain-verification.ts services/den/src/http/admin-runtime.ts services/den/test/organization-domain-verification.test.ts services/den/test/admin-routes.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(den): verify organization domains by member email"
```

### Task 4: Provision signup domains and trials only after email verification

**Files:**
- Modify: `services/den/src/auth.ts:45-125`
- Modify: `services/den/src/auth/signup-gate.ts:181-315`
- Modify: `services/den/src/orgs.ts`
- Modify: `services/den/src/http/org-auth.ts:120-138`
- Modify: `services/den/test/signup-domain-gate.test.ts`
- Modify: `services/den/test/signup-organization-bootstrap.test.ts`
- Modify: `services/den/test/auth-email-source.test.ts`
- Create: `services/den/test/verified-signup-provisioning.test.ts`

**Step 1: Integrate the completed email-verification branch**

Update from `dev_vaclav` and verify the completed hard gate supplies all of the
following before editing:

```text
env.authRequireEmailVerification
emailVerification.afterEmailVerification support point
awaited verification-email delivery
shared unverified-session rejection
```

If that implementation is not present, pause this task and complete the
approved email-verification plan first. Do not restore fire-and-forget mail or a
route-local verification switch.

**Step 2: Write failing signup-order tests**

Add tests proving:

```ts
test("unverified first signup does not register a domain or grant AI access", async () => {
  const result = await runSignupAfterUserCreateSideEffects({
    ...deps,
    user: { id: "user_1", email: "owner@team.example.com", emailVerified: false },
  })
  assert.equal(result.awaitingEmailVerification, true)
  assert.deepEqual(calls, [])
})

test("verification completion provisions domain trial before AI access", async () => {
  await provisionVerifiedSignupUser({
    user: { id: "user_1", email: "owner@team.example.com", emailVerified: true },
    ...deps,
  })
  assert.deepEqual(calls, ["organization-domain-trial", "ai-access"])
})
```

Also cover a trusted already-verified social identity, an invite/domain
membership created before verification, retry idempotency, domain-claim race
recovery, and recovery of a verified user who has no membership on their first
organization read.

**Step 3: Run signup tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/signup-domain-gate.test.ts test/signup-organization-bootstrap.test.ts test/verified-signup-provisioning.test.ts test/auth-email-source.test.ts
```

Expected: FAIL because the current user-create hook bootstraps organization,
domain, trial, and AI access before verification.

**Step 4: Extract an idempotent verified-user provisioner**

Create one coordinator used by trusted social creation,
`afterEmailVerification`, and organization-access repair:

```ts
await provisionVerifiedSignupUser({
  user,
  findExistingOrganizationId,
  ensureSignupOrganization,
  resolveEnabledOrganizationDomainForEmail,
  createOrActivateOrganizationMembership,
  assignManagedAiAccess,
})
```

It must reject `emailVerified !== true`, reuse existing active membership,
recover the existing `SignupOrganizationDomainConflictError` by joining the
winning organization, and assign managed AI only after membership exists.
Retries must not create a second organization, domain, trial, or assignment.

Keep valid invite or existing-domain membership activation compatible with the
current pre-verification user-create flow, but do not use an unverified member
as domain proof and do not assign managed AI until verification.

**Step 5: Wire Better Auth and fallback recovery**

In the user-create hook:

- immediately provision only when Better Auth already marks the provider email
  verified;
- otherwise retain only safe pending membership/invite work and return without
  domain bootstrap, trial, or AI assignment.

In the existing email verification configuration:

```ts
afterEmailVerification: async (user) => {
  await provisionVerifiedSignupUser({ user, ...verifiedProvisioningDependencies })
},
```

Update the no-membership fallback in `resolveMembershipOrganizations()` to use
the same verified provisioner or domain-aware organization bootstrap instead of
the legacy domainless `ensureDefaultOrg`. This is the retry path if the
post-verification callback failed after Better Auth committed verification.

Remove the signup-bootstrap expectation that trial initialization may run for
an unverified identity. The transaction still creates organization,
organization-admin membership, registered domain, immutable claims, and trial
together once the identity is verified.

**Step 6: Run focused tests and typecheck**

Run the command from Step 3, then:

```bash
pnpm --dir services/den typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/auth.ts services/den/src/auth/signup-gate.ts services/den/src/orgs.ts services/den/src/http/org-auth.ts services/den/test/signup-domain-gate.test.ts services/den/test/signup-organization-bootstrap.test.ts services/den/test/auth-email-source.test.ts services/den/test/verified-signup-provisioning.test.ts
git commit -m "feat(den): provision domain trials after verification"
```

### Task 5: Cover the complete admin and signup behavior at user-facing boundaries

**Files:**
- Create: `services/den/test/domain-bound-trial-flow.test.ts`
- Modify: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`
- Modify: `services/ai-gateway/public-admin/app.js`

**Step 1: Write a failing composed DEN workflow test**

Compose the real verification policy, verified-user provisioner, domain
registration mutation, and automatic trial service around an in-memory
transactional store. Exercise this sequence:

1. an unverified signup produces no organization domain and no trial;
2. verification provisions one organization/domain/trial;
3. a second verified domain is added and consumed without extending expiry;
4. that domain is removed;
5. a new organization registers the removed domain with valid member proof; and
6. the second organization receives no trial.

Assert the first expiry timestamp is unchanged and only one trial grant exists.

**Step 2: Run the DEN workflow test and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/domain-bound-trial-flow.test.ts
```

Expected: FAIL until Tasks 2-4 are correctly composed.

**Step 3: Add the admin browser failure test**

Extend the existing Playwright harness so POSTing a domain without proof returns
409 `domain_verified_member_required`. Assert that the domain modal stays open,
the page shows a human-readable verification requirement, and no optimistic
domain row appears.

Add only a safe client-side mapping such as:

```js
case "domain_verified_member_required":
  return "Add and verify a member email from this domain before registering it."
```

Do not add provider classification or a second domain-policy list to the AI
Gateway admin.

**Step 4: Run the boundary tests and verify GREEN**

Run:

```bash
pnpm --dir services/den exec tsx --test test/domain-bound-trial-flow.test.ts
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/test/domain-bound-trial-flow.test.ts packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts services/ai-gateway/public-admin/app.js
git commit -m "test(den): cover domain-bound trial lifecycle"
```

### Task 6: Reconcile, document, and verify the complete change

**Files:**
- Modify: `docs/features/onboarding-and-auth.md:45-55`
- Modify: `docs/features/organization-billing.md:18-35`
- Modify: `services/den/README.md`
- Modify: `docs/plans/2026-07-21-domain-bound-organization-trial-design.md` only if implementation discoveries require a design correction

**Step 1: Write failing reconciliation assertions**

Extend the trial tests to prove startup reconciliation:

- skips organizations without registered domains;
- grants only when every registered domain is unclaimed;
- backfills claims for existing manual/automatic trials without changing expiry;
- remains idempotent; and
- reports scanned/granted counts without exposing domain or email values.

**Step 2: Run reconciliation tests and verify RED if coverage is missing**

Run:

```bash
pnpm --dir services/den exec tsx --test test/automatic-organization-trial.test.ts test/automatic-organization-trial-wiring.test.ts
```

Expected: PASS only when reconciliation has the approved behavior and explicit
coverage. If a new assertion fails, change production code rather than weakening
the test.

**Step 3: Update canonical documentation**

Document these durable rules:

- email/password users provision domains only after verification;
- trial code trusts registered domains and does not classify providers;
- every domain requires active verified-member evidence when registered;
- one organization trial consumes all current and later-added domains;
- immutable claims survive deletion and reassignment; and
- organization members inherit the organization trial.

Remove the statement that signup atomically grants a trial before verification.

**Step 4: Run complete DEN and Gateway verification**

Run:

```bash
pnpm --dir services/den test
pnpm --dir services/den build
pnpm --dir services/ai-gateway test
pnpm --dir services/ai-gateway typecheck
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
```

Expected: PASS. Environment-gated real-MySQL tests may skip only when their
documented database URL is absent; all deterministic tests must pass.

**Step 5: Run the repository quality gate**

Prepare ignored sidecars only if the Rust gate reports the known missing-sidecar
prerequisite, then run:

```bash
pnpm check
```

Expected: PASS, including lint, typechecks, unit/integration suites, Rust, and
architecture audits.

**Step 6: Confirm scope and secrets**

Run:

```bash
git status --short
git diff --check dev_vaclav...HEAD
git diff --name-only dev_vaclav...HEAD
```

Expected: only DEN, AI Gateway admin web, E2E, migration, and canonical
documentation changes. There must be no changes under `packages/app`,
`packages/desktop`, or `packages/server`, and no secrets.

**Step 7: Commit documentation or verification fixes**

```bash
git add docs/features/onboarding-and-auth.md docs/features/organization-billing.md services/den/README.md
git commit -m "docs(den): document domain-bound trials"
```

If verification required production fixes, commit only those owning files in a
separate `fix(den): close domain trial regressions` commit.
