# Desktop Den Auth Handoff Design

## Goal

Reuse the existing Den cloud identity and organization flow for Veslo desktop onboarding, while keeping task execution local. The desktop app should open the existing web sign-in flow, receive a secure one-time handoff code, exchange it with Den, and then continue into local folder and local worker onboarding.

## Current State

- `services/den` already provides real user auth, session lookup, organization resolution, and default-org fallback.
- `packages/web` already uses Den for sign-in, org selection, and worker management.
- `packages/app` does not use Den identity today. It runs in `local_sync` mode and only consumes remote worker/server tokens or env-driven server settings.
- Desktop deep links currently support `connect-remote` and shared bundle imports, not identity handoff.

## Approved Design

### 1. Behavior Contract

On first run, Veslo desktop should not send the user directly into local worker creation before identity exists.

Instead:

1. Desktop shows `Sign in to Veslo`.
2. Clicking it opens the existing web auth flow.
3. The web flow handles sign in or sign up and active organization resolution.
4. Control returns to desktop.
5. Desktop continues with local folder selection and local worker creation.

The web flow must stop after identity and organization are established. Desktop remains responsible for local execution onboarding.

### 2. Secure Browser Handoff

The desktop onboarding action is labeled `Sign in to Veslo`.

The existing web app is opened in a desktop-onboarding mode. After the user signs in and the active org is resolved, the web app must deep-link back to desktop with a one-time code only:

- `veslo://auth-complete?code=...`

The web app must not place the real Den bearer token or Better Auth session token in the deep link URL.

Desktop exchanges the one-time code with Den over HTTPS and receives:

- Den API base URL
- Den bearer token suitable for desktop account/org API calls
- active org id
- basic user and org summary for boot UX

### 3. Minimal Integration Map

#### Den (`services/den`)

Add a small desktop auth handoff surface:

- `POST /v1/desktop-auth/handoff`
  - requires an authenticated browser session
  - accepts or resolves the active org id
  - creates a one-time, short-lived handoff code
- `POST /v1/desktop-auth/exchange`
  - accepts the code once
  - returns desktop auth state

Handoff codes should be stored in a DB-backed table with expiry and single-use enforcement.

#### Web (`packages/web`)

Add a desktop-onboarding mode to the existing auth flow:

- authenticate user
- resolve or confirm active organization
- request a one-time handoff code from Den
- deep-link back to desktop with `veslo://auth-complete?code=...`

This path must not create worker tokens and must not build `connect-remote` URLs.

#### Desktop (`packages/app`)

Add a second deep-link flow alongside `connect-remote`:

- parse `auth-complete`
- exchange the code with Den
- persist desktop cloud auth state
- continue into local folder and local worker onboarding

Desktop should stay in local execution mode. This change must not switch the runtime to `cloud_only`.

### 4. Boot, Recovery, And Dev Deployment

Desktop boot behavior:

- if no stored cloud auth state exists, start onboarding with `Sign in to Veslo`
- if cloud auth state exists, validate it against Den using `/v1/me` and `/v1/orgs`
- if validation succeeds, continue to local onboarding
- if validation fails with `401` or invalid org access, clear stored cloud auth state and return to `Sign in to Veslo`

Deployment behavior:

- the new Den handoff endpoints must be deployed to the existing Render development service
- this already aligns with `.github/workflows/deploy-den.yml`, which deploys `services/den` on push to `dev`
- the web desktop-onboarding mode must run against that same Den deployment
- desktop dev/testing must target that web deployment for the `Sign in to Veslo` action

End-to-end dev gate:

1. launch fresh desktop app
2. click `Sign in to Veslo`
3. authenticate in browser
4. deep link returns `auth-complete` code
5. desktop exchanges code
6. app continues to local folder selection
7. local worker/session setup succeeds
8. restart preserves sign-in until Den invalidates it

### 5. Stored State, Errors, And Test Scope

Stored desktop cloud auth state must be separate from existing `veslo.server.*` settings. That existing state is for worker/server connectivity, not signed-in identity.

Desktop auth state should contain:

- Den base URL
- Den bearer token
- active org id
- cached user summary for boot UX only

Failure behavior:

- if browser auth completes but desktop does not receive the deep link, the user can retry validation or reopen the browser flow
- if one-time code exchange fails, desktop shows retry UI and discards the failed code
- if stored auth becomes invalid later, desktop clears it and returns to `Sign in to Veslo`
- if org resolution becomes ambiguous, desktop sends the user back through the web flow instead of implementing local org selection logic

Required test coverage:

- Den tests for handoff creation, expiry, single-use exchange, and org-scoped payloads
- web tests or static guard scripts for desktop-onboarding mode and `auth-complete` link generation
- desktop tests for first-run sign-in gating, successful exchange, invalid stored auth fallback, and preservation of `connect-remote`

## Concrete Code Areas

Primary code areas for implementation:

- `services/den/src/auth.ts`
- `services/den/src/index.ts`
- `services/den/src/http/org-auth.ts`
- `services/den/src/http/workers.ts`
- `packages/web/components/cloud-control.tsx`
- `packages/web/app/api/den/[...path]/route.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/context/workspace.ts`
- `packages/app/src/app/pages/onboarding.tsx`
- `packages/app/src/app/lib/veslo-server.ts`

## Key Constraint

This design intentionally avoids building native desktop auth UI or a second auth system. Den remains the account and organization authority, web remains the auth UI, and desktop stays focused on local execution after identity is established.
