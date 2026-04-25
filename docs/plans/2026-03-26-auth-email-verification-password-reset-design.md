# Auth Email Verification + Password Reset Design

**Date:** 2026-03-26
**Status:** Approved
**Branch:** main

## Goal

Add low-friction email verification and password reset to Veslo's existing sign-in/sign-up flow without introducing a second auth system or blocking local-first onboarding.

## Scope

- Den-owned auth configuration and mail delivery.
- Web auth UI updates for verification and reset-password flows.
- Verified-email enforcement for selected high-value actions.
- Desktop compatibility through existing browser-based auth onboarding.

Out of scope:

- Replacing Better Auth or moving auth ownership out of Den.
- Requiring email verification before first sign-in.
- Adding Tauri-native password reset or verification flows.
- Gating local-only usage on verified email.

## Validated Product Decisions

1. Email verification should be low-friction, not a hard sign-in gate.
2. Users should be able to sign up and sign in immediately with email/password.
3. Verification should still matter by gating selected actions.
4. Verified email should be required for:
   - cloud worker launch,
   - billing subscription changes,
   - org member add/update/delete.
5. Verified email should not be required for:
   - initial sign-up,
   - normal sign-in,
   - desktop handoff,
   - local-only usage.
6. Password reset should follow the standard email-link pattern.
7. The implementation should stay Better Auth-native.

## Approaches Considered

### 1) Better Auth-native flow (chosen)

- Keep Den as the auth source of truth.
- Configure Better Auth email verification and password reset callbacks.
- Build the missing browser UX in `packages/web`.

Pros:
- Fits the current architecture.
- Avoids duplicating token and verification logic.
- Lowest maintenance risk.

Cons:
- Still requires mail provider integration and callback URL discipline.

### 2) Custom Den auth flow

Pros:
- Maximum control over endpoints and payloads.

Cons:
- Reinvents flows Better Auth already supports.
- Adds unnecessary long-term maintenance cost.

### 3) Separate hosted auth surface

Pros:
- Could isolate auth UX from the product shell.

Cons:
- Moves further away from the existing Den-owned model.
- Adds system complexity without clear benefit for this feature.

## Architecture

- `services/den` remains the only auth authority.
- `packages/web` remains a thin browser client using the `/api/den/*` proxy.
- `packages/app` continues launching browser auth and should not own verification/reset logic.

### Den responsibilities

- Extend Better Auth config with:
  - `emailVerification.sendVerificationEmail`
  - `emailVerification.sendOnSignUp: true`
  - `emailAndPassword.sendResetPassword`
  - `emailAndPassword.requireEmailVerification: false`
- Add a small mailer abstraction for verification and reset emails.
- Add a reusable verified-email guard for selected API mutations.

### Web responsibilities

- Preserve the current sign-in/sign-up form.
- Add verification-state UX for signed-in but unverified users.
- Add forgot-password and reset-password flows.
- Handle stable `email_verification_required` API errors with a recovery CTA.

### Desktop responsibilities

- Continue using browser onboarding via Den web pages.
- Reuse the same verification and password reset pages.
- Do not add Tauri-specific mail or token flows.

## Components and Data Flow

### Core components

- `services/den/src/auth.ts`
  - Better Auth configuration for verification and reset.
- `services/den/src/email/*`
  - Mail provider abstraction and templates/payload helpers.
- `services/den/src/http/*`
  - Verified-email guard applied to selected endpoints.
- `packages/web/components/cloud-control.tsx`
  - Existing auth form plus verification banner and forgot-password entry.
- `packages/web/app/*`
  - Small focused pages for verification result and password reset.

### Data flow

1. User signs up through the existing web auth form.
2. Better Auth creates the account and session immediately.
3. Den sends a verification email in the background.
4. Web reads `user.emailVerified` from the current session and shows follow-up UX.
5. Gated Den endpoints reject unverified users with a stable `403` error.
6. Web responds to that error by routing the user to verification guidance and resend actions.
7. Password reset uses Better Auth reset tokens and web pages for final password entry.

## User Flows

### Sign up

1. User creates an account from the existing email/password form.
2. Sign-up succeeds and the user is signed in immediately.
3. Den sends a verification email.
4. Web advances the user normally and shows a persistent verify-email notice with resend.

### Sign in with unverified email

1. User signs in normally.
2. Sign-in succeeds.
3. Web shows the same persistent verification notice.
4. The user can continue until they hit a gated action.

### Verify email

1. User clicks the verification link from email.
2. A focused web result page shows success or failure/expired state.
3. Success provides a clear continue path.
4. Failure offers resend.

### Forgot password

1. User clicks `Forgot password?` from sign-in mode.
2. User submits their email.
3. Den triggers Better Auth reset mail delivery.
4. UI always shows a neutral success state.
5. User clicks the email link and lands on a reset-password page.
6. User sets a new password and returns to sign-in.

### Desktop onboarding

- Desktop browser onboarding uses the same web flows.
- Desktop handoff remains allowed for unverified users.
- Verification/reset result pages must not break the existing handoff path.

## Enforcement Policy

Require verified email for:

- `POST /v1/workers` when `destination === "cloud"`
- `POST /v1/workers/billing/subscription`
- `POST /v1/orgs/:orgId/members`
- `PATCH /v1/orgs/:orgId/members/:memberId`
- `DELETE /v1/orgs/:orgId/members/:memberId`

Do not require verified email for:

- initial sign-up,
- normal sign-in,
- desktop handoff,
- local-only usage.

Error contract for gated actions:

- HTTP `403`
- stable error code `email_verification_required`
- payload sufficient for UI recovery without guesswork

## Implementation Details

### Den auth configuration

- Update `services/den/src/auth.ts` to configure Better Auth verification and reset callbacks.
- Keep `emailAndPassword.requireEmailVerification` disabled to preserve the low-friction sign-in policy.
- Prefer `emailVerification.autoSignInAfterVerification: false` because users are already signed in when this flow matters.

### Mail delivery

- Add a Den-local email module under `services/den/src/email/`.
- Hide provider specifics behind a small interface:
  - `sendVerificationEmail({ to, url })`
  - `sendResetPasswordEmail({ to, url })`
- Recommended first provider: Resend, unless an existing provider preference overrides it.
- Add env vars for:
  - provider API key,
  - sender address,
  - web/app base URLs used in email links.

### Session data

- Use `user.emailVerified` as the single frontend source of truth.
- Ensure current session/me responses expose it consistently to web and desktop hydration consumers.

### Verified-email guard

- Add one reusable Den helper such as `requireVerifiedEmail(session, res)`.
- Apply it only to the approved gated endpoints.

### Web UI

- Extend the main auth panel with:
  - `Forgot password?` in sign-in mode,
  - verification banner with resend,
  - explicit handling for `email_verification_required`.
- Keep verification result and reset-password screens as small route-level pages instead of further inflating `cloud-control.tsx`.

## Testing Strategy

### Den tests

- Sign-up triggers verification send callback.
- Request-password-reset accepts input and triggers reset callback.
- Reset token flow succeeds with a valid token.
- Gated endpoints reject unverified users and allow verified users.

### Web tests

- Sign-in view exposes forgot-password entry.
- Signed-in unverified users see verification guidance.
- Gated `403 email_verification_required` responses show recovery UI.

### Manual verification

- Sign up -> receive verification email -> verify -> launch cloud worker.
- Sign up without verifying -> attempt cloud worker launch -> receive gate.
- Forgot password -> receive email -> reset password -> sign in.
- Desktop onboarding still completes for signed-in unverified users.

## Risks and Constraints

- Mail provider configuration and deliverability are the largest external risk.
- Better Auth callback/redirect URLs must stay aligned between Den and the deployed web app.
- Verification and reset result pages must coexist cleanly with the existing desktop handoff flow.
- The current large `cloud-control.tsx` component is already dense, so auth UI additions should stay incremental and offload route-specific screens into dedicated pages.

## References

- Better Auth email/password and verification/reset documentation.
- Existing Veslo Den auth configuration in `services/den/src/auth.ts`.
- Existing web auth flow in `packages/web/components/cloud-control.tsx`.
