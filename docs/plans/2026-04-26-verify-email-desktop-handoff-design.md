# Verify Email Desktop Handoff Design

## Goal

When a user starts desktop browser sign-in/sign-up, then verifies their email in the browser, the verification success page should let them return to the Veslo desktop app and complete sign-in without restarting the auth flow.

## Current Gap

- `packages/web/app/verify-email/page.tsx` is a static success/error page with a generic `Return to Veslo` link to `/`.
- Desktop browser auth state already exists in the desktop app via the pending proof stored by `packages/app/src/app/lib/den-auth.ts`.
- The existing browser-to-desktop handoff currently lives in `packages/web/components/cloud-control.tsx`, which calls `POST /v1/desktop-auth/handoff` and then deep-links to `veslo://auth-complete?code=...`.
- After email verification, users can end up on `/verify-email` instead of the page that performs the handoff, so verification succeeds but desktop sign-in does not finish.

## Recommended Approach

Use the existing desktop onboarding context and one-time desktop auth transaction to make `/verify-email` a handoff-capable success page.

On verification success:

1. Detect whether the page was opened from desktop onboarding.
2. Preserve the desktop auth transaction context already present in the browser session.
3. Request the existing handoff code from `POST /v1/desktop-auth/handoff`.
4. Render a visible `Return to Veslo` CTA that points to `veslo://auth-complete?code=<code>`.
5. Optionally auto-attempt the deep link, but the visible CTA is the required success path.

On verification error:

- keep the current failure messaging
- do not request handoff
- keep resend/retry guidance unchanged

## Why This Approach

- It reuses the shipped desktop auth contract instead of creating a second verification-specific auth completion flow.
- It keeps the authority for the handoff code in Den, where it already exists.
- It makes verification completion explicit and predictable for browsers that do not auto-open deep links.
- It minimizes desktop-side changes because the existing `veslo://auth-complete` exchange path already works.

## Alternatives Considered

### 1. Redirect `/verify-email` back to `/` and let `cloud-control.tsx` finish the handoff

Pros:

- fewer code paths on the verification page

Cons:

- relies on broader app-shell state and navigation
- more fragile if onboarding context or org resolution is delayed
- less explicit for the user

### 2. Add a verification-specific deep-link token directly in the email callback

Pros:

- could skip the extra handoff request

Cons:

- creates a second auth completion mechanism
- duplicates security-sensitive flow logic
- unnecessary given the existing desktop auth handoff

## Data Flow

1. Desktop app starts browser auth and the browser enters desktop onboarding mode.
2. User signs up or signs in but is blocked by email verification.
3. Verification email opens `/verify-email` with the existing desktop onboarding query context preserved.
4. The verification page reads that context, waits for the authenticated browser session, resolves the active org if needed, and calls `POST /v1/desktop-auth/handoff`.
5. The page exposes `Return to Veslo` using the returned one-time code.
6. Desktop receives `veslo://auth-complete?code=...`, exchanges it, and finishes sign-in.

## Error Handling

- If desktop onboarding context is missing, `/verify-email` stays a normal web verification success page.
- If handoff fails, the page shows a clear retry message and keeps the CTA area visible for another attempt.
- If the user is not yet signed in when the page loads, the page should avoid issuing the handoff until auth state is available.
- If org resolution is required, reuse the same org-selection rules already used by desktop onboarding in `cloud-control.tsx`.

## Testing Strategy

- Add a failing web contract/script test proving that the verification page includes desktop handoff behavior when desktop onboarding applies.
- Add a failing unit test around the browser auth helper or deep-link builder if new shared helpers are introduced.
- Verify the existing desktop auth tests still pass.
- Run the relevant web checks plus the auth helper tests.
- If implementation touches actual desktop handoff semantics, run the real desktop runtime verification path afterward.

## Documentation Impact

Update the web auth/onboarding documentation so desktop onboarding mode explicitly includes the email verification completion path, not only the initial sign-in page handoff.
