# Domain-Bound Organization Trial Design

**Status:** Approved on 2026-07-21

## Goal

Grant one 14-day organization trial per registered company email domain. A
domain can unlock a trial only after an active member of the organization has
verified an email address on that exact domain. Once a domain participates in
a trial, removing, disabling, renaming, or later re-registering the domain must
never make it eligible for another trial.

## Scope

This change belongs to DEN organization, domain, authentication, and billing
logic. It does not change the Veslo desktop application, the local Veslo server,
or their API contracts.

The signup policy remains the sole authority for deciding whether an email
domain may be registered. Trial code does not maintain a public-email-provider
list and does not attempt to classify a domain independently.

## Domain and Verification Semantics

DEN uses the existing normalized exact email domain. For example,
`owner@team.example.com` verifies `team.example.com`, not `example.com`.

A domain is eligible to be registered for an organization only when DEN can
find at least one user who:

- has an active membership in that organization;
- has `emailVerified=true`; and
- has an email whose normalized exact domain equals the proposed organization
  domain.

The same rule applies when an administrator creates a domain or changes an
existing domain to a different value. A domain registration request without
that evidence fails with `domain_verified_member_required` and writes no domain
record.

Verification is required at registration time. A later membership removal or
email change does not delete the registered domain or its historical trial
claim.

## Signup Ordering

Email/password signup must not register a company domain or grant a trial while
the new account remains unverified.

1. Signup creates the unverified authentication user and sends the verification
   message.
2. No organization-domain registration, trial grant, or usable managed-AI
   assignment is completed for that identity yet.
3. Successful email verification invokes the organization bootstrap flow with
   the now-verified identity.
4. If the exact domain is already registered and enabled for self-signup, the
   verified user joins that organization.
5. Otherwise, the verified user creates the organization, its first active
   organization-admin membership, and the registered domain transactionally.
6. The registered domain then participates in the domain-bound trial decision.

An identity provider may use the immediate path only when DEN receives a
trusted verified-email result from that provider. Concurrent first verified
users for the same domain retain the existing unique-domain winner-and-recovery
behavior: one organization owns the domain and the other user joins the winning
organization subject to its membership policy.

This ordering composes with the separately designed email-verification hard
gate. It closes the gap in which an unverified signup could otherwise reserve a
foreign domain or consume its trial.

## Immutable Trial Domain Claims

DEN adds an `organization_trial_domain_claim` ledger. Each row contains a
normalized domain, the organization that first consumed it, and the claim
timestamp. The domain has a unique constraint and claim rows are never removed
by normal organization-domain mutations.

The ledger is separate from `organization_domain` because the latter describes
current organization routing and may legitimately be deleted or reassigned.
It is separate from Stripe event identifiers because domain eligibility is a
product invariant rather than an external billing delivery detail.

When an organization receives one trial, every currently registered domain on
that organization is inserted into the immutable ledger as part of the same
serializable transaction. One organization still receives only one billing
account and one 14-day trial, regardless of how many domains it owns.

If an organization with an existing trial later registers another verified
domain, that domain is added to the same immutable ledger. Removing the current
`organization_domain` row never removes the ledger row. Re-registering that
domain for another organization therefore cannot create a second trial.

## Trial Decision

The automatic trial service follows this order:

1. Lock the organization and read its currently registered domains in stable
   normalized order.
2. If no registered domain exists, do not grant a trial.
3. Preserve any existing billing account exactly as configured.
4. If the existing account represents a trial, claim every currently
   registered domain that is not yet claimed by that same trial organization.
5. If the organization has no billing configuration, check all current domains
   against the immutable claim ledger.
6. If any current domain was already claimed, do not grant a new trial.
7. Otherwise, insert claims for all current domains, create the existing
   14-day unlimited manual-trial billing account, and append the automatic trial
   billing event atomically.

Unique domain claims are the final concurrency guard. A duplicate-key race is
treated as an ineligible trial, never as permission to create a second trial.
The transaction either writes the complete set of claims and trial state or
writes neither.

A paid account that never used a trial does not consume domain trial claims
merely by existing. Existing manual or automatic trial accounts do consume all
domains registered to their organization.

## Domain Administration Flow

For manual domain creation or rename, DEN validates the active verified member
before writing. On successful creation, DEN invokes the trial service within
the coordinated database mutation:

- an organization without billing may receive its first eligible trial;
- an organization with an existing trial consumes the newly added domain;
- an organization whose domain was historically claimed still registers the
  domain successfully but receives no new trial.

Domain deletion and disabling do not touch trial claims. Admin audit records
identify the organization, domain, and member used as verification evidence
without exposing unnecessary authentication secrets.

## Reconciliation

Startup reconciliation reads only registered organization domains; it never
derives domains from owner or member emails and never classifies public
providers.

For an organization with a prior trial, reconciliation backfills immutable
claims for its current registered domains. For an unconfigured organization,
it applies the normal all-domains-unclaimed decision. Organizations without a
registered domain remain unchanged.

There are currently no registered production domains to migrate. Existing
billing configuration remains untouched. If an existing trial organization
registers its first domain later, that domain is consumed by the existing trial
at registration time.

## Error Handling

- Invalid domain syntax keeps the existing `invalid_domain` response.
- Missing verified-member evidence returns HTTP 409 with
  `domain_verified_member_required`.
- A current duplicate domain keeps the existing `domain_exists` response.
- A historical trial-domain claim does not block domain registration; it only
  prevents a new trial.
- Database or claim-ledger failures fail closed and must not produce a partial
  trial grant.
- Existing billing accounts and administrator-set expiry values are never
  recalculated or overwritten.

## Verification Strategy

Primary DEN workflow tests cover:

- unverified signup creates no domain-bound trial;
- verified signup creates or joins the organization before the trial decision;
- a verified active member permits exact-domain registration;
- an unverified, inactive, differently scoped, or differently domained user
  does not permit registration;
- one organization with multiple domains receives one trial and consumes all
  of them;
- a later domain added to a trial organization is consumed;
- deleting and re-registering a consumed domain never grants another trial;
- concurrent organizations cannot claim the same trial domain;
- one previously claimed domain blocks a trial for an organization with a
  mixed claimed/unclaimed domain set;
- existing manual trials keep their expiry and backfill current domain claims;
- organizations without registered domains receive no automatic trial; and
- startup reconciliation is idempotent.

Focused DEN tests and typechecks run first, followed by the repository's normal
`pnpm check` quality gate. No desktop E2E scenario is required because the
change does not alter desktop behavior or local-server contracts.
