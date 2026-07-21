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

### Email Activation Boundary

Email/password registration is not a signed-in state. DEN authorizes the signup,
creates the unverified account, and waits for Lettr to accept the verification
message, but Better Auth creates no session, cookie, or bearer token. The hosted
page shows the verify-email state with no Continue to Veslo action. The provider
request has a 30-second timeout; rejection, transport failure, or timeout is
shown as a safe delivery failure and returned as
`502 VERIFICATION_EMAIL_DELIVERY_FAILED` rather than as a successful send.
That outcome belongs only to the originating native signup or sign-in request;
concurrent accepted and failed delivery requests cannot contaminate one another
or change another request's browser result.

An unverified sign-in stays blocked with `403 EMAIL_NOT_VERIFIED` and, after
valid password confirmation, triggers a fresh verification message. The same
native sign-in operation powers the hosted page's explicit resend action.
Anonymous `POST /api/auth/send-verification-email` is disabled and returns 404,
so unknown accounts and invalid passwords do not become a resend or account
enumeration surface. Production sign-in/signup attempts are rate-limited by IP
and auth path (three attempts per ten seconds, then 429). The current limiter is
in process memory and is per DEN replica; the owned-server topology therefore
keeps DEN single-replica until shared rate-limit storage is added.

The verification callback page preserves the active desktop onboarding query
context and routes the user back into the same onboarding page. Verification
does not auto-sign in. The user signs in after activation, and only that verified
session can complete the normal desktop handoff to the
`veslo://auth-complete` deep link.

Defense in depth applies to sessions created before this policy. The shared DEN
session boundary returns `403 email_verification_required` for unverified
cookie or bearer sessions before protected API and Managed AI work, and both
current and legacy desktop handoff routes use that boundary before issuing a
one-time code.

Desktop auth transactions are one-time state. If a verification or sign-in return attempts to complete a transaction that the desktop app or another browser tab already advanced, the hosted onboarding page checks the transaction status before surfacing an error. Already authorized transactions reuse the existing handoff code, and already exchanged transactions show the signed-in success state instead of exposing `transaction_not_ready` to the user.

Password reset also stays in the browser handoff flow. The reset page keeps the reset token out of visible UI and removes it from browser history after reading it. When the password update succeeds, the hosted page signs in with the reset email and new password, then completes the same desktop handoff. If the reset email is unavailable or sign-in fails, the page falls back to the normal sign-in form.

The hosted desktop onboarding page also caches the current desktop auth transaction context in browser session storage. If a later auth or verification return lands back on the onboarding page without the original transaction query, the hosted page restores that context before attempting the desktop handoff. This keeps the original desktop auth transaction alive across browser-managed redirects.

DEN signup runs authorization before Better Auth creates the user, including email/password and social provider signups. An enabled organization domain with self-signup enabled can auto-activate a member only while the organization has an available seat. Invite signup checks that organization's seat capacity before user creation, and domain-joined and invite-joined signups receive active organization membership without a personal default organization.

When signup is authorized to bootstrap a previously unclaimed company domain, DEN atomically creates the organization, the first user's organization-admin membership, an enabled self-signup domain rule, and the automatic organization trial. Domain matching uses the normalized exact value after `@`: `team.example.com` does not claim `example.com`. Later users with the same exact domain join the organization as members, subject to its seat limit.

The domain's unique index serializes concurrent first signups. The winning transaction creates the organization; a losing signup rolls back its provisional organization and joins the winning domain owner. Signup never re-enables a disabled or invite-only domain. A valid organization invitation remains an independent path and does not create another organization or domain.

Temporary integration state, as of 2026-07-21: the pre-create gate still permits an unmatched domain to enter organization bootstrap. The separate corporate-email signup policy must narrow that path to company domains and reject personal domains without removing bootstrap for the first eligible company user.

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
- on Windows, start the bundled shared non-sandbox local runtime; current installers do not ship WSL2 sandbox setup

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
- no WSL2 sandbox provisioning or repair flow in the current Windows installer/onboarding path

If you change onboarding behavior that depends on local engine readiness, verify whether the environment branch is local-only, cloud-only, or shared.

## Source of Truth

- UI: `packages/app/src/app/pages/onboarding.tsx`
- auth lifecycle: `packages/app/src/app/lib/den-auth.ts`
- workspace activation and onboarding completion: `packages/app/src/app/context/workspace.ts`
- workspace config import/export: `packages/app/src/app/stores/config-store.ts`
