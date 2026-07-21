# Email Verification Hard Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make email verification mandatory for production email/password authentication, prove that Lettr accepted the registration email, and prevent every DEN and desktop handoff session from becoming usable before verification.

**Architecture:** DEN derives one `authRequireEmailVerification` policy from the existing deployment switch, defaulting it on in production and validating that the Lettr transport is complete. Better Auth uses that policy for signup and sign-in, while the common DEN session boundary and both desktop handoff routes reject legacy unverified sessions. The hosted browser onboarding page becomes a verification-only recovery surface until a later verified sign-in succeeds.

**Tech Stack:** TypeScript, Better Auth 1.4, Express, Drizzle/MySQL, Lettr HTTPS API, Node test runner, Playwright, Tauri Pilot, Docker Compose, pnpm.

---

### Task 1: Make the verification policy fail closed in production

**Files:**
- Modify: `services/den/src/env.ts:141-208`
- Modify: `services/den/.env.example:8-13`
- Modify: `services/den/test/deployment-endpoints-env.test.ts`
- Modify: `services/den/test/auth-email-source.test.ts`

**Step 1: Write the failing environment tests**

Add cases that prove production defaults to verification, production rejects missing Lettr values, explicit development disablement remains available, and enabled development policy also requires transport configuration:

```ts
test("production requires email verification and complete Lettr config", async () => {
  const { parseEnv } = await import("../src/env.js")

  assert.throws(
    () => parseEnv({ ...baseEnv, NODE_ENV: "production" }),
    /LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required/,
  )

  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "production",
    LETTR_API_KEY: "lettr-key",
    AUTH_EMAIL_ADDRESS: "auth@example.test",
  })
  assert.equal(parsed.authRequireEmailVerification, true)
})

test("development may explicitly disable verification", async () => {
  const { parseEnv } = await import("../src/env.js")
  const parsed = parseEnv({
    ...baseEnv,
    NODE_ENV: "development",
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
  })
  assert.equal(parsed.authRequireEmailVerification, false)
})
```

Update the source-contract expectation from a default `false` policy to the new named policy.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/deployment-endpoints-env.test.ts test/auth-email-source.test.ts
```

Expected: FAIL because `authRequireEmailVerification` does not exist and production does not reject missing mail configuration.

**Step 3: Implement the minimal policy parser**

In `parseEnv`, normalize email values once and calculate the policy:

```ts
const lettrApiKey = parsed.LETTR_API_KEY?.trim() || undefined
const authEmailAddress = parsed.AUTH_EMAIL_ADDRESS?.trim() || undefined
const authRequireEmailVerification = parsed.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED == null
  ? nodeEnv === "production"
  : parsed.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED.toLowerCase() === "true"

if (authRequireEmailVerification && (!lettrApiKey || !authEmailAddress)) {
  throw new Error(
    "LETTR_API_KEY and AUTH_EMAIL_ADDRESS are required when email verification is enabled.",
  )
}
```

Return `authRequireEmailVerification`, keep `desktopAuthRequireEmailVerified` as a temporary equal-valued compatibility alias only if another caller still needs it, and use the normalized values in `email`. Keep `.env.example` explicitly disabled for local development and explain in its adjacent comment that production defaults to enabled.

**Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/env.ts services/den/.env.example services/den/test/deployment-endpoints-env.test.ts services/den/test/auth-email-source.test.ts
git commit -m "feat(den): fail closed on verification config"
```

### Task 2: Await verification delivery and enable Better Auth's hard gate

**Files:**
- Modify: `services/den/src/auth.ts:58-90`
- Modify: `services/den/src/email/auth-mailer.ts:18-54`
- Modify: `services/den/test/auth-mailer.test.ts`
- Modify: `services/den/test/auth-email-source.test.ts`

**Step 1: Write failing mailer and auth tests**

Replace the background verification-email test with provider-failure propagation and keep the background helper test only for password reset:

```ts
test("verification auth email rejects when Lettr does not accept the message", async () => {
  withRequiredEnv()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("unavailable", { status: 503 })

  try {
    const { sendVerificationAuthEmail } = await importAuthMailer()
    await assert.rejects(
      sendVerificationAuthEmail({ to: "user@example.com", url: "https://example.com/verify" }),
      /Failed to send auth email: 503/,
    )
  } finally {
    globalThis.fetch = originalFetch
    clearRequiredEnv()
  }
})
```

Update the auth source contract to require all of these exact behaviors:

```ts
assert.equal(source.includes("sendOnSignIn: true"), true)
assert.equal(source.includes("await sendVerificationAuthEmail"), true)
assert.equal(source.includes("requireEmailVerification: env.authRequireEmailVerification"), true)
assert.equal(source.includes("fireAndForgetAuthEmail(sendVerificationAuthEmail"), false)
```

**Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/auth-mailer.test.ts test/auth-email-source.test.ts
```

Expected: FAIL on `sendOnSignIn`, awaited delivery, and the hard-gate policy.

**Step 3: Implement required verification delivery**

Keep the reset mail path fire-and-forget, but make verification delivery awaited and return a stable safe error:

```ts
const authEmailVerification = isAuthEmailConfigured()
  ? {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        try {
          await sendVerificationAuthEmail({ to: user.email, url })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[auth-mailer] verification delivery failed: ${message}`)
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "verification_email_delivery_failed",
          })
        }
      },
    }
  : undefined
```

Bind the native gate:

```ts
emailAndPassword: {
  enabled: true,
  requireEmailVerification: env.authRequireEmailVerification,
  ...(authEmailPasswordReset ?? {}),
},
```

Do not include Lettr response bodies or credentials in thrown errors.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/auth.ts services/den/src/email/auth-mailer.ts services/den/test/auth-mailer.test.ts services/den/test/auth-email-source.test.ts
git commit -m "feat(den): require verified email sign in"
```

### Task 3: Reject legacy unverified sessions at every DEN boundary

**Files:**
- Modify: `services/den/src/http/session.ts:17-48`
- Modify: `services/den/src/http/desktop-auth.ts:192-200`
- Modify: `services/den/src/http/desktop-auth-v2.ts:326-332`
- Modify: `services/den/test/email-verification-guard.test.ts`
- Create: `services/den/test/email-verification-session-source.test.ts`

**Step 1: Write failing session and handoff contracts**

Add a source-level boundary contract that prevents accidental bypass while the route dependencies remain database-backed:

```ts
test("common DEN session boundary rejects unverified users when policy is enabled", () => {
  assert.match(sessionSource, /env\.authRequireEmailVerification/)
  assert.match(sessionSource, /requireVerifiedEmail\(res, context\)/)
})

test("both desktop handoff generations depend on the verified session boundary", () => {
  assert.match(legacyDesktopAuthSource, /requireSession\(req, res\)/)
  assert.match(desktopAuthV2Source, /requireSession\(req, res\)/)
  assert.doesNotMatch(desktopAuthV2Source, /desktopAuthRequireEmailVerified/)
})
```

Extend `email-verification-guard.test.ts` to assert the stable response remains:

```json
{
  "error": "email_verification_required",
  "message": "Verify your email to continue.",
  "email": "user@example.com"
}
```

**Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/email-verification-guard.test.ts test/email-verification-session-source.test.ts
```

Expected: FAIL because `requireSession` returns unverified sessions and v2 still uses the old optional route-local switch.

**Step 3: Enforce verification in the shared session boundary**

Build the normalized context once, preserve disabled-user precedence, then apply the policy:

```ts
const context: SessionContext = {
  user: {
    id: session.user.id,
    email: typeof session.user.email === "string" ? session.user.email : null,
    emailVerified: session.user.emailVerified === true,
    name: typeof session.user.name === "string" ? session.user.name : null,
  },
}

if (env.authRequireEmailVerification && !requireVerifiedEmail(res, context)) {
  return null
}

return context
```

Both handoff generations must continue to call `requireSession`. Remove the v2 route-local environment condition because the shared boundary now covers v1, v2, `/v1/me`, organization, billing, runtime entitlement, and legacy bearer sessions consistently.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/session.ts services/den/src/http/desktop-auth.ts services/den/src/http/desktop-auth-v2.ts services/den/test/email-verification-guard.test.ts services/den/test/email-verification-session-source.test.ts
git commit -m "fix(den): reject legacy unverified sessions"
```

### Task 4: Turn hosted onboarding into a verification-only recovery flow

**Files:**
- Modify: `services/den/public/index.html:210-241,600-616,885-1069`
- Modify: `services/den/test/desktop-auth-onboarding-page.test.ts`
- Modify: `services/den/scripts/desktop-auth-context-restore.mjs`

**Step 1: Write failing browser source and script tests**

Require the hosted page to omit the bypass and handle the two stable Better Auth errors:

```ts
test("unverified browser auth cannot continue to Veslo", () => {
  assert.equal(onboardingPage.includes('id="continue-to-veslo"'), false)
  assert.equal(onboardingPage.includes("You can still continue to Veslo right now"), false)
  assert.equal(onboardingPage.includes("cloud-gated actions still require"), false)
})

test("signup and unverified sign-in enter the verification recovery view", () => {
  assert.equal(onboardingPage.includes('"EMAIL_NOT_VERIFIED"'), true)
  assert.equal(onboardingPage.includes('"verification_email_delivery_failed"'), true)
  assert.match(onboardingPage, /mode === "sign-up"[\s\S]+activeView = "verify-required"/)
})
```

Extend the existing browser script test so a signup success with `{ token: null }` lands on verification-required, resend success stays there, and only a later verified sign-in invokes handoff.

**Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
node services/den/scripts/desktop-auth-context-restore.mjs
```

Expected: FAIL because the bypass button and permissive copy remain.

**Step 3: Implement the browser state transition**

Remove `continue-to-veslo`, its JavaScript reference, and its event listener. Replace the permissive subtitle with:

```html
<p class="subtitle">Verify this email address before signing in to Veslo.</p>
```

Add one helper used by signup and sign-in failures:

```js
function showVerificationRequired(email, info = "", error = "") {
  verificationEmail = (email || "").trim();
  verificationInfo = info;
  verificationError = error;
  activeView = "verify-required";
  renderView(true);
}
```

On successful signup, do not call `/v1/me`; show the verification-required state and explain that a message was sent. On failed sign-in with `EMAIL_NOT_VERIFIED`, show the same state and explain that a new message was sent. On `verification_email_delivery_failed`, show the state with a delivery error and the resend control. Only a successful sign-in with a non-empty token calls `doHandoff("auth")`.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/public/index.html services/den/test/desktop-auth-onboarding-page.test.ts services/den/scripts/desktop-auth-context-restore.mjs
git commit -m "fix(auth): block onboarding until email verification"
```

### Task 5: Add a real DEN registration acceptance path

**Files:**
- Create: `services/den/test/auth-email-verification.integration.test.ts`
- Create: `services/den/scripts/run-email-verification-integration.mjs`
- Modify: `services/den/package.json`
- Modify: `packaging/docker/docker-compose.dev.yml`
- Create: `packages/e2e/specs/den-email-verification.playwright.spec.ts`
- Modify: `packages/e2e/package.json`

**Step 1: Add an opt-in failing integration test**

The runner must start the existing development MySQL service in an isolated Compose project, migrate DEN, launch DEN with verification enabled, and expose a loopback-only Lettr-compatible capture server. The capture server records only recipient, subject, and verification URL and never logs the configured API key.

The integration test must execute this sequence with a unique company-domain email:

```ts
const signup = await request.post("/api/auth/sign-up/email", {
  data: { name: "Verification E2E", email, password, callbackURL },
})
expect(signup.ok()).toBeTruthy()
expect((await signup.json()).token).toBeNull()
expect(capturedMessages).toHaveLength(1)

const blocked = await request.post("/api/auth/sign-in/email", {
  data: { email, password },
})
expect(blocked.status()).toBe(403)

const beforeVerification = await authorizeDesktopTransaction(request, email, password)
expect(beforeVerification.status()).toBe(403)

await request.get(capturedMessages.at(-1)!.verificationUrl)

const signedIn = await request.post("/api/auth/sign-in/email", {
  data: { email, password },
})
expect(signedIn.ok()).toBeTruthy()
expect((await signedIn.json()).token).toEqual(expect.any(String))
```

Use a test-only injected `fetch` or mailer dependency inside the DEN process; do not add a production override that can redirect the Lettr API key to an arbitrary host.

**Step 2: Run the acceptance test and verify RED**

Run:

```bash
pnpm --dir services/den test:email-verification:integration
```

Expected: FAIL before the test harness or hard gate exists.

**Step 3: Finish the isolated runner and browser E2E**

The Playwright spec navigates to the actual DEN hosted onboarding page, submits signup, and asserts:

```ts
await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible()
await expect(page.getByRole("button", { name: "Continue to Veslo" })).toHaveCount(0)
await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible()
```

Then make the capture stub reject one resend, verify the visible delivery error, restore acceptance, resend, follow the captured verification link, sign in, and assert that the desktop transaction reaches `authorized` only after verification.

Add scripts:

```json
{
  "test:email-verification:integration": "node scripts/run-email-verification-integration.mjs",
  "test:email-verification:browser": "playwright test ./specs/den-email-verification.playwright.spec.ts"
}
```

Ensure teardown stops only the isolated Compose project and loopback processes created by the runner.

**Step 4: Run the acceptance and browser tests and verify GREEN**

Run:

```bash
pnpm --dir services/den test:email-verification:integration
pnpm --filter @neatech/veslo-e2e test:email-verification:browser
```

Expected: PASS, with one signup email, blocked pre-verification sign-in/handoff, honest resend failure, and successful post-verification sign-in.

**Step 5: Commit**

```bash
git add services/den/test/auth-email-verification.integration.test.ts services/den/scripts/run-email-verification-integration.mjs services/den/package.json packaging/docker/docker-compose.dev.yml packages/e2e/specs/den-email-verification.playwright.spec.ts packages/e2e/package.json
git commit -m "test(auth): cover verified registration end to end"
```

### Task 6: Verify the real desktop handoff boundary with Tauri Pilot

**Files:**
- Create: `packages/e2e/pilot-scenarios/email-verification-handoff.toml`
- Modify: `packages/e2e/helpers/pilot-scenario-plan.ts`
- Modify: `packages/e2e/helpers/__fixtures__/pilot-selection-contract.v1.json`
- Modify: `packages/e2e/package.json`
- Modify: `docs/dev/testing-playbook.md`

**Step 1: Add the failing Pilot scenario contract**

Register a focused scenario that uses the isolated DEN fixture from Task 5. The fixture creates one unverified legacy bearer session and one verified session. The scenario must prove that the unverified transaction never produces a handoff code, then use the verified transaction/deep link and assert the real Tauri app persists the verified DEN user.

The final Pilot assertion should read both browser and native snapshots:

```js
const authRaw = window.localStorage.getItem("veslo.den.auth") ??
  window.sessionStorage.getItem("veslo.den.auth");
const auth = JSON.parse(authRaw || "null");
if (auth?.user?.email !== expectedVerifiedEmail) {
  throw new Error("verified desktop handoff did not persist the expected user");
}
```

**Step 2: Run the scenario-selection test and verify RED**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec tsx --test helpers/pilot-scenario-plan.test.ts
```

Expected: FAIL because the scenario and fixture contract are not registered.

**Step 3: Implement the fixture mutations and scenario**

Add only the minimum environment mutations needed to point the desktop at the loopback DEN fixture. Do not reuse the user's current profile or live DEN token. Keep the scenario focused on browser-auth result ingestion and persisted authenticated identity; the browser UI itself remains covered by Playwright.

**Step 4: Perform mandatory desktop preflight**

Run the exact preflight from `docs/dev/testing-playbook.md`. Stop only internally started Veslo dev/test processes from this repository and verify the post-check is empty before building or launching Pilot.

**Step 5: Build and run the real desktop test**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
cd ../e2e
pnpm test:pilot -- --scenario email-verification-handoff
```

Expected: PASS. The unverified identity is rejected and the verified identity reaches the signed-in desktop state.

**Step 6: Commit**

```bash
git add packages/e2e/pilot-scenarios/email-verification-handoff.toml packages/e2e/helpers/pilot-scenario-plan.ts packages/e2e/helpers/__fixtures__/pilot-selection-contract.v1.json packages/e2e/package.json docs/dev/testing-playbook.md
git commit -m "test(desktop): verify email-gated auth handoff"
```

### Task 7: Lock deployment defaults and document shipped behavior

**Files:**
- Modify: `packaging/owned-server/compose.yml:145-160`
- Modify: `packaging/owned-server/env.example:28-36`
- Modify: `packaging/owned-server/env.staging.example:30-38`
- Modify: `.github/workflows/deploy-owned-server.yml`
- Modify: `.github/workflows/deploy-staging-server.yml`
- Modify: `services/den/README.md:34-42,104-114`
- Modify: `docs/features/onboarding-and-auth.md:35-56`
- Modify: `docs/dev/state-and-config-reference.md:96-123`
- Modify: `services/den/test/staging-owned-server-config.test.ts`

**Step 1: Write failing deployment contracts**

Extend the owned-server config tests to require:

```ts
for (const requiredText of [
  "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true",
  "LETTR_API_KEY=replace_with_lettr_api_key",
  "AUTH_EMAIL_ADDRESS=auth@veslo.work",
]) {
  assert.match(productionEnv, new RegExp(escape(requiredText)))
  assert.match(stagingEnv, new RegExp(escape(requiredText)))
}
```

Require both deploy workflows to validate non-empty `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, and `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED=true` before bringing DEN healthy, independently of whether backup scheduling is enabled.

**Step 2: Run deployment tests and verify RED**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
```

Expected: FAIL because mail validation currently occurs only in the optional backup step.

**Step 3: Implement deployment validation and canonical docs**

Keep the Compose default `true`, reject an explicit production `false` in deployment preflight, and document:

- signup waits for Lettr acceptance;
- signup returns no authenticated session before verification;
- unverified sign-in resends and remains blocked;
- verified sign-in is required before desktop handoff;
- production fails closed without mail transport;
- the switch remains `false` only in intentionally isolated development/rehearsal configurations.

Update the already-approved design document component wording from Desktop Auth v2 to both current and legacy handoff routes.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add packaging/owned-server/compose.yml packaging/owned-server/env.example packaging/owned-server/env.staging.example .github/workflows/deploy-owned-server.yml .github/workflows/deploy-staging-server.yml services/den/README.md docs/features/onboarding-and-auth.md docs/dev/state-and-config-reference.md services/den/test/staging-owned-server-config.test.ts docs/plans/2026-07-21-email-verification-hard-gate-design.md
git commit -m "docs(auth): require production email activation"
```

### Task 8: Run the complete verification matrix

**Files:**
- Verify only; fix failures in their owning files.

**Step 1: Run DEN tests and build**

```bash
pnpm --dir services/den test
pnpm --dir services/den build
```

Expected: PASS.

**Step 2: Run the real registration acceptance tests**

```bash
pnpm --dir services/den test:email-verification:integration
pnpm --filter @neatech/veslo-e2e test:email-verification:browser
```

Expected: PASS.

**Step 3: Repeat desktop preflight and run the focused Pilot scenario**

Use the mandatory process preflight, then:

```bash
cd packages/e2e
pnpm test:pilot -- --scenario email-verification-handoff
```

Expected: PASS.

**Step 4: Run repository quality gate**

```bash
pnpm check
```

Expected: PASS.

**Step 5: Confirm worktree scope**

```bash
git status --short
git diff --check HEAD~1..HEAD
```

Expected: no uncommitted changes, no whitespace errors, and no secrets.

**Step 6: Final commit only if verification required fixes**

```bash
git add <only-files-fixed-during-verification>
git commit -m "fix(auth): close verification regressions"
```
