# Corporate Email Signup Gate Design

**Status:** Approved by user on 2026-07-21

## Goal

Prevent users on known personal-email provider domains from creating a Veslo account, while preserving a valid organization invitation as the only exception. Rejected users must receive a clear explanation that registration requires a company email address or an organization invitation link.

This design was reconciled on 2026-07-21 with the separately approved signup-organization domain bootstrap. An unclaimed domain that is not classified as a personal provider remains eligible to create its first organization and exact-domain rule.

## Product Rules

Signup is allowed when one of these conditions is true:

1. The normalized email matches an enabled organization domain with self-signup enabled, and the organization has an available seat.
2. The signup carries a valid pending organization invitation for the same normalized email, and the organization has an available seat.
3. The normalized email domain is not a known personal provider and is not yet claimed; the existing organization bootstrap creates the first organization and exact-domain rule.

Known personal-provider domains are matched against one centrally owned, exact-domain policy that covers common global and Czech consumer services. Lookalike and subdomains are not rejected by suffix matching. A personal-domain attempt without a valid invitation is rejected before the authentication user, session, account, or organization is created. The rule applies to email/password and social-provider signup.

A valid organization invitation remains the only path for a user with a personal email address. There is no platform-admin approval queue, approval email, or pending signup record.

## Architecture

DEN remains the source of truth for signup authorization. A pure personal-domain classifier will run inside the existing pre-create signup gate. The Better Auth request guard and user-create hook will continue to provide defense in depth for email/password and social signups.

The existing organization-domain repository remains authoritative for domain matching. The existing organization-invitation repository remains authoritative for invitation validation, email matching, expiry, single use, role assignment, and seat-capacity enforcement.

No new persistence model is required. Existing organization bootstrap remains responsible for unclaimed company domains. Existing organization administration APIs and the canonical admin portal continue to let authorized organization admins create invitations for any valid email address.

## User Experience

Hosted registration surfaces must recognize the domain rejection code and show a clear, actionable message instead of a raw backend error:

> Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.

The message must appear for direct hosted signup and the browser handoff used by desktop onboarding. Generic authentication errors remain unchanged for unrelated failures. Seat-capacity errors retain their distinct message and status.

## Data Flow

1. The client submits email/password signup or completes a social-provider signup.
2. DEN normalizes the email and classifies its exact domain.
3. A known personal domain is rejected unless the request carries a valid invitation for the same email with available organization capacity.
4. For other domains, DEN resolves an enabled self-signup organization domain.
5. If a matching domain exists, DEN verifies seat capacity and allows user creation.
6. If no domain exists but a valid invitation was supplied, DEN uses the invitation path.
7. Otherwise, DEN allows the existing organization bootstrap for the unclaimed company domain.
8. Hosted clients map `domain_not_allowed` to the company-email guidance.
9. Successful domain, invitation, or bootstrap signup runs the existing downstream onboarding behavior.

## Error Handling and Security

- Server-side authorization is mandatory; client-side messaging is not an access boundary.
- Rejected signup does not create an authentication record or default organization.
- Invitation tokens remain hashed at rest, email-bound, expiring, and single use.
- Submitted stored token hashes are not accepted as bearer invitation tokens.
- Seat capacity is checked before creation and again during membership activation.
- Repository and infrastructure failures are not misreported as domain-policy rejections.

## Testing

Implementation follows test-driven development. Coverage must include:

- common global and Czech personal-provider domains are rejected without an invitation;
- an unknown company domain remains eligible for organization bootstrap;
- exact-domain matching does not reject lookalike or subdomains;
- a disabled or invite-only domain is rejected without a valid invitation;
- an enabled self-signup domain with capacity succeeds;
- an enabled domain at capacity returns the existing seat-limit error;
- a valid invitation permits a personal email and activates membership;
- an invalid, expired, consumed, mismatched, or over-capacity invitation does not bypass the gate;
- email/password and social-provider creation hooks enforce the same rule;
- hosted signup surfaces render the company-email guidance for `domain_not_allowed`;
- rejected personal-domain signup does not create a user or organization.

Verification uses focused DEN and hosted-auth tests, the relevant canonical admin/invitation regression tests, and the repository's required quality gate. Desktop validation uses the real Tauri runtime only if the changed browser-handoff surface requires an app-level regression check; a web-only runtime is not accepted as proof of desktop behavior.
