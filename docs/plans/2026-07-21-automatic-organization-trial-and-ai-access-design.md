# Automatic Organization Trial and AI Access

**Status:** Approved

**Date:** 2026-07-21

## Scope

This design changes only the cloud DEN service and the standalone AI Gateway, including the Gateway-hosted admin web. It does not change the installed Veslo application or the local Veslo server.

The goal is to make Managed AI available by default without exposing provider, credential, or model assignment as user administration.

## Product Rules

- Every newly created organization receives one 14-day Managed AI trial automatically.
- Organization members inherit the organization's current trial or paid entitlement.
- Adding a member never starts, resets, or extends the organization's trial.
- Existing organizations without billing configuration or billing history receive a one-time 14-day trial during rollout.
- Existing paid billing, an existing trial, an expired trial, an explicit revocation, or another administrator-managed billing state is never overwritten by automatic trial initialization.
- Every active user has AI Access enabled by default.
- A missing user AI Access record means the Gateway must create the default enabled access state automatically.
- An explicit administrator-disabled AI Access record remains disabled and is never re-enabled by automatic initialization.
- A platform administrator can enable or disable AI Access for an individual user as an exception.
- Models, providers, and credentials are not user-level choices.

## Ownership

DEN remains authoritative for organizations, memberships, billing, and trial entitlement. The AI Gateway remains authoritative for effective AI Access, platform model policy, provider credentials, routing, inference, usage, and AI audit events.

The global AI Infrastructure workspace continues to let platform administrators configure providers, credential pools, backend models, and the single active model. Removing technical choices from user administration does not remove those infrastructure controls.

## Automatic Organization Trial

When DEN creates a new organization, it initializes an organization billing account with a 14-day manual trial. Trial creation is idempotent and happens only when the organization has no existing billing state.

The rollout also performs an idempotent reconciliation for existing organizations. It creates a trial only for an organization with no billing account and no historical evidence that billing or a trial was previously configured. It does not modify any existing billing account, even when that account is inactive or expired. This protects administrator decisions and prevents expired trials from being restarted.

The trial belongs to the organization. Membership creation and activation only attach the user to that organization and never write the organization's billing expiry.

## Automatic User AI Access

The AI Gateway resolves user access using the following states:

1. An existing disabled record is an explicit deny and remains authoritative.
2. An existing enabled record is used, while technical routing details may be repaired automatically when infrastructure changes.
3. A missing record is initialized as enabled using the current global platform model policy and compatible platform infrastructure.

Automatic initialization is idempotent and concurrency-safe. It is used by authenticated self-access reads and inference authorization so self-signup, invited members, and administratively created users all receive the same behavior without requiring the installed app or local server to call a new API.

Provider and credential values may remain in internal persistence for routing, leasing, repair, usage attribution, and audit compatibility. They are server-derived state, not administrator input attached to a user. The provider comes from the globally active model. The Gateway selects a compatible healthy credential from the platform pool and may repair or rotate it later based on health and capacity.

Re-enabling an explicitly disabled user runs the same server-side resolution. The administrator submits only the desired enabled state.

## Admin API Contract

The organization-qualified user AI Access mutation accepts only the AI Access enabled state. Provider, credential, default model, allowed models, or other user-level routing fields are rejected rather than ignored.

The Gateway derives all technical assignment fields. This rule applies equally to platform administrators and organization administrators with the relevant permission.

Read responses may continue to include effective provider, model, or credential diagnostics where required for compatibility, but those values are read-only and must not be presented as user preferences.

Existing self-access and user-ID compatibility routes remain unchanged so the installed application and local Veslo server require no modification.

## Admin Web

Editing an existing organization member from the AI Access workspace shows only:

- an AI Access enabled/disabled switch;
- a platform administrator switch.

Only an existing platform administrator may change the platform administrator switch. Organization administrators cannot elevate users to platform administration.

The edit modal does not show name, email, organization selection, organization role, provider, credential, model, invitation controls, or unrelated user actions. User creation remains a separate workflow containing only the fields required to create and invite a user. Membership and organization role management remain in their dedicated organization workspace.

Saving the modal updates DEN-owned platform administration and Gateway-owned AI Access through their existing authorities. Partial failures are reported explicitly; the UI reloads authoritative state and never presents an unsuccessful combined save as complete.

## Runtime Flow

An inference request is evaluated in this order:

1. Authenticate the signed-in DEN user and organization context.
2. Check the DEN organization billing entitlement.
3. Load AI Access; preserve an explicit disable or automatically initialize a missing record.
4. Resolve the globally active model and its provider.
5. Select or repair a compatible healthy platform credential.
6. Route inference and record organization, user, credential, and model usage.

If no active model or compatible healthy credential exists, the user remains enabled but inference fails with an explicit infrastructure-unavailable response. The Gateway does not silently select another model and does not convert an infrastructure fault into a user-access denial.

## Migration and Rollout

The billing reconciliation and missing-access initialization are idempotent so restarts and concurrent requests cannot extend trials or create conflicting access state.

Rollout must preserve:

- existing billing accounts and historical trials;
- explicitly disabled AI Access records;
- existing user-ID compatibility routes;
- the global active-model authority;
- existing application and local server API contracts.

No destructive cleanup of historical user model or credential columns is part of this change.

## Verification

Automated verification must cover:

- a new organization receives exactly one 14-day trial;
- a new member inherits entitlement without changing expiry;
- existing unconfigured organizations receive one rollout trial;
- existing, expired, paid, revoked, or administrator-configured billing is unchanged;
- missing AI Access is initialized enabled;
- explicit disabled access remains disabled across reads and inference attempts;
- re-enabling derives routing from current infrastructure;
- provider, credential, and model fields are rejected from user mutations;
- missing model or credential is reported as infrastructure unavailable;
- the existing self-access and user-ID compatibility APIs remain compatible;
- the admin member modal contains only AI Access and platform-admin controls for edits;
- permission checks prevent organization administrators from changing platform-admin state;
- admin UI loading and save failures do not expose stale organization or user data.

Focused DEN and AI Gateway tests are followed by the repository quality gate. Browser-level admin UI verification exercises the rendered Gateway admin, while the installed Veslo application and local Veslo server remain untouched.

## Non-Goals

- Per-user, per-organization, or user-selectable model policy.
- Manual per-user provider or credential assignment.
- Extending a trial when a user joins an organization.
- Restarting an expired or revoked trial.
- Changing the installed Veslo application or local Veslo server.
