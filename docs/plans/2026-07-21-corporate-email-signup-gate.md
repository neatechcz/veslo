# Corporate Email Signup Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reject signup before account creation unless the email belongs to an enabled self-signup organization domain or carries a valid organization invitation, and show rejected users clear company-email guidance.

**Architecture:** DEN remains the server-side policy owner and enforces the rule in the existing request guard and Better Auth pre-create hook. Existing organization-domain and invitation repositories remain unchanged. The DEN-hosted desktop browser page and the public web signup surface map the stable `domain_not_allowed` error code to actionable copy.

**Tech Stack:** TypeScript, Better Auth, Express, Node test runner, React/Next.js, static DEN onboarding HTML, pnpm workspace checks.

---

### Task 1: Restore the DEN corporate-domain gate

**Files:**
- Modify: `services/den/test/signup-domain-gate.test.ts`
- Modify: `services/den/src/auth/signup-gate.ts`

**Step 1: Replace the temporary personal-signup expectations with failing gate expectations**

Update the three tests that currently document the temporary bypass:

```ts
test("missing enabled domain requires an organization invitation", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: null,
      activeSeats: 0,
      seatLimit: null,
      hasValidInvite: false,
    }),
    { ok: false, error: "domain_not_allowed" },
  )
})

test("email signup without an enabled domain or invite is rejected", async () => {
  const decision = await resolveEmailSignupAccess({
    email: "person@gmail.com",
    inviteToken: null,
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used")
      },
      assertCanActivateOrganizationSeat: async () => {
        throw new Error("invite seat check should not be used")
      },
      resolveValidOrganizationInviteForSignup: async () => {
        throw new Error("invite lookup should not be used")
      },
    },
  })

  assert.deepEqual(decision, { ok: false, error: "domain_not_allowed" })
})

test("post-create signup without domain or invite never creates a personal organization", async () => {
  const result = await completeSignupAfterUserCreate({
    user: { id: "user_1", email: "personal@example.test" },
    inviteToken: null,
    createMembershipId: () => "membership_1",
    resolveEnabledOrganizationDomainForEmail: async () => {
      throw new OrganizationAdminRepositoryError("domain_not_allowed")
    },
    createOrActivateOrganizationMembership: async () => {
      throw new Error("membership should not be activated")
    },
    acceptOrganizationInvite: async () => {
      throw new Error("invite should not be accepted")
    },
  })

  assert.deepEqual(result, { activatedOrganizationMembership: false, createDefaultOrganization: false })
})
```

Add one explicit decision test proving that a personal email with a valid invitation remains allowed:

```ts
test("valid organization invite remains the only personal-email signup exception", async () => {
  const decision = await resolveEmailSignupAccess({
    email: "person@gmail.com",
    inviteToken: "raw_invite_token_once",
    dependencies: {
      resolveEnabledOrganizationDomainForEmail: async () => {
        throw new OrganizationAdminRepositoryError("domain_not_allowed")
      },
      countActiveOrganizationSeats: async () => {
        throw new Error("domain seat count should not be used")
      },
      assertCanActivateOrganizationSeat: async () => undefined,
      resolveValidOrganizationInviteForSignup: async ({ email, tokenHash }) =>
        createInviteRecord({ email, tokenHash }),
    },
  })

  assert.equal(decision.ok, true)
  assert.equal(decision.ok && decision.mode, "invite")
})
```

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-domain-gate.test.ts
```

Expected: FAIL because missing-domain signup still returns `mode: "personal"` and post-create still requests a default organization.

**Step 3: Remove the temporary personal-signup fallback**

In `signup-gate.ts`:

- remove `SIGNUP_DOMAIN_GATE_TEMPORARILY_DISABLED`;
- remove `mode: "personal"` from both decision unions;
- remove both branches that return personal signup;
- make the no-domain/no-invite path return `{ ok: false, error: "domain_not_allowed" }`;
- make the post-create fallback return `{ activatedOrganizationMembership: false, createDefaultOrganization: false }`.

The resulting terminal branches should be:

```ts
return { ok: false, error: "domain_not_allowed" }
```

and:

```ts
return { activatedOrganizationMembership: false, createDefaultOrganization: false }
```

Do not change enabled-domain, invitation hashing, invitation acceptance, or seat-capacity logic.

**Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/signup-domain-gate.test.ts
```

Expected: all signup-domain-gate tests PASS.

**Step 5: Commit the policy change**

```bash
git add services/den/test/signup-domain-gate.test.ts services/den/src/auth/signup-gate.ts
git commit -m "fix(den): require corporate domain for signup"
```

### Task 2: Show actionable guidance in the DEN-hosted desktop signup page

**Files:**
- Modify: `services/den/test/desktop-auth-onboarding-page.test.ts`
- Modify: `services/den/public/index.html`

**Step 1: Write a failing hosted-page contract test**

Add:

```ts
test("desktop signup explains the corporate-email requirement", () => {
  assert.equal(
    onboardingPage.includes(
      "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.",
    ),
    true,
  )
  assert.match(onboardingPage, /domain_not_allowed/)
  assert.match(onboardingPage, /formatAuthRequestError\(data, response\.status\)/)
})
```

**Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: FAIL because the hosted page currently renders the raw `domain_not_allowed` value.

**Step 3: Add error-code mapping to the hosted page**

Inside the onboarding script, define the approved copy once and map response codes before rendering:

```js
const COMPANY_EMAIL_SIGNUP_MESSAGE = "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.";

function formatAuthRequestError(data, status) {
  const codes = [data?.code, data?.error, data?.message];
  if (codes.includes("domain_not_allowed")) {
    return COMPANY_EMAIL_SIGNUP_MESSAGE;
  }
  return data?.message || data?.error || `Request failed (${status})`;
}
```

Change the email/password signup failure branch to call:

```js
showError(formatAuthRequestError(data, response.status));
```

Keep sign-in, password-reset, verification, and desktop handoff behavior unchanged.

**Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: all desktop onboarding page tests PASS.

**Step 5: Commit the hosted-page change**

```bash
git add services/den/test/desktop-auth-onboarding-page.test.ts services/den/public/index.html
git commit -m "fix(auth): explain corporate email signup requirement"
```

### Task 3: Show the same guidance in the public web signup surface

**Files:**
- Create: `packages/web/lib/auth-error-message.ts`
- Create: `packages/web/lib/auth-error-message.test.ts`
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Write a failing pure error-mapping test**

Create `auth-error-message.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { COMPANY_EMAIL_SIGNUP_MESSAGE, getAuthErrorMessage } from "./auth-error-message.js"

test("maps every DEN domain rejection shape to company-email guidance", () => {
  for (const payload of [
    { error: "domain_not_allowed" },
    { code: "domain_not_allowed", message: "domain_not_allowed" },
    { message: "domain_not_allowed" },
  ]) {
    assert.equal(getAuthErrorMessage(payload, "fallback"), COMPANY_EMAIL_SIGNUP_MESSAGE)
  }
})

test("preserves unrelated authentication messages", () => {
  assert.equal(getAuthErrorMessage({ message: "Invalid password" }, "fallback"), "Invalid password")
})
```

**Step 2: Run the pure test and verify RED**

Run from the repository root:

```bash
pnpm --filter @neatech/den exec tsx --test ../../packages/web/lib/auth-error-message.test.ts
```

Expected: FAIL because `auth-error-message.ts` does not exist.

**Step 3: Extract and extend the web error mapper**

Create `auth-error-message.ts` with the approved message and the existing safe handling for text, HTML, non-JSON, `message`, and `error` payloads. Check `code`, `error`, and `message` for the exact stable code before returning raw backend text:

```ts
export const COMPANY_EMAIL_SIGNUP_MESSAGE =
  "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation."

export function getAuthErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    const codes = [payload.code, payload.error, payload.message]
    if (codes.includes("domain_not_allowed")) {
      return COMPANY_EMAIL_SIGNUP_MESSAGE
    }
  }

  // Preserve the current HTML, long-text, message, error, and fallback handling.
}
```

Import this helper in `cloud-control.tsx`, remove the local `getErrorMessage`, and replace its call sites with `getAuthErrorMessage`. This retains current behavior for non-signup errors while making the stable domain code actionable.

Extend `auth-email-flows.mjs` to assert that the component imports `getAuthErrorMessage` and that the helper source contains `domain_not_allowed` and the approved message.

**Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test ../../packages/web/lib/auth-error-message.test.ts
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/veslo-web typecheck
```

Expected: all commands PASS.

**Step 5: Commit the web guidance change**

```bash
git add packages/web/lib/auth-error-message.ts packages/web/lib/auth-error-message.test.ts packages/web/components/cloud-control.tsx packages/web/scripts/auth-email-flows.mjs
git commit -m "fix(web): clarify corporate email signup policy"
```

### Task 4: Update durable authentication documentation

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`

**Step 1: Write the implemented policy into the canonical feature document**

Replace the temporary 2026-06-21 personal-signup paragraph with:

```md
Signup policy: if an email has no enabled self-signup organization domain, signup is rejected before user creation unless the request carries a valid pending organization invitation for that email. A valid invitation remains the only exception for personal email addresses and still enforces the target organization's seat limit. Rejected hosted signup surfaces tell the user to use a company email or the registration link from an organization invitation.
```

**Step 2: Verify the temporary policy is gone**

Run:

```bash
rg -n "temporarily allow|temporarily disabled|SIGNUP_DOMAIN_GATE_TEMPORARILY_DISABLED|mode: \"personal\"" services/den/src services/den/test docs/features/onboarding-and-auth.md
```

Expected: no matches.

**Step 3: Commit the documentation update**

```bash
git add docs/features/onboarding-and-auth.md
git commit -m "docs: document enforced signup domain policy"
```

### Task 5: Run focused and repository verification

**Files:**
- Verify only; no planned source changes.

**Step 1: Run the complete DEN test suite and typecheck**

```bash
pnpm --filter @neatech/den test
pnpm --filter @neatech/den typecheck
```

Expected: PASS with zero failing tests and zero type errors.

**Step 2: Run public web auth contracts and typecheck**

```bash
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/veslo-web typecheck
```

Expected: PASS.

**Step 3: Run whitespace and change-scope checks**

```bash
git diff --check HEAD~4..HEAD
git status --short
```

Expected: no whitespace errors; only intentional implementation state is present.

**Step 4: Run the required repository gate**

```bash
pnpm check
```

Expected: PASS across lint, typechecks, unit/contract tests, Rust checks, and architecture audits.

**Step 5: Review the requirement checklist**

Confirm from fresh test evidence that:

- personal email without an invitation is rejected before account creation;
- enabled corporate domain signup remains allowed;
- valid organization invitations remain allowed for personal email;
- seat-capacity failures remain distinct;
- both hosted signup surfaces show the approved guidance;
- no approval queue, pending-request persistence, or admin notification was introduced.
