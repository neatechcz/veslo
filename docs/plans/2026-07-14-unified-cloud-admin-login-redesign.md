# Unified Cloud, Admin, and Login Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `app.veslo.work/login` the only user-facing Veslo authentication page, add role-aware Admin discovery to Veslo Cloud, and apply the approved paper/ink/cyan visual system to Login, Cloud, and AI Gateway Admin without replacing the existing Den authentication behavior.

**Architecture:** Den remains the auth, email, organization, PKCE, and handoff backend. The Next.js Cloud app owns the canonical login UI and calls Den through the existing same-origin proxy. AI Gateway Admin and desktop auth continue using their existing one-time transactions, but Den-generated authorization URLs point to the canonical Cloud login. Admin remains deployed under the AI Gateway origin and is opened through role-aware Cloud navigation.

**Tech Stack:** Next.js 14, React 18, Tailwind CSS 3 plus existing global CSS, Express, Better Auth, TypeScript, Node test runner with `tsx`, Playwright, Tauri, and Tauri Pilot.

---

## Preconditions and scope protection

- Preserve the user's unrelated `.opencode/opencode.db` deletion and `opencode.jsonc` modification.
- Do not start raw Vite, `pnpm -w dev:ui`, or `@neatech/veslo-ui dev` as proof of desktop behavior.
- A built Next.js server may be used only to test the hosted Cloud/login surface. It is not proof that the Veslo desktop app works.
- Run the desktop process preflight before every Tauri or Tauri Pilot launch.
- Keep `services/den/public-admin` out of scope; it is legacy/inactive.
- Do not change billing semantics: Cloud worker plans remain Polar/user-scoped and Managed AI billing remains Stripe/organization-scoped.

### Task 1: Make Den generate canonical Cloud login URLs

**Files:**
- Create: `services/den/src/http/canonical-login-url.ts`
- Create: `services/den/test/canonical-login-url.test.ts`
- Modify: `services/den/src/env.ts`
- Modify: `services/den/src/http/desktop-auth.ts`
- Modify: `services/den/src/http/desktop-auth-v2.ts`
- Modify: `services/den/src/index.ts`
- Modify: `services/den/test/deployment-endpoints-env.test.ts`

**Step 1: Write the failing canonical URL tests**

Cover production, staging, and local override behavior. The tests must prove that both auth protocol shapes preserve their parameters under `/login` and never use the Den/API origin.

```ts
test("buildCanonicalLoginUrl places legacy desktop auth on the Cloud login", () => {
  assert.equal(
    buildCanonicalLoginUrl("https://app.veslo.work", {
      desktopOnboarding: "1",
      sid: "session_123",
      intent: "signin",
    }),
    "https://app.veslo.work/login?desktopOnboarding=1&sid=session_123&intent=signin",
  )
})

test("buildCanonicalLoginUrl preserves v2 state", () => {
  const result = new URL(buildCanonicalLoginUrl("https://app.staging.veslo.work", {
    desktopOnboarding: "1",
    tid: "dat_123",
    intent: "signup",
    state: "state_123456789012",
  }))
  assert.equal(result.pathname, "/login")
  assert.equal(result.searchParams.get("tid"), "dat_123")
  assert.equal(result.searchParams.get("state"), "state_123456789012")
})
```

Add an env assertion that `parseEnv(...).appBaseUrl` derives from `VESLO_DEPLOYMENT_DOMAIN` independently of `BETTER_AUTH_URL`.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/canonical-login-url.test.ts test/deployment-endpoints-env.test.ts
```

Expected: FAIL because the helper and `appBaseUrl` do not exist and current authorization URLs use the API origin root.

**Step 3: Implement the canonical URL helper and Den wiring**

Implement a pure helper:

```ts
export function buildCanonicalLoginUrl(
  appBaseUrl: string,
  params: Record<string, string | null | undefined>,
) {
  const url = new URL("/login", `${appBaseUrl.replace(/\/+$/, "")}/`)
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }
  return url.toString()
}
```

Then:

- expose `appBaseUrl: endpoints.appBaseUrl` from Den env parsing
- make both `buildDesktopAuthorizeUrl` implementations call this helper
- make `GET /?desktopOnboarding=1` and `/index.html?desktopOnboarding=1` redirect to the canonical Cloud login while preserving supported parameters
- keep ordinary `GET /` as neutral Den service metadata
- do not change handoff, exchange, email, or Better Auth endpoints

**Step 4: Run focused Den tests and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test test/canonical-login-url.test.ts test/deployment-endpoints-env.test.ts test/desktop-auth-v2-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/canonical-login-url.ts services/den/src/env.ts services/den/src/http/desktop-auth.ts services/den/src/http/desktop-auth-v2.ts services/den/src/index.ts services/den/test/canonical-login-url.test.ts services/den/test/deployment-endpoints-env.test.ts
git commit -m "feat(auth): route browser authentication to cloud login"
```

### Task 2: Add tested canonical-auth routing primitives to the Cloud app

**Files:**
- Create: `packages/web/lib/canonical-auth.ts`
- Create: `packages/web/test/canonical-auth.test.ts`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing unit tests for context and return-path parsing**

The pure helper must distinguish normal Cloud, legacy Admin/session, and desktop v2 contexts without trusting arbitrary redirects.

```ts
test("normalizes a safe Cloud return path", () => {
  assert.equal(sanitizeCloudReturnTo("/billing?checkout=success"), "/billing?checkout=success")
  assert.equal(sanitizeCloudReturnTo("https://evil.example/steal"), "/")
  assert.equal(sanitizeCloudReturnTo("//evil.example/steal"), "/")
})

test("recognizes a legacy Admin handoff", () => {
  assert.deepEqual(resolveCanonicalAuthContext(new URLSearchParams({
    desktopOnboarding: "1",
    sid: "session_123",
    intent: "signin",
  })), {
    kind: "admin",
    intent: "signin",
    sessionId: "session_123",
    transactionId: null,
    state: null,
    returnTo: "/",
  })
})

test("recognizes a desktop v2 handoff", () => {
  const context = resolveCanonicalAuthContext(new URLSearchParams({
    desktopOnboarding: "1",
    tid: "dat_123",
    state: "state_123456789012",
    intent: "signup",
  }))
  assert.equal(context.kind, "desktop")
  assert.equal(context.transactionId, "dat_123")
})
```

Also cover malformed/partial contexts and view normalization for `signin`, `signup`, `forgot`, `reset`, and `verify`.

**Step 2: Run the new tests and verify RED**

Add `tsx` to the web package and a script:

```json
"test:unit": "node --import=tsx/esm --test test/*.test.ts"
```

Run:

```bash
pnpm --filter @neatech/veslo-web test:unit
```

Expected: FAIL because the routing module does not exist.

**Step 3: Implement only the pure routing helpers**

Export:

- `sanitizeCloudReturnTo`
- `resolveCanonicalAuthContext`
- `normalizeAuthView`
- `copySupportedAuthParams`
- the `CanonicalAuthContext` and `CanonicalAuthView` types

Do not perform network calls or browser navigation in this module.

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/veslo-web test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/web/lib/canonical-auth.ts packages/web/test/canonical-auth.test.ts packages/web/package.json pnpm-lock.yaml
git commit -m "test(auth): define canonical cloud login routing"
```

### Task 3: Build the canonical login from the working Den behavior

**Files:**
- Create: `packages/web/app/login/page.tsx`
- Create: `packages/web/components/auth/canonical-login.tsx`
- Create: `packages/web/components/auth/auth-api.ts`
- Create: `packages/web/components/auth/auth-types.ts`
- Create: `packages/e2e/specs/unified-login-ui.playwright.spec.ts`
- Modify: `packages/e2e/package.json`
- Modify: `packages/web/app/forgot-password/page.tsx`
- Modify: `packages/web/app/reset-password/page.tsx`
- Modify: `packages/web/app/verify-email/page.tsx`
- Modify: `packages/web/lib/auth-urls.ts`

**Step 1: Write the failing browser E2E for the one-page auth states**

The spec should run against a built Cloud surface and intercept only Den network calls. It must verify user-visible behavior, not component internals:

```ts
test("sign in, forgot password, reset, and verification use one login page", async ({ page }) => {
  await page.goto(`${APP_BASE}/login`)
  await expect(page.getByRole("heading", { name: "Sign in to Veslo" })).toBeVisible()

  await page.getByRole("button", { name: "Forgot password" }).click()
  await expect(page).toHaveURL(/\/login\?view=forgot/)
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible()

  await page.goto(`${APP_BASE}/forgot-password?returnTo=%2Fworkers`)
  await expect(page).toHaveURL(/\/login\?view=forgot/)

  await page.goto(`${APP_BASE}/verify-email?token=verify_123&desktopOnboarding=1&tid=dat_123`)
  await expect(page).toHaveURL(/\/login\?view=verify/)
  await expect(page).toHaveURL(/tid=dat_123/)
})
```

Add cases for email sign-in, email signup, GitHub sign-in, verification resend, reset submission, loading states, and inline backend errors. Assert that the form calls the same endpoint names used by the current working Den page.

**Step 2: Run the focused Playwright spec and verify RED**

Add a dedicated script that uses a built Next server only for this hosted-web test:

```json
"test:unified-login-web": "playwright test ./specs/unified-login-ui.playwright.spec.ts"
```

Run:

```bash
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-e2e test:unified-login-web
```

Expected: FAIL because `/login` and the canonical views do not exist.

**Step 3: Extract the existing behavior into a focused auth API module**

Port behavior from the working Den page and current Cloud form without changing endpoints:

```ts
export const authApi = {
  signInEmail: (email: string, password: string) =>
    requestDen("/api/auth/sign-in/email", { method: "POST", body: { email, password } }),
  signUpEmail: (email: string, password: string, name: string, callbackURL: string) =>
    requestDen("/api/auth/sign-up/email", { method: "POST", body: { email, password, name, callbackURL } }),
  requestPasswordReset: (email: string, redirectTo: string) =>
    requestDen("/api/auth/forget-password", { method: "POST", body: { email, redirectTo } }),
  resetPassword: (token: string, newPassword: string) =>
    requestDen("/api/auth/reset-password", { method: "POST", body: { token, newPassword } }),
  resendVerification: (email: string, callbackURL: string) =>
    requestDen("/api/auth/send-verification-email", { method: "POST", body: { email, callbackURL } }),
}
```

Before finalizing names and payloads, copy the exact currently working request shapes from the Den page and Cloud implementation. Do not invent a second mail path.

**Step 4: Implement the canonical login component and compatibility redirects**

- render all auth views from one client component under `/login`
- preserve non-secret form state while switching sign-in/signup/forgot views
- keep reset and verification tokens out of visible text and remove consumed token parameters from browser history
- preserve transaction parameters during reset/verification callbacks
- make the three old auth pages redirect into `/login` rather than render their own UI
- use the existing same-origin `/api/den` proxy
- keep GitHub auth callback state and signup analytics behavior

**Step 5: Run unit, E2E, and build checks**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-e2e test:unified-login-web
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/web/app/login packages/web/components/auth packages/web/app/forgot-password/page.tsx packages/web/app/reset-password/page.tsx packages/web/app/verify-email/page.tsx packages/web/lib/auth-urls.ts packages/e2e/specs/unified-login-ui.playwright.spec.ts packages/e2e/package.json
git commit -m "feat(auth): add canonical Veslo login page"
```

### Task 4: Complete Admin and desktop transactions from the canonical page

**Files:**
- Modify: `packages/web/components/auth/canonical-login.tsx`
- Modify: `packages/web/components/auth/auth-api.ts`
- Modify: `packages/web/test/canonical-auth.test.ts`
- Modify: `packages/web/scripts/desktop-auth-mode.mjs`
- Modify: `packages/web/scripts/auth-email-flows.mjs`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/den/test/desktop-auth-onboarding-page.test.ts`
- Delete: `services/den/public/index.html`

**Step 1: Extend failing tests for both handoff protocols**

Browser behavior must be:

```ts
// Legacy/Admin session flow
await authApi.completeLegacyHandoff({ sessionId, orgId })
// POST /v1/desktop-auth/handoff with { sessionId }, then navigate to payload.redirectUrl

// Desktop v2 flow
await authApi.authorizeDesktopTransaction({ transactionId, state, orgId })
// POST /v1/desktop-auth-v2/authorize with JSON transport, then navigate to payload.redirectUrl
```

Tests must prove:

- `sid` uses the server-provided Admin redirect rather than constructing `veslo://`
- `tid` plus `state` uses desktop-auth-v2 authorize
- organization selection is sent through the existing organization header
- an existing authenticated session completes without showing credentials
- verification callbacks keep transaction parameters
- Den no longer serves HTML login content
- AI Gateway's unauthenticated redirect target is `app.../login`

**Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts
```

Expected: FAIL because the Cloud page currently constructs its own deep link, ignores legacy `sessionId` on handoff, and Den still ships the old login HTML.

**Step 3: Implement context-specific completion on the one login page**

- load the authenticated session and organizations once
- show organization selection only when a pending transaction needs a choice and multiple valid memberships exist
- for legacy/Admin sessions, pass `sessionId` to the existing handoff and follow `redirectUrl`
- for desktop v2 transactions, pass `transactionId` and `state` to authorize with `x-veslo-desktop-auth-transport: json` and follow `redirectUrl`
- show `Open Veslo` and `Download Veslo` after initiating the desktop deep link
- keep transaction failures inline with restart actions
- remove the old Den HTML only after the canonical page covers every existing state
- replace obsolete source tests with assertions against the canonical Cloud implementation and Den redirect

**Step 4: Run focused tests and verify GREEN**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
pnpm --filter @neatech/den exec tsx --test test/desktop-auth-onboarding-page.test.ts test/desktop-auth-v2-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/web/components/auth packages/web/test packages/web/scripts services/ai-gateway/test/admin-ui.test.ts services/den/test/desktop-auth-onboarding-page.test.ts services/den/public/index.html
git commit -m "feat(auth): unify admin and desktop browser handoff"
```

### Task 5: Add role-aware Admin discovery and remove Cloud login duplication

**Files:**
- Create: `packages/web/lib/admin-navigation.ts`
- Create: `packages/web/test/admin-navigation.test.ts`
- Create: `packages/e2e/specs/cloud-admin-discovery.playwright.spec.ts`
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/app/page.tsx`
- Modify: `packages/web/lib/deployment-endpoints.ts`
- Modify: `packages/e2e/package.json`

**Step 1: Write failing role-policy tests**

```ts
test("members do not receive Admin entries", () => {
  assert.deepEqual(resolveAdminNavigation({ platformAdmin: false, orgRole: "member" }), [])
})

test("organization admins receive organization management only", () => {
  assert.deepEqual(resolveAdminNavigation({ platformAdmin: false, orgRole: "organization_admin" }), [
    { label: "Manage organization", path: "/admin/organization" },
  ])
})

test("owners are treated as organization admins", () => {
  assert.equal(resolveAdminNavigation({ platformAdmin: false, orgRole: "owner" }).length, 1)
})

test("platform admins receive organization and platform entries", () => {
  assert.deepEqual(resolveAdminNavigation({ platformAdmin: true, orgRole: "owner" }).map((item) => item.label), [
    "Manage organization",
    "Open platform admin",
  ])
})
```

The browser E2E must render each `/v1/me` and `/v1/orgs` role response and assert visible navigation.

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/cloud-admin-discovery.playwright.spec.ts
```

Expected: FAIL because Cloud has no Admin entries and still embeds authentication.

**Step 3: Implement role-aware navigation**

- resolve the canonical Admin origin from the AI Gateway service origin, not `admin.veslo.work`
- show `Manage organization` for `owner` and `organization_admin`
- show `Open platform admin` only for platform admins
- make the links ordinary browser navigations so AI Gateway can run its protected auth transaction
- rename `Billing` to `Cloud worker plan`
- remove inactive Settings and Help Center entries
- redirect unauthenticated Cloud access to `/login?returnTo=/`
- remove sign-in/signup forms and auth-mode state from `cloud-control.tsx`
- keep session loading, organization selection, sign-out, workers, and Polar billing intact

**Step 4: Run unit and browser E2E checks**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/cloud-admin-discovery.playwright.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/web/lib/admin-navigation.ts packages/web/test/admin-navigation.test.ts packages/web/components/cloud-control.tsx packages/web/app/page.tsx packages/web/lib/deployment-endpoints.ts packages/e2e/specs/cloud-admin-discovery.playwright.spec.ts packages/e2e/package.json
git commit -m "feat(cloud): expose role-aware organization admin navigation"
```

### Task 6: Apply the approved visual system to Login and Cloud

**Files:**
- Create: `packages/web/test/visual-contract.test.ts`
- Modify: `packages/web/app/globals.css`
- Modify: `packages/web/app/layout.tsx`
- Modify: `packages/web/app/page.tsx`
- Modify: `packages/web/components/auth/canonical-login.tsx`
- Modify: `packages/web/components/cloud-control.tsx`

**Step 1: Write a failing visual contract test**

The contract should assert the approved tokens and prohibit the old generic patterns:

```ts
test("Cloud and login use the approved light Veslo tokens", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  assert.match(css, /--veslo-bg:\s*#f6f8fb/i)
  assert.match(css, /--veslo-ink:\s*#0a0e14/i)
  assert.match(css, /--veslo-accent:\s*#00a8c8/i)
  assert.match(css, /DM Sans/)
  assert.match(css, /DM Mono/)
  assert.doesNotMatch(css, /backdrop-filter|linear-gradient|ow-blob/i)
})
```

Add browser assertions for visible focus, mobile touch height, empty/loading/error states, and the absence of dead navigation.

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-e2e test:unified-login-web
```

Expected: FAIL on the current indigo gradient, glass surfaces, blobs, large radii, and old fonts.

**Step 3: Implement the shared Web visual system**

- load DM Sans and DM Mono through the Next layout
- define paper, panel, sunk, line, ink, cyan, semantic, font, radius, and shadow tokens
- remove ambient blobs, gradients, blur, glass, pill controls, and 18–32px dashboard radii
- give login an asymmetric context/form layout with a single compact auth surface
- make Cloud navigation and panels use the same 4px/hairline grammar as Admin
- ensure controls are at least 40px high on narrow screens
- preserve all worker details, access actions, activity, billing, invoices, loading, empty, and error states
- use tabular/mono treatment for worker IDs, timestamps, tokens, and monetary data
- retain accessible focus rings and reduced-motion behavior

**Step 4: Run visual contract, browser E2E, and build checks**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/veslo-e2e test:unified-login-web
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/cloud-admin-discovery.playwright.spec.ts
```

Expected: PASS with no browser console errors.

**Step 5: Commit**

```bash
git add packages/web/app/globals.css packages/web/app/layout.tsx packages/web/app/page.tsx packages/web/components/auth/canonical-login.tsx packages/web/components/cloud-control.tsx packages/web/test/visual-contract.test.ts
git commit -m "feat(web): redesign Veslo login and cloud control"
```

### Task 7: Apply the approved Admin visual redesign

**Files:**
- Create: `services/ai-gateway/test/admin-visual-contract.test.ts`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/public-admin/index.html`

**Step 1: Write the failing Admin visual contract test**

Assert the exact approved font link and tokens from the approved Admin design. Prohibit gradients, backdrop blur, glow shadows, and pill radii.

```ts
test("Admin uses the approved paper ink cyan visual system", () => {
  assert.match(html, /DM\+Sans:opsz,wght@9\.\.40,200\.\.500/)
  assert.match(html, /DM\+Mono:wght@400;500/)
  assert.match(css, /--bg:\s*#f6f8fb/i)
  assert.match(css, /--text:\s*#0a0e14/i)
  assert.match(css, /--accent:\s*#00A8C8/i)
  assert.doesNotMatch(css, /backdrop-filter|linear-gradient|999px/i)
})
```

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-visual-contract.test.ts
```

Expected: FAIL against the current Admin stylesheet.

**Step 3: Implement the approved CSS-only reskin**

Follow the approved Admin design exactly:

- keep existing markup structure, class names, JavaScript, page routing, dialogs, and breakpoints
- replace fonts and tokens
- restyle sidebar, topbar, buttons, chips, metrics, inputs, segments, tables, dialogs, charts, and connection status
- keep Organization Admin and Platform Admin capability visibility unchanged
- do not change Admin copy or information architecture in this task

**Step 4: Run focused Admin tests**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-visual-contract.test.ts test/admin-ui.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin/app.css services/ai-gateway/public-admin/index.html services/ai-gateway/test/admin-visual-contract.test.ts
git commit -m "feat(admin): apply approved Veslo visual redesign"
```

### Task 8: Add the integrated browser auth and role E2E gate

**Files:**
- Create: `packages/e2e/specs/unified-cloud-admin-auth.playwright.spec.ts`
- Modify: `packages/e2e/package.json`
- Modify: `packages/e2e/specs/den-admin-billing-integrated.playwright.spec.ts`
- Modify: `services/den/test/desktop-auth-v2-contract.test.ts`

**Step 1: Write the failing integrated flow**

Against the Docker-backed/local integrated environment, verify:

1. unauthenticated AI Gateway Admin redirects to `app.../login`
2. email sign-in uses the existing Den auth backend
3. the login page completes the transaction and returns to the original Admin path
4. an organization admin sees only Organization and Users
5. a platform admin retains Organization, Users, Credentials, Usage, Alerts, and Audit
6. Cloud shows the correct role-aware Admin entries
7. the legacy Den auth URL redirects to Cloud login
8. external `returnTo` values are discarded

Use real route handlers and local test accounts. Do not add a second test-only login implementation.

**Step 2: Run and verify RED**

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/unified-cloud-admin-auth.playwright.spec.ts
```

Expected: FAIL until the three services are wired through the canonical page.

**Step 3: Update the existing integrated expectations and minimal harness configuration**

- update old assertions that expect a Den-root login
- preserve the current local account/bootstrap setup
- add only the app and AI Gateway bases required for the real redirect chain
- keep screenshots for login, Cloud, organization Admin, and platform Admin
- fail on browser console errors outside explicitly documented optional endpoints

**Step 4: Run and verify GREEN**

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/unified-cloud-admin-auth.playwright.spec.ts
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-integrated
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/unified-cloud-admin-auth.playwright.spec.ts packages/e2e/specs/den-admin-billing-integrated.playwright.spec.ts packages/e2e/package.json services/den/test/desktop-auth-v2-contract.test.ts
git commit -m "test(auth): cover unified cloud admin browser flow"
```

### Task 9: Verify the real desktop handoff with Tauri Pilot

**Files:**
- Create: `packages/e2e/specs/unified-login-handoff.pilot.ts`
- Modify: `packages/e2e/package.json`
- Modify: `packages/e2e/helpers/pilot-runner.ts` only if the existing fixture cannot expose the desktop-auth start and callback evidence
- Modify: `packages/app/src/app/tests/lib/den-auth.test.ts`

**Step 1: Add a failing desktop contract assertion**

Update the existing Den-auth test fixture so the returned authorization URL is under `https://app.veslo.work/login`, then assert that the desktop opens it unchanged and still accepts the existing `veslo://auth-complete` callback.

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- --test-name-pattern "desktop auth"
```

Expected: FAIL on expectations that still name the API-origin login.

**Step 2: Add the Tauri Pilot scenario**

The scenario must drive the real desktop shell and assert:

- starting sign-in calls the desktop-auth start endpoint
- the returned authorization URL uses `app.../login`
- the native browser-open boundary receives that URL
- a valid one-time callback through the existing deep-link boundary signs the desktop into the selected organization
- duplicate callbacks remain idempotent

Use the existing isolated E2E profile and a Den-compatible local fixture. Do not replace the Tauri runtime with a browser-only or raw OpenCode test.

**Step 3: Run mandatory desktop preflight**

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: the final check is empty.

**Step 4: Build and run the focused Pilot scenario**

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
cd ../e2e
pnpm test:pilot -- --scenario unified-login-handoff
```

Expected: PASS with the real Tauri binary.

If an unrelated Veslo process cannot be safely terminated, follow the repository's 10-minute retry automation rule rather than substituting a web-only result.

**Step 5: Commit**

```bash
git add packages/e2e/specs/unified-login-handoff.pilot.ts packages/e2e/package.json packages/e2e/helpers/pilot-runner.ts packages/app/src/app/tests/lib/den-auth.test.ts
git commit -m "test(desktop): verify canonical login handoff in Tauri"
```

### Task 10: Update canonical documentation

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `docs/dev/app-map.md`
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `packages/web/README.md`

**Step 1: Write the documentation assertions before editing docs**

Extend or add the smallest existing documentation/source contract test to require:

- `app.veslo.work/login` as the canonical user-facing login
- Den described as the auth backend
- Admin discovery from Cloud
- organization-admin and platform-admin scope distinction
- Cloud worker plan billing distinguished from Managed AI billing

Run the relevant source test and verify it fails on the old documentation.

**Step 2: Update canonical docs**

Document the final routed flows and remove claims that Den root renders the browser login. Keep deployment-state language precise: source changes are not described as deployed until the deployment workflow succeeds.

**Step 3: Run documentation/source checks**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/veslo-web test:auth-email-flows
git diff --check
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/features/onboarding-and-auth.md docs/dev/cloud-deployments.md docs/dev/app-map.md docs/admin-managed-ai-access.md packages/web/README.md
git commit -m "docs: describe unified Veslo authentication surface"
```

### Task 11: Final verification and visual QA

**Files:**
- No production files unless verification exposes a defect; any fix must start with a failing regression test.

**Step 1: Run all affected unit and service tests**

```bash
pnpm --filter @neatech/veslo-web test:unit
pnpm --filter @neatech/veslo-web test:font-source
pnpm --filter @neatech/veslo-web test:desktop-auth-mode
pnpm --filter @neatech/veslo-web test:auth-email-flows
pnpm --filter @neatech/den test
pnpm --filter @neatech/ai-gateway test
```

Expected: all pass with zero failures.

**Step 2: Build every changed deployable package**

```bash
pnpm --filter @neatech/veslo-web build
pnpm --filter @neatech/den build
pnpm --filter @neatech/ai-gateway build
```

Expected: all exit 0.

**Step 3: Run browser E2E gates**

```bash
pnpm --filter @neatech/veslo-e2e test:unified-login-web
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/cloud-admin-discovery.playwright.spec.ts
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/unified-cloud-admin-auth.playwright.spec.ts
```

Expected: all pass with no unexpected console errors.

**Step 4: Perform visual QA**

Inspect and capture:

- Login: sign-in, signup, forgot, reset, verify, error, redirecting, desktop fallback
- Cloud: Workers and Cloud worker plan, empty/loading/error/populated states
- Admin: Organization and Users as organization admin; all permitted pages as platform admin
- viewport widths around 1440px, 1180px, 760px, and 390px

Reject any gradients, glass blur, oversized pills, dead links, missing focus rings, or mobile overflow.

**Step 5: Re-run the real Tauri Pilot gate**

Repeat the mandatory process preflight, then run:

```bash
cd packages/e2e
pnpm test:pilot -- --scenario unified-login-handoff
```

Expected: PASS.

**Step 6: Check repository scope and commits**

```bash
git status --short
git diff --check
git log --oneline --decorate -12
```

Expected:

- only intentional implementation changes remain
- the user's pre-existing `.opencode/opencode.db` and `opencode.jsonc` changes are untouched
- no secrets, generated browser profiles, screenshots, or local auth artifacts are staged
