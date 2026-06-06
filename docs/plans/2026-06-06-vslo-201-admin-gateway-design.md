# VSLO-201 Admin Gateway Design

## Status

Approved design from the June 2026 brainstorming session. This document is the product and technical design for VSLO-201. It does not implement the feature.

## Goal

Turn `ai.veslo.work/admin` into the single Admin Gateway for managed AI operations and organization/user administration. Platform admins should understand Codex capacity, receive actionable alerts, manage credentials, and administer all organizations. Organization admins should have a narrow admin view for only their organization users and organization settings.

## Terms

- **Admin Gateway**: the admin shell under `ai.veslo.work/admin` and its subpages.
- **Standalone AI Gateway**: the gateway service that hosts `ai.veslo.work/admin` and owns managed-AI runtime data such as credentials, leases, usage, and credential alerts.
- **DEN**: the auth and organization authority. DEN owns users, organizations, domains, invites, memberships, platform roles, and seat limits.
- **Organization**: a company or tenant. It has members, organization admins, seat limits, domains, invites, and onboarding policy.
- **Organization domain**: an email-domain rule owned by one organization, for example `neatech.cz`.

## Information Architecture

Use one admin shell under `ai.veslo.work/admin`.

Platform admin navigation:

- Credentials
- Sessions
- Usage
- Alerts
- Users
- Organizations
- Audit

Organization admin navigation:

- Users
- Organization

Do not add top-level `Domains` or `Approvals` navigation. Domains belong inside organization detail. The simplified approved onboarding model does not need a primary approval queue.

## Organization And Domain Model

Organizations and domains are separate concepts:

- An organization is the tenant being administered.
- A domain is a rule that maps email addresses into an organization.
- One organization can own multiple domains.
- One domain can belong to only one organization.

Organization detail should contain:

- Overview: name, slug, active users, invited users, disabled users, seat usage, seat limit.
- Members: active and disabled members, role and status management.
- Invites: pending, accepted, expired, and revoked invites.
- Domains: enabled organization domains and self-signup policy.
- Settings: organization settings. Seat limit editing is platform-admin-only.

## Roles And Permissions

Platform admin is a global role, separate from organization membership. The last platform admin cannot be removed, demoted, disabled, or deleted.

Organization membership roles:

- `member`
- `organization_admin`

Organization admins:

- can see only Users and Organization in the admin shell,
- can see only their organization data,
- can invite users to their organization,
- can manage users in their organization,
- can edit organization domains and onboarding policy for their organization,
- can see seat usage and seat limit,
- cannot edit the seat limit,
- cannot see credentials, sessions, global usage, global alerts, global audit, platform admin settings, credential secrets, or managed-AI pool configuration.

Organization admin removal is allowed. The last-admin guard applies only to platform admins.

All permissions must be enforced server-side. Hiding navigation in the browser is not sufficient.

## Data Model

DEN should own organization/user data.

`Organization`

- id
- name
- slug
- owner or primary contact metadata if needed
- seat limit
- created/updated metadata

`OrganizationDomain`

- organization id
- normalized domain
- enabled flag
- self-signup enabled flag
- created/updated metadata

The domain value is unique globally.

`OrganizationMembership`

- organization id
- user id
- role: `member` or `organization_admin`
- status: `active`, `disabled`, or `removed`
- created/updated metadata

The simplified approved flow does not use pending memberships for domain self-signup. Enabled domains auto-activate users up to the seat limit. Pending invite state belongs to invites.

`OrganizationInvite`

- organization id
- email
- intended role
- status: `pending`, `accepted`, `expired`, or `revoked`
- token hash
- invited by user id
- accepted by user id if accepted
- created/expires/accepted/revoked metadata

`User`

Global identity. A user should not receive a usable account through self-signup unless an enabled organization domain or valid invite allows it.

`PlatformRole`

Global platform-admin role. It is not an organization membership role.

## User Lifecycle

### Enabled Organization Domain

When a user signs up with an email whose domain matches an enabled organization domain:

1. Normalize the email domain.
2. Resolve the organization domain.
3. Verify self-signup is enabled.
4. Check active seat usage against seat limit.
5. If a seat is available, create the user if needed and create an active organization membership.
6. Apply ordinary access according to organization and managed-AI policy.
7. If no seat is available, block signup or account activation with `seat_limit_reached`.

### Domain Not Enabled

If no enabled organization domain permits the email domain, self-signup must not create a usable account. Return a clear `domain_not_allowed` style error. The user can join only through an invite from a platform admin or organization admin.

### Invite Flow

An organization admin or platform admin can invite an email into an organization.

Invite acceptance:

1. Validate invite token and email.
2. Check seat limit at activation time.
3. Create user if needed.
4. Create active organization membership with the invited role.
5. Mark invite accepted.

Seat limit is enforced at activation, not invite creation.

## Admin Gateway Architecture

Keep `ai.veslo.work/admin` as the single admin shell.

The AI Gateway admin service becomes the facade over:

- DEN admin APIs for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits.
- AI Gateway repositories for credentials, leases/sessions, managed-AI access, usage, alerts, and managed-AI audit.

The admin session returned to the shell should expose capabilities, not only `platformAdmin`.

Session shape should include:

- current user
- platform admin boolean
- organizations and roles
- visible admin sections
- capability flags needed by the UI

Route gates:

- platform-admin-only for credentials, sessions, global usage, global alerts, global audit, platform roles, seat limit edits, and managed-AI credential/model assignment.
- platform-admin or scoped organization-admin for organization users, invites, domains, and organization settings that are not platform-only.

Organization-admin calls must always be scoped to the caller's organization server-side.

## Users Page

Users is a shared surface.

Platform admin:

- sees all users,
- sees all organization memberships,
- can set platform admin,
- can manage organization memberships,
- can manage managed-AI access,
- can disable/delete users subject to last-platform-admin guard.

Organization admin:

- sees only users in their organization,
- can invite users,
- can disable/remove users from the organization,
- can edit organization role/status inside their organization,
- cannot edit platform admin,
- cannot edit managed-AI credential/model assignment.

The detail panel should separate:

- Profile
- Organization membership
- Platform access
- Managed AI access
- Danger zone

## Organization Page

Platform admin:

- can list and open all organizations,
- can create/edit organizations,
- can edit seat limit,
- can manage domains and self-signup policy,
- can manage invites and users.

Organization admin:

- sees only their organization,
- can manage domains and invite/user policy,
- sees seat usage and seat limit,
- cannot edit seat limit.

## Save Model

Form edits are not saved automatically. If a view has Save, input/select/checkbox/toggle changes create local dirty state and persist only when Save is clicked.

This applies to:

- user profile fields,
- membership role/status fields,
- platform admin flag,
- managed-AI access form,
- organization name/slug,
- seat limit,
- domain settings,
- self-signup policy,
- future alert-recipient settings.

UI must show dirty state, disable Save when unchanged, provide Cancel or Discard, preserve edits on failed Save, and refresh from backend on successful Save.

Explicit command actions can execute immediately because the button itself is the confirmation:

- Invite user
- Resend invite
- Revoke invite
- Disable user
- Enable user
- Remove from organization
- Delete user
- Acknowledge alert
- Resolve alert
- Drain credential
- Rotate credential
- Revoke credential
- Delete credential

Use confirmation dialogs for destructive or high-risk command actions.

## Usage Page

The Usage page should become an operator overview before it becomes a diagnostic report.

Top-level Capacity Overview:

- overall Codex pool state: healthy, warning, or critical,
- number of usable Codex credentials,
- number of exhausted, unavailable, unhealthy, draining, or revoked credentials,
- active sessions,
- active users and organizations using the pool,
- next recommended action.

Add Codex Capacity cards:

- 5h capacity remaining,
- weekly capacity remaining.

Each capacity card should show:

- aggregate used and remaining capacity across measurable functional credentials,
- percent used and percent remaining,
- number of credentials included,
- number of functional credentials with unknown capacity,
- limit telemetry state: current, stale, or unavailable,
- last successful Codex limit read time when known,
- nearest reset time.

Credentials with unknown limits should not be included in the percentage denominator. Show them separately as functional but unknown capacity, so the percentage is not falsely optimistic.

If the server cannot read Codex limits at all, that is not the same as a credential with unknown capacity. The Usage page should show the pool capacity state as unavailable, keep the last successful snapshot visible if one exists, and make the loss of limit telemetry the top recommended action.

Credential drill-down rows should show:

- eligibility state,
- 5h used/remaining/reset,
- weekly used/remaining/reset,
- active leases,
- total recorded tokens,
- cached tokens,
- last status check,
- reason if excluded from pool math.

## Alert Policy

Alerts must be persistent, deduplicated, and audited. They should not be only a live view over credential health events.

Pool threshold alerts:

- warning at 80 percent used capacity for functional measurable credentials,
- critical at 90 percent used capacity,
- critical exhausted alert at 100 percent used capacity,
- thresholds apply separately to 5h and weekly windows,
- critical when the server cannot read Codex limits for the pool,
- critical when every automatically usable Codex credential is exhausted or unavailable for routing.

The 100 percent alert is a separate, worsening state from the 90 percent alert. It must create or update a distinct alert key and trigger immediate admin email delivery.

The Codex limit visibility alert is also separate from normal unknown-capacity credentials. It should fire when the gateway cannot access the Codex limit source for the pool, or when all functional credentials fail limit refresh because the limit source is unavailable. It should include the last successful read time, failure reason when safe to expose, and whether routing is continuing with stale or unknown capacity data.

Credential alerts:

- warning when a credential approaches 5h or weekly limit,
- critical when a credential is exhausted,
- high or critical for invalid grant, revoked token, auth failure, or permanent credential failure,
- medium/high for repeated upstream degradation, retry churn, or failover churn.

Alert state:

- active
- acknowledged
- resolved

Acknowledge records that an admin saw the alert. It must not suppress new worsening. Resolve happens when the state actually recovers or an admin explicitly resolves it. A later worsening reopens or updates the alert.

Alert keys should be stable, such as:

- `capacity.codex.pool.5h.warning`
- `capacity.codex.pool.weekly.critical`
- `capacity.codex.pool.5h.exhausted`
- `capacity.codex.pool.weekly.exhausted`
- `capacity.codex.limits.unavailable`
- `capacity.codex.credential.<credentialId>.5h.warning`
- `credential.<credentialId>.auth.invalid_grant`

## Alert Email

Send email at least for:

- critical credential alerts,
- critical pool exhausted alerts,
- critical Codex limit visibility alerts,
- warning alerts that remain active long enough or worsen,
- invalid grant, revoked token, and other auth failures.

Recipients:

- platform admins by default,
- optional explicit recipients later,
- not organization admins for managed-AI pool alerts.

Email content:

- alert severity and title,
- affected pool or credential,
- impacted users, orgs, and sessions when known,
- 5h and weekly capacity summary,
- credential breakdown with each credential's state and capacity,
- reset times,
- admin link to the relevant detail,
- recommended next action.

For 100 percent exhausted capacity and Codex limit visibility failures, send an expanded high-priority email immediately. It should be deliberately hard to miss: urgent subject, top summary, current routing impact, 5h and weekly pool status, every credential's state and limit capacity when known, unknown or stale credentials, last successful limit read, current failure reason when safe, and the recommended recovery action.

Store delivery attempts with at least pending/sent/failed state, timestamp, recipient, and error detail.

## Error Handling

Core errors:

- `seat_limit_reached`
- `domain_not_allowed`
- `domain_already_claimed`
- `last_platform_admin_required`
- `organization_forbidden`
- `platform_admin_required`
- `stale_update`
- `alert_email_failed`
- `capacity_unknown`
- `codex_limits_unavailable`

On Save errors, keep the form open and preserve unsaved changes. On command action errors, do not mutate local UI state and show the reason.

## Testing Strategy

Prefer E2E tests where the behavior is user-facing.

Required coverage:

- desktop/admin runtime E2E for platform admin seeing all sections,
- desktop/admin runtime E2E for organization admin seeing only Users and Organization,
- E2E or focused browser/admin test for Save-only behavior,
- E2E or integration coverage for enabled-domain self-signup and invite-only domains,
- API/integration tests for route permissions and scoped organization access,
- API/integration tests for seat limit enforcement,
- API/integration tests for last-platform-admin guard,
- repository/policy tests for domain matching and invite activation,
- repository/policy tests for 80/90/100 percent capacity thresholds,
- repository/policy tests for Codex limit visibility failure alerts,
- repository/policy tests for alert dedupe and status transitions,
- email tests for alert delivery attempts, credential breakdown payloads, 100 percent capacity emails, and Codex limit visibility failure emails,
- usage read-model tests for 5h/weekly remaining capacity and unknown-capacity handling.

Implementation that changes durable behavior must also update canonical docs in `docs/dev/` or `docs/features/`.

## Non-Goals

- Do not create a second admin application outside `ai.veslo.work/admin`.
- Do not make organization admins see managed-AI credentials, global usage, alerts, sessions, or audit.
- Do not use pending approval as the default domain-signup model.
- Do not autosave form fields.
- Do not duplicate DEN-owned organization data into the AI Gateway database.
