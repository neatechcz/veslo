# Personal Email Gate Integration Addendum

**Goal:** Close the end-to-end gaps found by holistic review so organization invitation links authorize both email/password and GitHub signup, and social rejection returns actionable company-email guidance.

**Architecture:** After an organization invitation is created or resent, DEN queues a background Lettr attempt to deliver its one-time registration link. The admin operation does not wait for or guarantee mail delivery. New links carry the raw token in the canonical `#inviteToken` fragment so it is not sent in the HTTP request URL. Hosted clients synchronously capture the fragment into `sessionStorage` when available, attempt to scrub it from browser history, and accept the former `inviteToken` query form only as a legacy input. Email signup sends the token in the existing request field. GitHub signup carries it temporarily in Better Auth's encrypted cookie-backed OAuth `additionalData` state; DEN retrieves the request-local OAuth state inside its user-create hooks. GitHub callbacks use separate success, new-user, and error markers plus a correlated one-time auth attempt.

**Security:** Invitation tokens remain hashed at rest, are matched to the normalized invited email, and remain single-use and expiry-bound. Application code does not intentionally log them. Normal browser persistence uses `sessionStorage`, never `localStorage`; OAuth transport also uses Better Auth's temporary encrypted cookie-backed state. When an invitation parameter is present, public-web telemetry starts only after the URL is scrubbed successfully and remains disabled after a history-write failure; the DEN-hosted page has no telemetry bootstrap. GitHub completion requires the exact cryptographically random attempt identifier within a ten-minute TTL, consumes pending context once, and fails closed when storage or correlation cannot be verified.

---

## Task 6: Deliver invitation links and recover OAuth invitation state in DEN

**Files:**

- Modify `services/den/src/env.ts`
- Modify `services/den/src/email/auth-mailer.ts`
- Modify `services/den/src/http/admin-runtime.ts`
- Modify `services/den/src/auth.ts`
- Modify supporting DEN tests

**Requirements:**

- Expose the deployment-derived public app base URL from DEN environment parsing.
- Add a pure invitation-link builder that emits the canonical `#inviteToken` fragment on the public app origin, keeping the token out of the initial HTTP request URL.
- Add a branded organization-invitation auth email and attempt Lettr delivery in the background after both create and resend commit. Delivery requires `LETTR_API_KEY` and `AUTH_EMAIL_ADDRESS`; missing configuration or provider failure is logged without failing the completed admin operation.
- Preserve the existing one-time raw-token response and hashed-at-rest repository behavior.
- Make auth-context invitation-token reading asynchronous and recover `vesloSignupInviteToken` from Better Auth request-local OAuth state, while preserving email-body and header behavior.
- Validate direct social `additionalData` as well as redirect callback state.
- Test URL encoding, hosted deployment origin, mail payload, create/resend wiring, email context, OAuth state context, and invalid/missing values.

## Task 7: Propagate invitation tokens and render social callback errors in hosted clients

**Files:**

- Add a small pure invitation-token helper and tests under `packages/web/lib/`
- Modify `packages/web/components/cloud-control.tsx`
- Modify `packages/web/scripts/auth-email-flows.mjs`
- Modify `services/den/public/index.html`
- Modify `services/den/test/desktop-auth-onboarding-page.test.ts`
- Correct the invalid invite-role fixture in `services/den/test/signup-domain-gate.test.ts`

**Requirements:**

- Capture `#inviteToken` synchronously into `sessionStorage` when available and attempt to remove it from browser history before public-web telemetry. Start telemetry only after a successful scrub and otherwise keep it disabled. Accept the legacy `inviteToken` query form only for compatibility and handle it through the same path. The DEN-hosted page does not initialize telemetry.
- Include the token in email signup requests only.
- Include the token as `additionalData.vesloSignupInviteToken` for GitHub OAuth signup so the encrypted state reaches DEN.
- Clear the stored token after successful email signup or a correlated GitHub new-user callback; retain it after a recoverable failure and after existing-user or error callbacks.
- Give GitHub dedicated marked success, new-user, and error callback URLs. Correlate each callback to the exact random pending attempt within a ten-minute TTL, consume that context once, and fail closed on storage or correlation failure. Map exact `domain_not_allowed` through the shared formatter and scrub callback parameters.
- Capture the submitted auth mode before asynchronous public-web requests so endpoint, analytics, and follow-up behavior cannot race with UI toggling.
- Preserve sign-in, verification, reset, desktop handoff, ordinary OAuth errors, and company-domain bootstrap behavior.
- Add behavioral tests for token parsing/scrubbing and source/request contracts for both hosted clients and the GitHub callback path.

## Task 8: Update durable docs and re-run complete verification

- Document invitation-link delivery attempts, canonical fragment capture and scrubbing, legacy query compatibility, and email/social transport without durable raw-token persistence or telemetry.
- Run focused DEN, web, AI Gateway, and auth tests; both relevant typechecks; stale-policy searches; `git diff --check`; and `pnpm check`.
- Re-run holistic review after all fixes.
