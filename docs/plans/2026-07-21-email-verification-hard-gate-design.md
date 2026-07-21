# Email Verification Hard Gate Design

## Goal

Require email/password users to verify their email address before Veslo creates a usable authentication session or completes the desktop authentication handoff. A successful signup must also prove that the configured email provider accepted the verification message instead of silently ignoring delivery failures.

## Current Behavior

DEN configures Better Auth email verification only when both Lettr credentials are present. Email/password authentication explicitly allows unverified users to sign in, the verification send callback runs as fire-and-forget work, and the hosted onboarding page offers unverified users a path to continue to Veslo. Desktop authorization has a separate environment-controlled verification check, so enforcement can differ across signup, sign-in, and handoff.

## Decision

Use Better Auth's native email-verification requirement as the primary authentication boundary and keep an unconditional verification check at the desktop authorization boundary as defense in depth.

When verification enforcement is enabled:

- `emailAndPassword.requireEmailVerification` is enabled.
- verification email is sent on signup and on an unverified sign-in attempt.
- DEN awaits the Lettr acceptance response and propagates delivery failure.
- signup creates the unverified account but does not create a usable session or token.
- sign-in stays blocked until Better Auth records `emailVerified=true`.
- desktop authorization rejects an unverified session even if one exists from legacy state.
- production startup fails when verification is required but Lettr transport or sender configuration is missing.

Development and isolated tests may explicitly disable the verification policy when they do not run an email transport. Production deployment defaults and examples keep the policy enabled.

## User Flow

1. The user starts a desktop signup transaction and submits the hosted browser form.
2. DEN authorizes the signup, creates an account with `emailVerified=false`, creates a verification token, and awaits Lettr's acceptance of the verification email.
3. The hosted page shows the verification-required state without a bearer token and without a Continue to Veslo action.
4. The verification link updates the account and returns to the same hosted onboarding context.
5. The user returns to sign-in. Only the verified sign-in creates a session and authorizes the one-time desktop handoff code.
6. The desktop exchanges that code and persists the authenticated DEN identity normally.

An unverified sign-in attempt remains blocked and triggers another verification email. The page stays on the verification-required state so the user can resend explicitly as well.

## Error Handling

DEN must not report that an email was sent until Lettr returns a successful response. If Lettr rejects or cannot accept the message, the hosted page shows a delivery error and keeps an explicit resend path. Because Better Auth may already have created the unverified account before the send fails, a subsequent sign-in or resend request must remain a supported recovery path.

Missing production mail configuration is a startup error, not a runtime mode that silently disables verification. Provider errors must stay free of API keys and raw secret values in logs and responses.

Legacy unverified sessions cannot complete desktop authorization. Existing verified users and social-provider users whose provider supplies a verified email continue through the normal flow.

## Components

- DEN environment parsing owns the verification policy and fail-closed production validation.
- Better Auth configuration owns signup and sign-in enforcement.
- The Lettr auth mailer owns provider acceptance and safe error reporting.
- The hosted DEN onboarding page owns verification-required, resend, and post-verification browser states.
- Desktop Auth v2 owns the final verification check before issuing a one-time code.
- Deployment configuration owns an enabled production policy and required Lettr values.

## Verification Strategy

The primary acceptance test exercises the real DEN HTTP signup flow with test persistence and a local Lettr-compatible stub. It proves that signup submits the verification message, returns no usable token, blocks sign-in and desktop authorization before verification, accepts the verification link, and allows sign-in afterward.

A browser E2E test exercises the hosted onboarding page and verifies that the user cannot continue before verification, can request resend, and sees provider failures accurately. A focused Tauri Pilot path verifies that only a verified identity can cross the desktop handoff boundary in the real Tauri runtime.

Smaller tests cover environment validation, mailer request shape/error propagation, Better Auth configuration, onboarding copy and controls, and the stable desktop authorization error. Final verification includes the focused DEN and E2E commands followed by the repository's required `pnpm check` gate.

## Non-Goals

- Building a durable transactional email outbox.
- Changing social-provider verification semantics.
- Adding a partially authenticated product mode for unverified users.
- Deploying or releasing Veslo as part of the source-code change.
