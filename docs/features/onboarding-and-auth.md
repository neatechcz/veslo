# Onboarding and Auth

This document describes the shipped onboarding and sign-in behavior relevant to coding work.

## Current Onboarding States

The app-level onboarding flow includes these states:

- `language`
- `auth`
- `welcome`
- `local`
- `server`
- `connecting`

The UI lives in `packages/app/src/app/pages/onboarding.tsx`.

## First-Run Flow

Current first-run flow typically goes through:

1. language selection
2. browser sign-in
3. workspace selection or connection
4. connecting state

Depending on environment policy, the app can emphasize cloud-only or allow local worker creation.

## Browser Sign-In Handoff

The desktop app delegates sign-in to the browser.

Important pieces:

- browser sign-in uses `den-auth.ts`
- the desktop app can open a browser URL with `?desktopOnboarding=1`
- deep-link completion returns to the desktop app
- a temporary pending auth state is stored during the handoff

If browser sign-in requires email verification, the verification callback page preserves the active desktop onboarding query context and routes the user back into the same onboarding page. The canonical onboarding page then completes the normal desktop handoff to the `veslo://auth-complete` deep link.

Desktop auth transactions are one-time state. If a verification or sign-in return attempts to complete a transaction that the desktop app or another browser tab already advanced, the hosted onboarding page checks the transaction status before surfacing an error. Already authorized transactions reuse the existing handoff code, and already exchanged transactions show the signed-in success state instead of exposing `transaction_not_ready` to the user.

Password reset also stays in the browser handoff flow. The reset page keeps the reset token out of visible UI and removes it from browser history after reading it. When the password update succeeds, the hosted page signs in with the reset email and new password, then completes the same desktop handoff. If the reset email is unavailable or sign-in fails, the page falls back to the normal sign-in form.

The hosted desktop onboarding page also caches the current desktop auth transaction context in browser session storage. If a later auth or verification return lands back on the onboarding page without the original transaction query, the hosted page restores that context before attempting the desktop handoff. This keeps the original desktop auth transaction alive across browser-managed redirects.

Key persistent settings:

- `veslo.den.auth`
- `veslo.den.keepSignedIn`
- `veslo.den.apiBaseOverride`
- `veslo.den.desktopAuthPending`

## Keep Signed In

The auth step includes a `Keep me signed in` control.

Meaning:

- on: prefer persisted auth across launches
- off: prefer narrower session lifetime and require sign-in more often

The behavior is implemented in `den-auth.ts` and surfaced both in onboarding and Settings.

## Local Worker Creation

When local mode is available, onboarding can:

- create a managed local worker
- import an existing workspace config archive
- configure allowed roots for local access

Important surfaces:

- `OnboardingWorkspaceSelector`
- `config-store.ts`
- workspace activation in `context/workspace.ts`

## Remote Connection

When remote/server mode is used, onboarding collects:

- Veslo host URL
- client token
- optional remote directory

Invite links can prefill these values before or during onboarding.

## Migration Repair and Engine Checks

Onboarding also surfaces environment recovery when local mode is active:

- engine doctor status
- install hints
- OpenCode DB migration repair

If you change onboarding behavior that depends on local engine readiness, verify whether the environment branch is local-only, cloud-only, or shared.

## Source of Truth

- UI: `packages/app/src/app/pages/onboarding.tsx`
- auth lifecycle: `packages/app/src/app/lib/den-auth.ts`
- workspace activation and onboarding completion: `packages/app/src/app/context/workspace.ts`
- workspace config import/export: `packages/app/src/app/stores/config-store.ts`
