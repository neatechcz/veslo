# Desktop Browser Auth Email Verification And Reset Design

## Goal

Extend Veslo desktop's existing browser-based sign-in flow so users can verify their email, resend verification, and reset a forgotten password without leaving the official desktop runtime path.

## Current State

- Desktop onboarding already blocks on Den auth before the app proceeds into local workspace setup.
- Desktop launches browser auth through `startDesktopBrowserAuth(...)` in `packages/app/src/app/lib/den-auth.ts`.
- The desktop browser auth flow does not open `packages/web`; it opens the Den-hosted onboarding page generated from `services/den/src/http/desktop-auth-v2.ts` and rendered by `services/den/public/index.html`.
- The March 26 email verification and password reset work was implemented in `packages/web`, but that UI is not the one used by the official Tauri + Docker desktop path.
- Den already owns the real auth system, Better Auth email verification, password reset email delivery, and verified-email gating for cloud mutations.

## Approved Option

### Option 1: Extend the Existing Den-Hosted Browser Onboarding

This is the approved approach.

The existing browser auth page served by Den will be upgraded to support:

- sign-up with a visible email verification state
- resend verification email
- forgot-password entry from sign-in
- reset-password submission flow
- verify-email result handling

Desktop keeps its current responsibility:

- open the browser auth flow
- wait for browser auth completion
- exchange the handoff code
- continue local onboarding

This keeps the official runtime path honest and avoids forcing desktop auth to depend on `packages/web`.

## Rejected Options

### Reuse `packages/web` For Desktop Auth

This would reuse the richer auth UI already built, but it would keep the runtime mismatch in place because the sanctioned desktop/Docker path does not serve that app today.

### Build A Shared Auth Surface For Both Web And Desktop

This is cleaner long-term, but it is a larger refactor than needed to finish the auth verification/reset feature inside the current desktop flow.

## Behavior Contract

Desktop auth should behave like this:

1. Veslo desktop shows the existing sign-in onboarding step.
2. Clicking browser sign-in opens the Den-hosted auth page.
3. The user can sign in or create an account there.
4. New accounts show a persistent verify-email state with a resend action.
5. Sign-in mode exposes a forgot-password entry.
6. Reset-password and verify-email result states are handled inside the same Den-hosted browser flow.
7. After successful auth, desktop still completes the existing handoff flow and continues onboarding.
8. Unverified users may sign in, but Den continues to block already-gated cloud actions until verification is complete.

## Runtime Ownership

### Den (`services/den`)

Owns:

- Better Auth email verification and reset endpoints
- email delivery wiring
- verified-email enforcement
- desktop auth transaction and handoff endpoints
- the browser onboarding HTML/JS that desktop launches

New work stays primarily in:

- `services/den/public/index.html`
- `services/den/test/desktop-auth-onboarding-page.test.ts`
- additional Den test files or source assertion scripts as needed

### Desktop (`packages/app`)

Keeps:

- browser launch
- polling status for desktop auth
- exchanging handoff code
- boot gating on valid Den auth

Desktop changes should stay minimal and mostly limited to copy and any browser-entry details needed to match the upgraded Den-hosted auth page.

Relevant files:

- `packages/app/src/app/pages/onboarding.tsx`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/lib/den-auth.ts`
- `packages/app/src/app/lib/den-auth.test.ts`

## UX Scope

The Den-hosted onboarding page should remain lightweight and focused on desktop auth completion, not grow into the entire `packages/web` cloud control surface.

Allowed UX additions:

- verify-email banner/state
- resend verification action
- forgot-password link
- reset-password form
- verification result messaging
- clearer Veslo-branded copy

Out of scope:

- migrating the full `packages/web` worker/billing/org management UI into the Den-hosted page
- changing the desktop auth token exchange contract unless a real gap is discovered during TDD

## Error Handling

- Failed sign-in/sign-up stays inline on the Den-hosted page.
- Failed resend verification stays inline and must not break the current auth state.
- Forgot-password request should show a neutral success message that does not reveal whether the email exists.
- Reset-password failures should keep the user on the reset state with actionable guidance.
- Verification result view should distinguish success from expired/invalid links and offer resend guidance.
- Desktop handoff failure behavior remains unchanged: browser auth can succeed while desktop exchange fails, and desktop must continue showing retryable onboarding errors.

## Testing Gate

Implementation must follow TDD and prove the desktop runtime path, not only `packages/web`.

Required verification:

- Den tests
- source or behavior tests for the Den-hosted onboarding page
- desktop auth utility tests where behavior changes
- Docker stack via `packaging/docker/dev-up.sh`
- Tauri desktop runtime via `pnpm --filter @neatech/veslo dev`
- browser validation of the upgraded desktop auth flow
- screenshots saved in-repo

## Key Constraint

This design intentionally accepts short-term duplication with `packages/web` so the desktop auth experience matches the official runtime path immediately. Consolidation can happen later, but finishing the feature now requires extending the Den-hosted browser onboarding that desktop already uses.
