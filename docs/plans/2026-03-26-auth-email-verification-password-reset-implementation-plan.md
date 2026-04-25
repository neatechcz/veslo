# Auth Email Verification + Password Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add low-friction email verification and password reset to Veslo's existing Den-backed auth flow, while gating only cloud worker launch, billing subscription changes, and org membership writes behind verified email.

**Architecture:** Keep `services/den` as the auth source of truth and use Better Auth's native verification and reset flows instead of custom token endpoints. Add a small Den mailer + verified-email guard, expose `emailVerified` cleanly to the web client, extend `packages/web/components/cloud-control.tsx` with verification and forgot-password affordances, and add focused web pages for forgot-password, reset-password, and verification results.

**Tech Stack:** Better Auth, Express, TypeScript, Drizzle/MySQL schema already present in Den, Next.js App Router (`packages/web`), Node test runner (`tsx --test` and source-assertion scripts), pnpm, Docker, Tauri, Chrome MCP

---

## Prerequisites

- Use `@superpowers:using-git-worktrees` before editing.
- Use `@superpowers:test-driven-development` for every behavior change.
- Do not run `packages/web` in standalone dev mode; follow `AGENTS.md` and use Docker + Tauri for runtime verification.
- Final validation must include:
  - `packaging/docker/dev-up.sh`
  - `pnpm --filter @neatech/veslo dev`
  - Chrome MCP flow verification
  - screenshots saved in-repo

### Task 1: Prepare isolated worktree and baseline

**Files:**
- Modify: none (environment prep)

**Step 1: Sync repo/submodules**

Run:

```bash
git submodule update --init --recursive
git fetch --all --prune
```

Expected: both commands complete without errors.

**Step 2: Create and enter dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/auth-email-verification-reset -b codex/auth-email-verification-reset
cd .worktrees/codex/auth-email-verification-reset
```

Expected: new worktree exists on branch `codex/auth-email-verification-reset`.

**Step 3: Install workspace dependencies**

Run:

```bash
pnpm install
```

Expected: install completes without changing the lockfile unexpectedly.

**Step 4: Capture baseline checks**

Run:

```bash
pnpm --dir services/den test
pnpm --filter @neatech/veslo-web build
```

Expected: current Den tests pass and the web app builds before feature edits.

### Task 2: Add failing Den auth-email wiring tests

**Files:**
- Create: `services/den/test/auth-email-source.test.ts`
- Test: `services/den/test/auth-email-source.test.ts`

**Step 1: Write the failing source contract test for Better Auth config**

```ts
test("auth config wires Better Auth verification and reset callbacks", () => {
  assert.equal(source.includes("emailVerification:"), true);
  assert.equal(source.includes("sendVerificationEmail:"), true);
  assert.equal(source.includes("sendOnSignUp: true"), true);
  assert.equal(source.includes("sendResetPassword:"), true);
  assert.equal(source.includes("requireEmailVerification: false"), true);
});
```

**Step 2: Write the failing env contract test**

```ts
test("den env exposes auth email provider configuration", () => {
  assert.equal(envSource.includes("RESEND_API_KEY"), true);
  assert.equal(envSource.includes("AUTH_EMAIL_FROM"), true);
});
```

**Step 3: Run the test to confirm failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-email-source.test.ts
```

Expected: FAIL because `auth.ts` and `env.ts` do not yet contain the required verification/reset configuration.

**Step 4: Commit the failing test**

```bash
git add services/den/test/auth-email-source.test.ts
git commit -m "test: add den auth email wiring spec"
```

### Task 3: Implement Den mailer and Better Auth callbacks

**Files:**
- Create: `services/den/src/email/auth-mailer.ts`
- Modify: `services/den/src/auth.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/README.md`
- Test: `services/den/test/auth-email-source.test.ts`

**Step 1: Add provider env fields**

Implement in `services/den/src/env.ts`:

```ts
RESEND_API_KEY: z.string().optional(),
AUTH_EMAIL_FROM: z.string().optional(),
```

and export:

```ts
email: {
  resendApiKey: parsed.RESEND_API_KEY?.trim() || undefined,
  from: parsed.AUTH_EMAIL_FROM?.trim() || undefined,
}
```

**Step 2: Create the minimal Den mailer**

Implement `services/den/src/email/auth-mailer.ts` with functions shaped like:

```ts
export async function sendVerificationAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "Verify your Veslo email",
    html: `<p>Verify your email: <a href="${input.url}">${input.url}</a></p>`,
    text: `Verify your email: ${input.url}`,
  });
}

export async function sendResetPasswordAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "Reset your Veslo password",
    html: `<p>Reset your password: <a href="${input.url}">${input.url}</a></p>`,
    text: `Reset your password: ${input.url}`,
  });
}
```

Use `fetch("https://api.resend.com/emails", ...)` directly so no extra dependency is required.

**Step 3: Wire Better Auth callbacks in `services/den/src/auth.ts`**

Implement:

```ts
emailVerification: {
  sendOnSignUp: true,
  autoSignInAfterVerification: false,
  sendVerificationEmail: async ({ user, url }) => {
    void sendVerificationAuthEmail({ to: user.email, url });
  },
},
emailAndPassword: {
  enabled: true,
  requireEmailVerification: false,
  sendResetPassword: async ({ user, url }) => {
    void sendResetPasswordAuthEmail({ to: user.email, url });
  },
},
```

**Step 4: Run the test and build**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-email-source.test.ts
pnpm --dir services/den build
```

Expected: PASS for the new source test and a clean Den TypeScript build.

**Step 5: Commit the implementation**

```bash
git add services/den/src/email/auth-mailer.ts services/den/src/auth.ts services/den/src/env.ts services/den/README.md
git commit -m "feat: wire den auth verification and reset emails"
```

### Task 4: Add failing verified-email guard tests

**Files:**
- Create: `services/den/src/http/email-verification.ts`
- Create: `services/den/test/email-verification-guard.test.ts`
- Test: `services/den/test/email-verification-guard.test.ts`

**Step 1: Write the failing helper behavior test**

```ts
test("requireVerifiedEmail returns true for verified sessions", () => {
  const result = requireVerifiedEmail(fakeResponse(), {
    user: { id: "u_1", email: "user@example.com", emailVerified: true, name: "User" },
  });
  assert.equal(result, true);
});

test("requireVerifiedEmail responds with a stable 403 payload for unverified sessions", () => {
  const res = fakeResponse();
  const result = requireVerifiedEmail(res, {
    user: { id: "u_1", email: "user@example.com", emailVerified: false, name: "User" },
  });
  assert.equal(result, false);
  assert.deepEqual(res.jsonBody, {
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email: "user@example.com",
  });
});
```

**Step 2: Run the test to confirm failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/email-verification-guard.test.ts
```

Expected: FAIL because the helper does not exist yet.

**Step 3: Commit the failing test**

```bash
git add services/den/test/email-verification-guard.test.ts
git commit -m "test: add verified email guard spec"
```

### Task 5: Implement the verified-email guard helper

**Files:**
- Create: `services/den/src/http/email-verification.ts`
- Test: `services/den/test/email-verification-guard.test.ts`

**Step 1: Implement the helper**

```ts
export function requireVerifiedEmail(
  res: express.Response,
  session: SessionContext,
): boolean {
  if (session.user.emailVerified) {
    return true;
  }

  res.status(403).json({
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email: session.user.email,
  });
  return false;
}
```

**Step 2: Run the helper test**

Run:

```bash
pnpm --dir services/den exec tsx --test test/email-verification-guard.test.ts
```

Expected: PASS.

**Step 3: Commit the helper**

```bash
git add services/den/src/http/email-verification.ts services/den/test/email-verification-guard.test.ts
git commit -m "feat: add verified email guard helper"
```

### Task 6: Add failing route-wiring tests for gated Den endpoints

**Files:**
- Create: `services/den/test/email-verification-route-source.test.ts`
- Test: `services/den/test/email-verification-route-source.test.ts`

**Step 1: Write the failing workers route source test**

```ts
test("cloud worker creation requires verified email before paywall checks", () => {
  assert.equal(workersSource.includes('if (parsed.data.destination === "cloud")'), true);
  assert.equal(workersSource.includes("requireVerifiedEmail(res, context.session)"), true);
  assert.equal(
    workersSource.indexOf("requireVerifiedEmail(res, context.session)") <
      workersSource.indexOf("requireCloudWorkerAccess({"),
    true,
  );
});
```

**Step 2: Write the failing org membership source test**

```ts
test("org membership writes require verified email", () => {
  assert.equal(orgsSource.match(/requireVerifiedEmail\\(res, context\\.session\\)/g)?.length ?? 0, 3);
});
```

**Step 3: Write the failing billing mutation source test**

```ts
test("billing subscription mutation requires verified email", () => {
  assert.equal(billingSection.includes("requireVerifiedEmail(res, session)"), true);
});
```

**Step 4: Run the test to confirm failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/email-verification-route-source.test.ts
```

Expected: FAIL because the routes are not yet guarded.

**Step 5: Commit the failing source test**

```bash
git add services/den/test/email-verification-route-source.test.ts
git commit -m "test: add verified email route gating spec"
```

### Task 7: Apply the verified-email guard to Den routes

**Files:**
- Modify: `services/den/src/http/workers.ts`
- Modify: `services/den/src/http/orgs.ts`
- Test: `services/den/test/email-verification-route-source.test.ts`
- Test: `services/den/test/email-verification-guard.test.ts`

**Step 1: Guard cloud worker creation**

In `services/den/src/http/workers.ts`, add:

```ts
if (parsed.data.destination === "cloud" && !requireVerifiedEmail(res, context.session)) {
  return;
}
```

before `requireCloudWorkerAccess(...)`.

**Step 2: Guard billing subscription mutation**

In `services/den/src/http/workers.ts`, add:

```ts
if (!requireVerifiedEmail(res, session)) {
  return;
}
```

before `setCloudWorkerSubscriptionCancellation(...)`.

**Step 3: Guard org membership add/update/delete**

Add the same early-return pattern to:

- `POST /:orgId/members`
- `PATCH /:orgId/members/:memberId`
- `DELETE /:orgId/members/:memberId`

inside `services/den/src/http/orgs.ts`.

**Step 4: Run targeted Den tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/email-verification-guard.test.ts test/email-verification-route-source.test.ts
pnpm --dir services/den test
```

Expected: both targeted suites PASS and the full Den test suite remains green.

**Step 5: Commit the route changes**

```bash
git add services/den/src/http/workers.ts services/den/src/http/orgs.ts
git commit -m "feat: gate cloud and org mutations on verified email"
```

### Task 8: Add failing web auth-flow source tests

**Files:**
- Create: `packages/web/scripts/auth-email-flows.mjs`
- Modify: `packages/web/package.json`
- Test: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Write the failing auth-state assertions**

```js
assert.ok(
  source.includes("emailVerified"),
  "cloud-control.tsx must track email verification state on the signed-in user"
);

assert.ok(
  source.includes("/api/auth/send-verification-email"),
  "cloud-control.tsx must support resend verification"
);
```

**Step 2: Write the failing forgot-password and gated-error assertions**

```js
assert.ok(
  source.includes("/forgot-password"),
  "cloud-control.tsx must expose a forgot-password entry point"
);

assert.ok(
  source.includes("email_verification_required"),
  "cloud-control.tsx must handle verified-email gating responses"
);
```

**Step 3: Write the failing route-page assertions**

```js
assert.ok(existsSync(resolve(here, "../app/forgot-password/page.tsx")), "forgot-password page must exist");
assert.ok(existsSync(resolve(here, "../app/reset-password/page.tsx")), "reset-password page must exist");
assert.ok(existsSync(resolve(here, "../app/verify-email/page.tsx")), "verify-email page must exist");
```

**Step 4: Run the script to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-web exec node scripts/auth-email-flows.mjs
```

Expected: FAIL because the auth UI and route pages do not exist yet.

**Step 5: Commit the failing script**

```bash
git add packages/web/scripts/auth-email-flows.mjs
git commit -m "test: add web auth email flow spec"
```

### Task 9: Implement web verification, forgot-password, and reset-password flows

**Files:**
- Create: `packages/web/lib/auth-urls.ts`
- Create: `packages/web/app/forgot-password/page.tsx`
- Create: `packages/web/app/reset-password/page.tsx`
- Create: `packages/web/app/verify-email/page.tsx`
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/package.json`
- Test: `packages/web/scripts/auth-email-flows.mjs`

**Step 1: Add a shared callback URL helper**

Implement `packages/web/lib/auth-urls.ts`:

```ts
const AUTH_BASE = (process.env.NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL ?? "https://app.veslo.neatech.com").trim();

export function buildAuthCallbackUrl(pathname: string) {
  return new URL(pathname, AUTH_BASE || "https://app.veslo.neatech.com").toString();
}
```

**Step 2: Extend `cloud-control.tsx` auth state and sign-up body**

- Add `emailVerified: boolean` to `AuthUser`.
- Parse it in `getUser(...)`.
- When `authMode === "sign-up"`, include:

```ts
callbackURL: buildAuthCallbackUrl("/verify-email")
```

in the `/api/auth/sign-up/email` body.

**Step 3: Add resend-verification and gated-error handling**

Implement client behavior in `cloud-control.tsx`:

```ts
if (response.status === 403 && isRecord(payload) && payload.error === "email_verification_required") {
  setLaunchError("Verify your email before launching a cloud worker.");
  return;
}
```

and add a resend action that posts:

```ts
await requestJson("/api/auth/send-verification-email", {
  method: "POST",
  body: JSON.stringify({
    email: user.email,
    callbackURL: buildAuthCallbackUrl("/verify-email"),
  }),
});
```

**Step 4: Add forgot-password and reset-password pages**

- `packages/web/app/forgot-password/page.tsx`
  - submit email to `/api/auth/request-password-reset`
  - send `redirectTo: buildAuthCallbackUrl("/reset-password")`
  - always show a neutral confirmation state
- `packages/web/app/reset-password/page.tsx`
  - read `token`/`error` from `searchParams`
  - submit `newPassword` + `token` to `/api/auth/reset-password`
- `packages/web/app/verify-email/page.tsx`
  - show success when `error` is absent
  - show resend guidance when `error` is present

**Step 5: Add package script, run checks, and commit**

Run:

```bash
pnpm --filter @neatech/veslo-web exec node scripts/auth-email-flows.mjs
pnpm --filter @neatech/veslo-web build
```

Expected: source script PASS and Next build PASS.

Commit:

```bash
git add packages/web/lib/auth-urls.ts packages/web/app/forgot-password/page.tsx packages/web/app/reset-password/page.tsx packages/web/app/verify-email/page.tsx packages/web/components/cloud-control.tsx packages/web/package.json
git commit -m "feat: add web verification and password reset flows"
```

### Task 10: Full verification, evidence capture, and finish

**Files:**
- Create: `packages/app/pr/2026-03-26-auth-email-verification-reset/verification-home.png`
- Create: `packages/app/pr/2026-03-26-auth-email-verification-reset/forgot-password.png`
- Create: `packages/app/pr/2026-03-26-auth-email-verification-reset/reset-password.png`
- Create: `packages/app/pr/2026-03-26-auth-email-verification-reset/verified-gate.png`
- Modify: optional release/PR notes only if needed

**Step 1: Run automated verification**

Run:

```bash
pnpm --dir services/den test
pnpm --filter @neatech/veslo-web exec node scripts/auth-email-flows.mjs
pnpm --filter @neatech/veslo-web build
```

Expected: all pass.

**Step 2: Start the required dev stack**

Run from repo root:

```bash
packaging/docker/dev-up.sh
pnpm --filter @neatech/veslo dev
```

Expected: Docker services start successfully and the Tauri desktop app launches. Do not use `next dev`.

**Step 3: Validate the end-to-end flow with Chrome MCP**

Use `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to verify:

1. Sign up with email/password.
2. Confirm verification banner appears after sign-in.
3. Trigger resend verification email.
4. Attempt cloud worker launch before verifying and confirm `email_verification_required` UX.
5. Trigger forgot-password and complete reset flow.
6. Verify email and confirm cloud worker launch is no longer blocked.

**Step 4: Capture screenshots in-repo**

Save screenshots under:

```text
packages/app/pr/2026-03-26-auth-email-verification-reset/
```

Minimum captures:

- auth home/banner
- forgot-password page
- reset-password page
- verified-email gate or post-verification success

**Step 5: Final commit**

```bash
git add packages/app/pr/2026-03-26-auth-email-verification-reset
git commit -m "chore: add auth verification flow evidence"
```

If Docker, Tauri, or Chrome MCP cannot run, stop and document:

- which exact step failed,
- why it failed,
- which automated checks passed,
- the exact commands the reviewer should run to finish validation.
