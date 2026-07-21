# Personal Email Domain Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Reject signup from known personal-email provider domains unless a valid organization invitation is supplied, while preserving automatic organization bootstrap for unclaimed company domains.

**Architecture:** Add a pure exact-domain policy in DEN and enforce it at both the pre-create authorization boundary and the post-create defense-in-depth boundary. Keep the separately implemented signup-organization bootstrap unchanged for domains not classified as personal. Map DEN's stable `domain_not_allowed` code to actionable copy in both hosted registration surfaces.

**Tech Stack:** TypeScript, Better Auth, Express, Node test runner, React/Next.js, static DEN onboarding HTML, pnpm workspace checks.

---

### Task 1: Add a pure personal-email domain policy

**Files:**
- Create: `services/den/src/auth/personal-email-domain.ts`
- Create: `services/den/test/personal-email-domain.test.ts`

**Step 1: Write failing classifier tests**

Cover exact normalized matching for common global providers (`gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `icloud.com`, `proton.me`, `protonmail.com`) and Czech providers (`seznam.cz`, `email.cz`, `post.cz`, `centrum.cz`, `atlas.cz`, `volny.cz`). Also prove that mixed case and whitespace normalize, an unknown domain such as `acme.example` is allowed, and lookalikes/subdomains such as `gmail.com.example` and `team.gmail.com` are not blocked by suffix matching.

The public API should be:

```ts
export function isPersonalEmailAddress(email: string): boolean
```

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test test/personal-email-domain.test.ts
```

Expected: FAIL because the classifier does not exist.

**Step 3: Implement the minimal exact-domain classifier**

Use the existing email-domain normalizer and one immutable `Set<string>`. Return `false` for malformed emails. Do not use suffix, substring, DNS, or network checks. Keep the provider list centralized in this module and include the tested aliases plus `msn.com`, `ymail.com`, `rocketmail.com`, `me.com`, `mac.com`, `pm.me`, `aol.com`, `gmx.com`, `gmx.net`, `mail.com`, `tuta.com`, `tutanota.com`, and `fastmail.com`.

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test test/personal-email-domain.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/auth/personal-email-domain.ts services/den/test/personal-email-domain.test.ts
git commit -m "feat(den): classify personal email domains"
```

### Task 2: Enforce the policy without removing company-domain bootstrap

**Files:**
- Modify: `services/den/src/auth/signup-gate.ts`
- Modify: `services/den/test/signup-domain-gate.test.ts`

**Step 1: Write failing workflow tests**

Add tests proving:

- `person@gmail.com` without an invitation returns `{ ok: false, error: "domain_not_allowed" }` before any domain or seat lookup;
- the same personal email with a valid invitation returns `mode: "invite"` and still checks the target organization's seats;
- `founder@acme.example` without a registered domain still returns `mode: "organization_bootstrap"`;
- the post-create fallback for an uninvited personal email never calls `ensureSignupOrganization` and never assigns Managed AI;
- the post-create invitation path for a personal email still accepts the invitation;
- an enabled domain record for a known personal provider cannot bypass the personal-domain policy.

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-domain-gate.test.ts
```

Expected: FAIL because personal domains currently select organization bootstrap.

**Step 3: Implement minimal gate integration**

Import `isPersonalEmailAddress`. For a personal email, skip domain self-signup and organization bootstrap. If an invitation token exists, validate it through the existing hash, email-match, expiry, and seat-capacity path; otherwise return `domain_not_allowed`. Apply the same policy in post-create completion so a bypassed or social callback cannot bootstrap a personal domain. Preserve the current behavior for enabled company domains, unclaimed company-domain bootstrap, disabled/invite-only conflict recovery, invitation hashing, cleanup, and Managed-AI ordering.

Do not remove `mode: "organization_bootstrap"`, `createSignupOrganization`, `ensureSignupOrganization`, or concurrent domain-claim recovery.

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test test/personal-email-domain.test.ts test/signup-domain-gate.test.ts test/signup-organization-bootstrap.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/auth/signup-gate.ts services/den/test/signup-domain-gate.test.ts
git commit -m "fix(den): block personal email signup"
```

### Task 3: Explain the rejection in the DEN-hosted desktop browser flow

**Files:**
- Modify: `services/den/public/index.html`
- Modify: `services/den/test/desktop-auth-onboarding-page.test.ts`

**Step 1: Write a failing hosted-page contract**

Require the approved copy and prove `domain_not_allowed` is mapped before rendering:

```text
Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.
```

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: FAIL because the raw backend error is currently displayed.

**Step 3: Implement the mapping**

Define the message once inside the onboarding script. Add a small formatter that checks `code`, `error`, and `message` for the exact `domain_not_allowed` code before falling back to the existing backend message and status handling. Use it in the email/password signup failure branch only; do not alter sign-in, verification, reset, or desktop handoff behavior.

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/public/index.html services/den/test/desktop-auth-onboarding-page.test.ts
git commit -m "fix(auth): explain company email requirement"
```

### Task 4: Explain the rejection in the public web signup surface

**Files:**
- Create: `packages/web/lib/auth-error-message.ts`
- Create: `packages/web/lib/auth-error-message.test.ts`
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Write a failing pure mapper test**

Test that `{ error: "domain_not_allowed" }`, `{ code: "domain_not_allowed" }`, and `{ message: "domain_not_allowed" }` all produce the approved company-email copy, while unrelated authentication messages and safe HTML/non-JSON fallbacks retain current behavior.

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test ../../packages/web/lib/auth-error-message.test.ts
```

Expected: FAIL because the mapper module does not exist.

**Step 3: Extract and extend the mapper**

Move the current `getErrorMessage` behavior from the component into `getAuthErrorMessage` in the new module. Check the stable domain error code before returning raw backend text. Import the helper in the component and replace all current call sites so unrelated behavior remains unchanged. Extend the existing web auth source contract to require the helper wiring and approved copy.

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test ../../packages/web/lib/auth-error-message.test.ts
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/veslo-web typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/web/lib/auth-error-message.ts packages/web/lib/auth-error-message.test.ts packages/web/components/cloud-control.tsx packages/web/scripts/auth-email-flows.mjs
git commit -m "fix(web): clarify personal email signup rejection"
```

### Task 5: Update durable docs and run complete verification

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`

**Step 1: Update canonical behavior**

Document all three durable paths: enabled-domain membership, unclaimed non-personal-domain organization bootstrap, and invitation-based exception for personal email. Remove temporary personal-signup wording and state that hosted clients render company-email guidance for `domain_not_allowed`.

**Step 2: Run focused and service verification**

```bash
pnpm --filter @neatech/den exec tsx --test test/personal-email-domain.test.ts test/signup-domain-gate.test.ts test/signup-organization-bootstrap.test.ts test/auth-email-source.test.ts test/desktop-auth-onboarding-page.test.ts test/org-admin-repository.test.ts
pnpm --filter @neatech/den test
pnpm --filter @neatech/den typecheck
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/veslo-web typecheck
```

Expected: PASS.

**Step 3: Verify stale semantics and formatting**

```bash
rg -n "temporarily allow personal|SIGNUP_DOMAIN_GATE_TEMPORARILY_DISABLED" services/den/src services/den/test docs/features/onboarding-and-auth.md
git diff --check
```

Expected: no stale-policy matches and no whitespace errors.

**Step 4: Run the required repository gate**

```bash
pnpm check
```

Expected: PASS.

**Step 5: Review the acceptance checklist and commit docs**

Confirm that personal providers are blocked before creation, unknown company domains still bootstrap, invitations remain the only personal-email exception, both hosted surfaces show actionable copy, and no approval queue or admin notification exists.

```bash
git add docs/features/onboarding-and-auth.md
git commit -m "docs: document personal email signup gate"
```
