# Personal Email Gate Integration Addendum

**Goal:** Close the end-to-end gaps found by holistic review so organization invitation links authorize both email/password and GitHub signup, and social rejection returns actionable company-email guidance.

**Architecture:** DEN sends a one-time registration link when an organization invitation is created or resent. Hosted clients capture the raw token from the canonical `inviteToken` query parameter, store it only in session storage, and immediately scrub it from browser history. Email signup sends the token in the existing request field. GitHub signup carries it in Better Auth's signed OAuth `additionalData`; DEN retrieves the request-local OAuth state inside its user-create hooks. GitHub callback errors use a marked error callback URL and are mapped by the existing safe auth-error formatter.

**Security:** Invitation tokens remain hashed at rest, are matched to the normalized invited email, remain single-use and expiry-bound, and are never logged or persisted in durable browser storage. Query tokens are scrubbed before analytics or subsequent navigation. OAuth transport relies on Better Auth's signed, expiring state rather than a new unsigned cookie.

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
- Add a pure invitation-link builder that emits the canonical `inviteToken` query parameter on the public app origin.
- Add a branded organization-invitation auth email and send it in the background after both create and resend succeed.
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

- Capture `inviteToken` from the URL, save it in session storage, and remove it from browser history immediately.
- Include the token in email signup requests only.
- Include the token as `additionalData.vesloSignupInviteToken` for GitHub OAuth signup so the signed state reaches DEN.
- Clear the stored token after successful signup; retain it after a recoverable failure.
- Give GitHub a dedicated marked error callback URL. On callback, map exact `domain_not_allowed` through the shared formatter, clear the pending GitHub analytics marker, and scrub callback error parameters.
- Capture the submitted auth mode before asynchronous public-web requests so endpoint, analytics, and follow-up behavior cannot race with UI toggling.
- Preserve sign-in, verification, reset, desktop handoff, ordinary OAuth errors, and company-domain bootstrap behavior.
- Add behavioral tests for token parsing/scrubbing and source/request contracts for both hosted clients and the GitHub callback path.

## Task 8: Update durable docs and re-run complete verification

- Document invitation-link delivery, query scrubbing, and email/social transport without exposing raw tokens.
- Run focused DEN, web, AI Gateway, and auth tests; both relevant typechecks; stale-policy searches; `git diff --check`; and `pnpm check`.
- Re-run holistic review after all fixes.
