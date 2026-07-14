# Unified Cloud, Admin, and Login Redesign

**Date:** 2026-07-14
**Status:** Approved
**Scope:** Veslo Cloud, the canonical browser authentication surface, Admin discovery, AI Gateway Admin visual styling, and the existing desktop/browser handoff.

## Goal

Make Veslo Cloud and AI Gateway Admin read as one product, give organization administrators an explicit path from Cloud to their permitted Admin area, and replace the duplicate Cloud and Den login interfaces with one canonical user-facing authentication page at `app.veslo.work/login`.

The existing Den authentication behavior remains the source of truth. This work moves and restyles the proven browser flow; it does not replace Better Auth, email delivery, password reset, email verification, organization resolution, PKCE, or one-time handoff semantics.

## Product boundaries

Veslo remains local-first. The Tauri desktop app is the primary execution surface. Veslo Cloud remains a user-facing control surface for authentication, hosted cloud workers, worker connection details, and cloud-worker billing.

AI Gateway Admin remains deployed under the AI Gateway origin. It is reached from Veslo Cloud through role-aware navigation:

- Organization owners and organization administrators see `Manage organization`, which opens the role-limited organization Admin area.
- Platform administrators additionally see `Open platform admin`, which opens the full platform Admin area.
- Ordinary members see neither Admin entry.

Organization administrators remain scoped to their own organization. They do not receive a global organization switcher or platform-only controls.

## Selected architecture

### Canonical login

`app.veslo.work/login` is the only user-facing login implementation for:

- ordinary Veslo Cloud sign-in and signup
- AI Gateway Admin authentication
- desktop browser authentication and handoff
- forgot-password and reset-password flows
- email verification and verification resend
- GitHub authentication

Den remains the authentication API and data owner. Cloud calls it through the existing same-origin proxy. Den no longer renders a second interactive login page. Requests to the legacy Den browser-auth URL redirect to the canonical Cloud login while preserving supported flow parameters.

Compatibility routes for password reset and email verification may remain, but they only normalize and redirect into the appropriate `/login` state. They do not render separate authentication interfaces.

### Auth transaction handling

The canonical login page recognizes three contexts without forking the authentication UI:

1. **Cloud context**
   - A protected Cloud page redirects to `/login` with a sanitized same-origin return path.
   - Successful authentication returns to that path.
   - An existing authenticated session bypasses the form and continues immediately.

2. **Admin context**
   - AI Gateway Admin starts its existing Den/PKCE browser-auth transaction.
   - Den returns an authorization URL under `app.veslo.work/login` instead of the Den origin.
   - The login page preserves the session/transaction parameters, authenticates the user, resolves the active organization, and completes the existing handoff.
   - The browser follows Den's validated redirect URL back to the original Admin route.
   - AI Gateway exchanges the code and sets its existing protected Admin session cookie.

3. **Desktop context**
   - The desktop app starts the existing transaction and opens the canonical login page.
   - The login page preserves the transaction ID, state, and requested sign-in/signup intent.
   - After authentication and organization selection, the page authorizes the existing transaction and opens the returned `veslo://` redirect.
   - The page keeps visible `Open Veslo` and `Download Veslo` actions so a user can recover when the browser cannot open the installed application.

Both currently supported transaction parameter shapes remain accepted during migration so existing desktop and Admin clients do not break.

## Existing authentication behavior to preserve

The current Den-hosted browser login is the behavioral reference. The canonical Cloud login must preserve:

- email/password sign-in
- email/password signup
- GitHub sign-in and signup
- signup restrictions and validation
- verification-email delivery
- resend verification email
- forgot-password email delivery
- reset-token validation and password update
- organization membership lookup and active-organization selection
- verified-email gates
- PKCE state and verifier checks
- one-time handoff code creation, expiry, and exchange
- safe callback and redirect validation
- desktop deep-link handoff

The migration must not introduce a new auth protocol or a parallel mail implementation.

## Login experience

The login page uses one component and route with explicit internal views:

- Sign in
- Create account
- Forgot password
- Reset password
- Verify email
- Resend verification email
- Authentication complete / redirecting
- Desktop opening and download fallback
- Expired or invalid transaction

Context changes copy and available actions without creating another page:

- Cloud: `Continue to Veslo Cloud`; sign-in and signup are available.
- Organization Admin: `Continue to Organization settings`; the flow defaults to sign-in and explains that Admin access is required.
- Platform Admin: `Continue to Platform admin`; platform-only access remains enforced by the backend.
- Desktop: `Continue to Veslo`; the transaction's requested sign-in/signup intent is respected.

An authenticated user is never asked to re-enter credentials merely because they arrived through another Veslo surface. The canonical page continues the pending transaction automatically when the existing session is sufficient.

## Visual system

Cloud, login, and AI Gateway Admin use the approved light visual direction already defined for Admin:

- paper ground `#f6f8fb`
- white panels
- ink text `#0a0e14`
- cyan accent `#00a8c8` used for active navigation, focus, and live signals
- DM Sans for product/interface typography
- DM Mono for labels, statuses, identifiers, and machine-like values
- 4px control and panel geometry, with 6px only for large framed surfaces
- hairline borders and restrained shadows
- flat surfaces without gradients, glows, glass effects, blurred color blobs, or oversized pills

The existing approved AI Gateway Admin visual redesign remains the Admin styling reference. The expanded scope applies the same tokens and behavior to the Cloud portal and canonical login.

### Login layout

The login uses an asymmetric, focused desktop layout rather than the current floating glass card:

- a quiet product/context region identifies Veslo and the destination
- one compact authentication panel contains the active form or recovery state
- legal and recovery links remain available without competing with the primary action
- mobile collapses to a single-column layout with touch-sized controls

### Cloud layout

The Cloud portal retains its working worker and billing behavior while receiving the shared visual system. Its real navigation is:

- Workers
- Cloud worker plan
- Manage organization, when authorized
- Open platform admin, when authorized

Inactive `Settings` and `Help Center` placeholders are removed. `Billing` is renamed `Cloud worker plan` so it cannot be confused with organization Managed AI licensing.

The active organization remains explicit. Platform-wide organization selection stays in platform Admin; the Cloud shell does not become a global platform switcher.

## Error and recovery behavior

All authentication errors stay in the canonical page with a direct recovery action:

- Expired or missing auth transaction: restart the requested sign-in flow.
- Expired reset or verification token: request a new email.
- Email verification required: show the verification state and resend action.
- No eligible organization: explain that an organization membership or invitation is required.
- Authenticated without Admin permission: show access denied and link back to Veslo Cloud; do not loop through login.
- Desktop application did not open: retry `Open Veslo` or use the visible download action.
- Unsafe or invalid return path: discard it and return to the Cloud home.
- Backend or network failure: keep entered non-secret form state where safe and provide a retry action.

Server-generated transaction redirects remain authoritative. The browser never accepts an arbitrary external `returnTo` destination.

## Security constraints

- Preserve PKCE and one-time authorization-code semantics for Admin and desktop handoffs.
- Preserve transaction expiry, state validation, and single-use exchange.
- Do not expose Den or AI Gateway bearer tokens to page URLs or persistent browser storage.
- Keep Admin authentication in an HTTP-only Admin cookie after gateway exchange.
- Only allow normal Cloud return paths on the Cloud origin.
- Preserve verified-email requirements where they currently apply.
- Do not broaden organization-admin permissions while improving discovery.
- Keep secrets out of the repository and browser-visible configuration.

## Verification strategy

Prefer E2E coverage. Lower-level tests support the E2E flows where they provide deterministic routing and security assertions.

### Browser E2E

- Cloud sign-in and signup through the canonical page.
- Verification email request, callback normalization, resend, and continuation.
- Forgot-password request, reset callback, successful password update, and sign-in.
- Admin protected route to canonical login to the original Admin route.
- Existing session bypass for Cloud and Admin transactions.
- Member, organization-admin, and platform-admin navigation visibility.
- Organization administrators can access only Organization and Users.
- Platform administrators retain credentials, usage, alerts, and audit access.
- Legacy Den login URL redirects to the canonical page and does not render another login UI.
- Unsafe return paths are rejected.

### Desktop E2E

Because the change affects desktop authentication behavior, verify the real Tauri runtime through the existing Tauri Pilot path:

- desktop starts auth and receives an `app.veslo.work/login` authorization URL
- browser authentication completes the existing transaction
- the `veslo://` callback returns to the desktop app
- the desktop app becomes signed in with the selected organization
- the retry/download fallback remains present in the browser

### Visual verification

Review the login, Cloud Workers, Cloud worker plan, and every permitted Admin view at desktop and mobile widths. Confirm typography, focus states, empty/loading/error states, dialogs, tables, and status chips use the approved tokens without regressions.

## Documentation updates

Update canonical developer and feature documentation to describe:

- `app.veslo.work/login` as the sole user-facing authentication page
- Den as the auth backend rather than a second login UI
- the Admin discovery path from Cloud
- role-scoped Admin navigation
- the desktop and Admin transaction flows through the canonical page
- the distinction between Cloud worker plan billing and organization Managed AI billing

## Non-goals

- Moving AI Gateway Admin under the Cloud origin
- Replacing Better Auth or the existing email provider
- Changing organization or platform role semantics
- Adding global organization switching to the Cloud portal
- Merging cloud-worker billing with Managed AI organization billing
- Changing the desktop execution model
- Adding a dark theme in this pass
