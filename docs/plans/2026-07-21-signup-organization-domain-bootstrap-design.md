# Signup Organization Domain Bootstrap Design

**Status:** Approved on 2026-07-21

## Goal

When a new user signs up with an email domain that is not yet claimed, DEN creates the user's organization and an enabled self-signup domain rule together. Later users with the same exact email domain join that organization automatically.

## Scope

This change covers organization-domain creation and domain-based membership assignment during signup. Enforcing that every new signup uses a company domain is being handled separately and is not part of this change. Existing organizations are not backfilled.

## Domain Semantics

DEN uses the normalized exact email domain after `@`. For example, `jan@team.example.com` claims `team.example.com`, not `example.com`. Matching remains case-insensitive through the existing email-domain normalizer.

An automatically created domain is enabled and has self-signup enabled. A domain that an administrator has disabled or made invite-only is never re-enabled by signup.

## Signup Flow

1. Before user creation, DEN keeps the existing signup authorization and seat-capacity checks.
2. After user creation, DEN resolves the normalized email domain again.
3. If an enabled self-signup domain exists, DEN activates a `member` membership in its organization and does not create another organization.
4. If no enabled domain exists and a valid invite was supplied, DEN accepts the invite and does not create a new organization or domain.
5. Otherwise, DEN transactionally creates the organization, its first `organization_admin` membership, and an enabled self-signup domain record.
6. Managed-AI assignment continues only after an active organization membership exists.

The first organization's existing naming and ownership semantics remain unchanged. The new domain record is an additional organization bootstrap artifact.

## Concurrency and Failure Handling

The organization, first membership, and domain claim are committed in one database transaction. The existing unique index on normalized domain is the final ownership guard.

If two users concurrently become the first signup for the same domain, one transaction claims the domain. The other transaction rolls back its provisional organization and membership, resolves the winning enabled domain, and activates the second user as a member of that organization. This recovery still enforces the organization's seat limit.

If the conflicting domain is disabled or invite-only, recovery fails with `domain_not_allowed`; signup must not change the administrator's policy. Any non-recoverable post-create failure uses the existing cleanup path so the newly created Better Auth user does not remain without valid organization access.

## Testing

The primary signup behavior is covered through the existing DEN signup workflow boundary, with repository-level support tests where database transaction mechanics need focused verification. Coverage includes:

- the first signup creates an organization-admin membership and an enabled self-signup domain;
- a later signup with the same exact domain joins the existing organization as a member;
- domain normalization is case-insensitive;
- a subdomain claims only that exact subdomain;
- disabled or invite-only domains are not reactivated;
- concurrent claims create only one durable organization and recover the losing signup into it;
- failures roll back organization bootstrap state and clean up the newly created auth user;
- existing invite precedence and seat-limit behavior remain unchanged.

The focused DEN suite runs first, followed by the repository's normal `pnpm check` quality gate. This backend-only change does not alter desktop UI or Tauri runtime behavior, so no new desktop scenario is required.
