# Signup Organization Domain Bootstrap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an enabled exact-domain rule together with the first signup organization, then attach later same-domain signups to that organization without creating duplicates.

**Architecture:** Keep DEN as the signup and organization authority. Add a signup-specific organization bootstrap service that atomically creates the organization, organization-admin membership, domain claim, and automatic trial. The post-create signup workflow recovers a concurrent unique-domain claim by resolving the winning domain and activating the losing user as a normal member.

**Tech Stack:** TypeScript, Better Auth database hooks, Drizzle ORM/MySQL transactions, Node test runner, pnpm workspace checks.

**Cross-session contract:** This branch represents an unmatched email domain as an organization-bootstrap signup, not a personal organization. The separate corporate-email gate must later allow this bootstrap only for domains it classifies as corporate and reject personal domains before user creation. It must not remove the bootstrap path entirely.

---

### Task 1: Add the atomic signup-organization bootstrap primitive

**Files:**
- Create: `services/den/test/signup-organization-bootstrap.test.ts`
- Modify: `services/den/src/orgs.ts`

**Step 1: Write failing service tests**

Create focused tests around an injected `createEnsureSignupOrganization` factory. The first test captures the bootstrap input and proves exact normalized-domain behavior:

```ts
test("first signup atomically bootstraps organization, admin membership, exact domain, and trial", async () => {
  const created: unknown[] = []
  const ensureSignupOrganization = createEnsureSignupOrganization({
    createId: createSequentialId("org_1", "membership_1", "domain_1"),
    async findExistingOrganizationId() { return null },
    async createOrganizationMembershipDomainAndTrial(input) { created.push(input) },
  })

  assert.equal(
    await ensureSignupOrganization("user_1", "User One", " User@Team.Example.com "),
    "org_1",
  )
  assert.deepEqual(created, [{
    orgId: "org_1",
    membershipId: "membership_1",
    domainId: "domain_1",
    userId: "user_1",
    name: "User One",
    slug: "personal-org_1",
    domain: "team.example.com",
  }])
})
```

Add tests proving that an existing membership is returned without creating anything, invalid email is rejected, and `SignupOrganizationDomainConflictError` is preserved for caller recovery.

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-organization-bootstrap.test.ts
```

Expected: FAIL because `createEnsureSignupOrganization` and `SignupOrganizationDomainConflictError` do not exist.

**Step 3: Implement the minimal bootstrap service**

In `orgs.ts`, add:

```ts
export class SignupOrganizationDomainConflictError extends Error {
  constructor(readonly domain: string, options?: ErrorOptions) {
    super("signup_organization_domain_conflict", options)
    this.name = "SignupOrganizationDomainConflictError"
  }
}

type EnsureSignupOrganizationDependencies = {
  createId(): string
  findExistingOrganizationId(userId: string): Promise<string | null>
  createOrganizationMembershipDomainAndTrial(input: {
    orgId: string
    membershipId: string
    domainId: string
    userId: string
    name: string
    slug: string
    domain: string
  }): Promise<void>
}

export function createEnsureSignupOrganization(deps: EnsureSignupOrganizationDependencies) {
  return async (userId: string, name: string, email: string) => {
    const domain = normalizeEmailDomain(email)
    if (!domain) throw new OrganizationAdminRepositoryError("domain_not_allowed")

    const existingOrganizationId = await deps.findExistingOrganizationId(userId)
    if (existingOrganizationId) return existingOrganizationId

    const orgId = deps.createId()
    await deps.createOrganizationMembershipDomainAndTrial({
      orgId,
      membershipId: deps.createId(),
      domainId: deps.createId(),
      userId,
      name,
      slug: `personal-${orgId.slice(0, 8)}`,
      domain,
    })
    return orgId
  }
}
```

Wire the production `ensureSignupOrganization` with the same existing-membership query as `ensureDefaultOrg`. Its creation dependency must use one outer `db.transaction` to insert:

```ts
await tx.insert(OrgTable).values({ ... })
await tx.insert(OrgMembershipTable).values({ role: "organization_admin", ... })
await tx.insert(OrganizationDomainTable).values({
  id: input.domainId,
  org_id: input.orgId,
  domain: input.domain,
  enabled: true,
  self_signup_enabled: true,
})
await createAutomaticOrganizationTrialService({
  store: createDrizzleAutomaticOrganizationTrialStore(tx),
}).ensureTrial(input.orgId)
```

Catch a MySQL duplicate-key error from the domain insert and throw `SignupOrganizationDomainConflictError`. Throwing inside the outer transaction must roll back the provisional organization and membership. Preserve `ensureDefaultOrg` for legacy/non-signup callers.

**Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-organization-bootstrap.test.ts test/automatic-organization-trial-wiring.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: all tests PASS and typecheck reports no errors.

**Step 5: Commit the primitive**

```bash
git add services/den/src/orgs.ts services/den/test/signup-organization-bootstrap.test.ts
git commit -m "feat(den): bootstrap signup organizations with domains"
```

### Task 2: Route first and concurrent signups through domain bootstrap

**Files:**
- Modify: `services/den/test/signup-domain-gate.test.ts`
- Modify: `services/den/src/auth/signup-gate.ts`

**Step 1: Write failing workflow tests**

Replace the temporary-personal semantics with explicit bootstrap semantics:

```ts
test("missing registered domain selects organization bootstrap", () => {
  assert.deepEqual(decideSignupAccess({
    matchingDomain: null,
    activeSeats: 0,
    seatLimit: null,
    hasValidInvite: false,
  }), { ok: true, mode: "organization_bootstrap" })
})
```

Update the post-create fallback expectation to:

```ts
{
  activatedOrganizationMembership: false,
  createSignupOrganization: true,
}
```

Add a workflow test in which `ensureSignupOrganization` succeeds. Assert it receives the user id, current name, and original email; Managed-AI assignment happens only afterward.

Add the primary concurrent-claim recovery test:

```ts
test("concurrent first signup joins the organization that won the domain claim", async () => {
  let domainLookups = 0
  const calls: string[] = []
  const result = await runSignupAfterUserCreateSideEffects({
    // first lookup: no domain; recovery lookup: winning domain
    resolveEnabledOrganizationDomainForEmail: async () => {
      domainLookups += 1
      if (domainLookups === 1) throw new OrganizationAdminRepositoryError("domain_not_allowed")
      return enabledDomain("team.example.com", "org_winner")
    },
    ensureSignupOrganization: async () => {
      throw new SignupOrganizationDomainConflictError("team.example.com")
    },
    createOrActivateOrganizationMembership: async (input) => {
      calls.push(`member:${input.orgId}:${input.role}`)
      return activeMembership(input)
    },
    // remaining dependencies use normal no-op fixtures
  })

  assert.deepEqual(result, {
    activatedOrganizationMembership: true,
    createSignupOrganization: false,
  })
  assert.deepEqual(calls, ["member:org_winner:member", "managed-ai"])
})
```

Add a separate test where the recovery lookup still returns `domain_not_allowed`. Assert cleanup runs and the disabled/invite-only domain is not reactivated.

**Step 2: Run the focused workflow test and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-domain-gate.test.ts
```

Expected: FAIL because signup still returns `mode: "personal"`, requests `createDefaultOrganization`, and has no domain-conflict recovery.

**Step 3: Implement bootstrap and collision recovery**

In `signup-gate.ts`:

- rename the internal `personal` decision to `organization_bootstrap`;
- rename `createDefaultOrganization` in the post-create result to `createSignupOrganization`;
- replace the `ensureDefaultOrg` dependency with `ensureSignupOrganization(userId, name, email)`;
- on successful bootstrap, treat the user as having an active organization membership;
- catch only `SignupOrganizationDomainConflictError`;
- after a claim conflict, resolve the enabled domain again and call `createOrActivateOrganizationMembership` with role `member`;
- if the recovery lookup finds no enabled self-signup domain, throw `OrganizationAdminRepositoryError("domain_not_allowed")` so the existing cleanup path removes the just-created auth user;
- keep invite precedence, invitation hashing, seat enforcement, and Managed-AI ordering unchanged.

Do not add personal-domain classification here. The separate corporate-email task owns the decision that permits or rejects `organization_bootstrap` before user creation.

**Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-domain-gate.test.ts test/signup-organization-bootstrap.test.ts
```

Expected: all focused tests PASS.

**Step 5: Commit the workflow**

```bash
git add services/den/src/auth/signup-gate.ts services/den/test/signup-domain-gate.test.ts
git commit -m "feat(den): recover concurrent signup domain claims"
```

### Task 3: Wire Better Auth to the signup-specific bootstrap

**Files:**
- Modify: `services/den/test/auth-email-source.test.ts`
- Modify: `services/den/src/auth.ts`

**Step 1: Write a failing wiring contract**

Update the source contract test to require `ensureSignupOrganization` and forbid signup-hook use of `ensureDefaultOrg`:

```ts
assert.match(source, /ensureSignupOrganization/)
assert.doesNotMatch(source, /import \{ ensureDefaultOrg \} from "\.\/orgs\.js"/)
```

Keep the assertions that authorization happens before insertion, failure cleanup exists, and Managed-AI assignment is last.

**Step 2: Run the source contract and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/auth-email-source.test.ts
```

Expected: FAIL because `auth.ts` still imports and injects `ensureDefaultOrg`.

**Step 3: Wire the new dependency**

Import `ensureSignupOrganization` from `orgs.ts` and inject it into `runSignupAfterUserCreateSideEffects`. No route shape, request header, Better Auth configuration, or cleanup SQL changes are needed.

**Step 4: Run the wiring and workflow tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/auth-email-source.test.ts test/signup-domain-gate.test.ts test/signup-organization-bootstrap.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: PASS.

**Step 5: Commit the auth wiring**

```bash
git add services/den/src/auth.ts services/den/test/auth-email-source.test.ts
git commit -m "feat(den): wire signup domain organization bootstrap"
```

### Task 4: Update canonical signup documentation

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`

**Step 1: Document the durable behavior**

Replace the temporary personal-organization paragraph with behavior that remains correct before and after the separate corporate-email classifier lands:

```md
When signup is authorized to bootstrap a previously unclaimed company domain, DEN atomically creates the organization, the first user's organization-admin membership, an enabled exact-domain self-signup rule, and the automatic organization trial. Later users with the same normalized exact domain join that organization as members, subject to its seat limit. Concurrent first signups create only one durable organization; the losing signup joins the winning domain owner. Disabled and invite-only domains are never re-enabled by signup.

Personal-domain classification and rejection are enforced at the pre-create signup gate. A valid organization invitation remains an independent path and does not create another organization or domain.
```

Also state that matching uses the exact normalized domain, so `team.example.com` does not claim `example.com`.

**Step 2: Verify stale semantics are gone from this branch**

Run:

```bash
rg -n 'mode: "personal"|createDefaultOrganization|ensureDefaultOrg' services/den/src/auth.ts services/den/src/auth/signup-gate.ts services/den/test/signup-domain-gate.test.ts docs/features/onboarding-and-auth.md
```

Expected: no matches in the signup flow; `ensureDefaultOrg` may remain only in legacy non-signup organization code.

**Step 3: Commit documentation**

```bash
git add docs/features/onboarding-and-auth.md
git commit -m "docs: document signup domain bootstrap"
```

### Task 5: Verify the complete change

**Files:**
- Verify only; no planned source changes.

**Step 1: Run focused DEN verification**

```bash
pnpm --filter @neatech/den exec tsx --test \
  test/signup-organization-bootstrap.test.ts \
  test/signup-domain-gate.test.ts \
  test/auth-email-source.test.ts \
  test/automatic-organization-trial-wiring.test.ts \
  test/org-admin-repository.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: PASS with zero failures and zero type errors.

**Step 2: Run the complete DEN suite**

```bash
pnpm --filter @neatech/den test
```

Expected: PASS with zero failing tests.

**Step 3: Review concurrency and security invariants**

Confirm from fresh test evidence that:

- organization, first admin membership, exact domain, and trial are one atomic bootstrap;
- same-domain subsequent signup joins as `member`;
- a duplicate domain claim rolls back the provisional organization;
- collision recovery still enforces seat capacity;
- disabled or invite-only domains are not re-enabled;
- invitation signup never creates another organization/domain;
- Managed-AI assignment occurs only after active membership;
- the separate corporate-domain gate retains the bootstrap path for eligible company domains.

**Step 4: Run repository quality checks**

```bash
git diff --check
pnpm check
```

Expected: no whitespace errors and the full repository quality gate PASS.

**Step 5: Inspect the final branch**

```bash
git status --short
git log --oneline --decorate -8
```

Expected: the worktree is clean and contains only intentional commits on `codex/signup-organization-domain`.
