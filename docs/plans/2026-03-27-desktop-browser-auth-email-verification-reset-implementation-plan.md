# Desktop Browser Auth Email Verification And Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend Veslo desktop's existing Den-hosted browser sign-in flow so it supports email verification, resend verification, forgot-password, and reset-password without depending on `packages/web`.

**Architecture:** Keep desktop auth launch, polling, and handoff in `packages/app`, but move the missing auth UX into the Den-hosted onboarding page at `services/den/public/index.html`. Use `GET /v1/me` as the source of truth for `emailVerified`, reuse Better Auth's native endpoints for resend and password reset, and keep verified-email enforcement on the Den server side where it already exists.

**Tech Stack:** Express, Better Auth, TypeScript, static HTML/JS in `services/den/public`, SolidJS in `packages/app`, Node test runner, `tsx --test`, pnpm, Docker, Tauri, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` before each behavior change.
- Do not run `packages/web` as the validation surface for this feature.
- Runtime verification must use:
  - `packaging/docker/dev-up.sh`
  - `pnpm --filter @neatech/veslo dev`
  - Chrome MCP
  - screenshots saved in-repo

### Task 1: Add failing Den onboarding source tests for verification and reset flows

**Files:**
- Modify: `services/den/test/desktop-auth-onboarding-page.test.ts`
- Test: `services/den/test/desktop-auth-onboarding-page.test.ts`

**Step 1: Add a failing forgot/reset contract**

Extend `services/den/test/desktop-auth-onboarding-page.test.ts` with assertions like:

```ts
test("desktop onboarding page exposes forgot-password and reset-password browser flows", () => {
  assert.equal(onboardingPage.includes("Forgot password?"), true);
  assert.equal(onboardingPage.includes("/api/auth/request-password-reset"), true);
  assert.equal(onboardingPage.includes("/api/auth/reset-password"), true);
  assert.equal(onboardingPage.includes('search.get("token")'), true);
});
```

**Step 2: Add a failing verification/resend contract**

Add assertions like:

```ts
test("desktop onboarding page exposes verification and resend affordances", () => {
  assert.equal(onboardingPage.includes("/api/auth/send-verification-email"), true);
  assert.equal(onboardingPage.includes("emailVerified"), true);
  assert.equal(onboardingPage.includes('buildDesktopOnboardingUrl("verify-email")'), true);
});
```

**Step 3: Add a failing Veslo branding contract**

Add assertions like:

```ts
test("desktop onboarding page uses Veslo auth copy", () => {
  assert.equal(onboardingPage.includes("Sign in to Veslo"), true);
  assert.equal(onboardingPage.includes("Openwork"), false);
});
```

**Step 4: Run the targeted test to verify failure**

Run:

```bash
pnpm --dir services/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: FAIL because the Den-hosted onboarding page does not yet contain forgot/reset/resend/verification behavior or Veslo branding.

**Step 5: Commit the failing test**

```bash
git add services/den/test/desktop-auth-onboarding-page.test.ts
git commit -m "test: add den desktop auth email flow spec"
```

### Task 2: Implement the Den-hosted browser auth flow for verification and password reset

**Files:**
- Modify: `services/den/public/index.html`
- Modify: `services/den/README.md`
- Test: `services/den/test/desktop-auth-onboarding-page.test.ts`

**Step 1: Add a reusable desktop onboarding URL helper**

In `services/den/public/index.html`, add a helper shaped like:

```js
function buildDesktopOnboardingUrl(view, extras = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("desktopOnboarding", "1");
  if (onboardingTransactionId) url.searchParams.set("tid", onboardingTransactionId);
  if (onboardingState) url.searchParams.set("state", onboardingState);
  if (requestedIntent) url.searchParams.set("intent", requestedIntent);
  url.searchParams.set("view", view);
  for (const [key, value] of Object.entries(extras)) {
    if (value == null || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
```

Use `view` values for:

- `auth`
- `forgot-password`
- `reset-password`
- `verify-email`
- `verify-required`

**Step 2: Expand the Den-hosted HTML states**

Update `services/den/public/index.html` so the desktop onboarding view includes:

- the auth form
- a forgot-password request form
- a reset-password form
- a verification-required state with resend + continue buttons
- a verify-email result state

Keep the existing success and busy cards for the handoff phase.

**Step 3: Wire sign-in/sign-up to inspect `emailVerified` before handoff**

After successful auth:

```js
const me = await fetch("/v1/me", { method: "GET", credentials: "include" });
const mePayload = await me.json().catch(() => null);
const emailVerified = mePayload?.user?.emailVerified === true;

if (!emailVerified) {
  showVerificationRequiredState(mePayload?.user?.email ?? emailInput.value, bearerToken);
  return;
}

await doHandoff();
```

The verification-required state should:

- explain that cloud-gated actions still require email verification
- expose resend verification
- allow continuing to Veslo immediately

**Step 4: Add resend verification behavior**

Implement a resend action using Better Auth's existing endpoint:

```js
await fetch("/api/auth/send-verification-email", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email,
    callbackURL: buildDesktopOnboardingUrl("verify-email"),
  }),
});
```

**Step 5: Add forgot-password and reset-password behavior**

Forgot-password should:

```js
await fetch("/api/auth/request-password-reset", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: trimmedEmail,
    redirectTo: buildDesktopOnboardingUrl("reset-password"),
  }),
});
```

Reset-password should:

```js
await fetch("/api/auth/reset-password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token,
    newPassword,
  }),
});
```

Use `window.location.search` to read:

- `token`
- `error`
- `view`

and render the correct state without relying on `packages/web`.

**Step 6: Rebrand the Den-hosted copy to Veslo**

Update visible strings in `services/den/public/index.html` from `Openwork` to `Veslo`, including:

- page headings
- subtitles
- success state copy
- button text where appropriate

**Step 7: Update Den docs**

Document in `services/den/README.md` that the root onboarding page now supports:

- desktop browser sign-in/sign-up
- resend verification
- forgot-password request
- reset-password completion

**Step 8: Run targeted checks**

Run:

```bash
pnpm --dir services/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
pnpm --dir services/den build
```

Expected: both PASS.

**Step 9: Commit the implementation**

```bash
git add services/den/public/index.html services/den/README.md
git commit -m "feat: extend den desktop auth with verification and reset flows"
```

### Task 3: Add a failing desktop onboarding branding/assertion guard

**Files:**
- Modify: `packages/app/scripts/desktop-auth-onboarding.mjs`
- Test: `packages/app/scripts/desktop-auth-onboarding.mjs`

**Step 1: Add failing desktop onboarding copy assertions**

Extend `packages/app/scripts/desktop-auth-onboarding.mjs` with assertions like:

```js
const onboarding = readFileSync(new URL("../src/app/pages/onboarding.tsx", import.meta.url), "utf8");

assert.equal(
  onboarding.includes("Sign in to Veslo"),
  true,
  "desktop onboarding must brand browser auth entry as Veslo"
);

assert.equal(
  onboarding.includes("Sign in to Openwork"),
  false,
  "desktop onboarding must not keep the old Openwork auth heading"
);
```

**Step 2: Run the guard to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node scripts/desktop-auth-onboarding.mjs
```

Expected: FAIL because the onboarding screen still says `Openwork`.

**Step 3: Commit the failing assertion**

```bash
git add packages/app/scripts/desktop-auth-onboarding.mjs
git commit -m "test: add desktop auth onboarding branding guard"
```

### Task 4: Update desktop onboarding copy to match the Den-hosted auth flow

**Files:**
- Modify: `packages/app/src/app/pages/onboarding.tsx`
- Test: `packages/app/scripts/desktop-auth-onboarding.mjs`

**Step 1: Update auth-step copy**

In `packages/app/src/app/pages/onboarding.tsx`, change the auth screen copy to Veslo-branded text, for example:

```tsx
<h2 class="text-2xl font-bold tracking-tight">Sign in to Veslo</h2>
<p class="text-gray-11 text-sm leading-relaxed">
  Sign in with your account to continue setup. Email verification and password recovery happen in the browser.
</p>
```

Keep the existing `Sign in with Browser` CTA unless the new copy suggests a better but equally concise label.

**Step 2: Run the desktop auth guard**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node scripts/desktop-auth-onboarding.mjs
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui build
```

Expected: all PASS.

**Step 3: Commit the desktop copy update**

```bash
git add packages/app/src/app/pages/onboarding.tsx
git commit -m "feat: align desktop onboarding auth copy with veslo browser flow"
```

### Task 5: Full verification, runtime validation, and evidence capture

**Files:**
- Create: `packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset/desktop-auth-signin.png`
- Create: `packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset/desktop-auth-verification.png`
- Create: `packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset/desktop-auth-forgot-password.png`
- Create: `packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset/desktop-auth-reset-password.png`

**Step 1: Run automated verification**

Run:

```bash
pnpm --dir services/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
pnpm --dir services/den test
pnpm --dir services/den build
pnpm --filter @neatech/veslo-ui exec node scripts/desktop-auth-onboarding.mjs
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui build
```

Expected: all PASS.

**Step 2: Start the required runtime**

Run from repo root:

```bash
packaging/docker/dev-up.sh
pnpm --filter @neatech/veslo dev
```

Expected: Docker stack prints real URLs, and Tauri desktop launches against the official runtime path.

**Step 3: Validate the real desktop browser auth flow**

Use Chrome MCP to verify:

1. Launch desktop onboarding and trigger `Sign in with Browser`.
2. Confirm the Den-hosted browser page is Veslo-branded.
3. Confirm sign-up/sign-in can surface the verification-required state when `emailVerified` is false.
4. Trigger resend verification.
5. Trigger forgot-password request and confirm the neutral success state.
6. Open a reset-password link and complete the reset flow.
7. Open a verify-email link and confirm the result state.
8. Return to desktop and confirm handoff still succeeds.

**Step 4: Capture screenshots in-repo**

Save screenshots to:

```text
packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset/
```

Minimum captures:

- desktop onboarding auth entry
- Den-hosted verification-required state
- forgot-password state
- reset-password state

**Step 5: Final commit**

```bash
git add packages/app/pr/2026-03-27-desktop-browser-auth-email-verification-reset
git commit -m "chore: add desktop auth verification reset evidence"
```

If Docker, Tauri, or Chrome MCP cannot run, stop and document:

- which exact step failed
- why it failed
- which automated checks passed
- the exact commands the reviewer should run to complete the end-to-end gate
