# Skill Rollout Policies Design

## Context

Veslo already has a cloud skill registry for personal, workspace, organization, and platform skills. The registry stores package identity, immutable versions, approvals, installations, workspace skill sets, materialization state, search documents, and audit events.

The missing piece is an explicit rollout model for cases where an approved organization or public/platform skill should be made available automatically. This must cover both existing recipients and future recipients without creating a backfill problem.

## Goals

- Let organization and public/platform skills be installed either as user-global skills or as workspace-targeted skills.
- Keep catalog governance separate from install target.
- Support "install for everyone" without exploding one admin action into installation rows for every user or workspace.
- Keep local materialization concrete and auditable.
- Prepare the data model for required, non-removable system skills.
- Avoid implementing marketplace behavior now while keeping the model compatible with it later.

## Non-Goals

- Implement marketplace listings, pricing, ratings, purchases, or entitlement flows.
- Add hardcoded required skill lists in the app.
- Make cloud execution authoritative. The desktop app and local Veslo server remain responsible for runtime materialization.

## Core Model

The model separates two axes:

- Catalog source: `personal`, `organization`, or `platform`.
- Install target: `user-global` or `workspace`.

Catalog source describes where the skill comes from and which governance rules apply. Install target describes where the package is materialized locally.

An organization skill remains an organization skill when installed as a user-global skill. A public/platform skill remains a public/platform skill when installed into a workspace. The install target must not change the catalog identity or approval scope.

## Rollout Policy

Add a registry-owned rollout policy concept next to existing installations. The rollout policy is the source of truth for automatic/default distribution. The local server still records concrete materialization state after a package is actually written to disk.

Suggested table:

```text
skill_rollout_policies
- id
- skill_id
- desired_version_id
- release_channel
- update_policy
- catalog_scope: organization | platform
- owner_org_id
- target: user-global | workspace
- audience: user | selected-workspaces | all-org-users | all-platform-users
- user_id
- workspace_id
- enabled
- removal_policy: user_removable | admin_removable | locked
- created_by_user_id
- deleted_at
- created_at
- updated_at
```

For selected workspace installs, prefer one row per workspace. This keeps audit, disable, conflict handling, and partial changes simple. Multiple workspace rows for the same skill are allowed because they share the same target type.

## User Flows

When a user installs a visible organization or platform skill as a user skill, the registry creates a policy or intent with `target=user-global` and `audience=user`. The local server materializes it into the user's global skill root during sync.

When a user installs a visible organization or platform skill into selected workspaces, the registry creates workspace-targeted policies for those workspace IDs. The local server materializes them into managed workspace skill directories during workspace sync.

When an organization admin installs an organization skill for everyone in the organization, the registry creates one `all-org-users` rollout policy instead of creating per-user installation rows. New organization members receive the skill automatically when their effective skill set is resolved.

When a platform admin installs a public/platform skill for everyone, the registry creates one `all-platform-users` rollout policy. Matching users receive the skill during normal sync.

## Target Exclusivity

A single effective actor or audience must not receive the same skill through both `user-global` and `workspace` targets at the same time.

Rules:

- A user's same skill cannot be active as both user-global and workspace-targeted across that user's workspaces.
- An organization-wide rollout for the same organization and skill cannot be active as both `all-org-users` and selected workspaces.
- A platform-wide rollout for the same skill cannot be active as both `all-platform-users` and workspace-targeted distribution.
- Multiple selected workspace policies for the same skill are allowed.
- Changing target is a move or retarget operation, not a parallel install.

If legacy data or a race creates both target types, the resolver must not materialize both. It returns a `target-conflict`, chooses the safer managed/admin/locked policy for effective output when needed, and marks the state as requiring administrative repair.

## Required Skills

Rollout policies include `removal_policy`.

- `user_removable`: normal install; the receiving user can remove it.
- `admin_removable`: managed install; only the owning organization or platform admin can remove it.
- `locked`: required install; normal users cannot disable, remove, or shadow it.

This prepares Veslo for future office/system skills without hardcoding them. Delete and disable APIs must check the policy that produced the effective install. A locked policy should produce a clear UI reason and a `removal_not_allowed` API response for unauthorized attempts.

## Effective Resolution

The effective skill set is computed from:

```text
explicit user choices
+ selected workspace choices
+ matching organization rollout policies
+ matching platform rollout policies
+ approval and version policy
= materialization plan
```

The resolver returns:

```text
effective skills
blocked skills
conflicts
required materializations
```

It must preserve the distinction between a user-chosen install and a managed organization/platform rollout so the UI can explain why a skill is present and who can remove or modify it.

## API

Add rollout policy routes to the registry and proxy them through the local Veslo server where the desktop app needs local auth and response validation:

```text
GET    /v1/skill-rollout-policies
POST   /v1/skill-rollout-policies
PATCH  /v1/skill-rollout-policies/:id
DELETE /v1/skill-rollout-policies/:id
```

The create and patch routes validate approval state, target exclusivity, audience scope, and caller permissions.

The delete route soft-deletes or disables a rollout policy. It must reject ordinary user deletion of `admin_removable` or `locked` policies.

## Runtime Behavior

The cloud registry stores rollout intent, audit, and version policy. The local Veslo server stores concrete materialization state for what has actually been written locally.

If an agent run is active, local materialization must not mutate files immediately. The app marks the update as pending and applies it after the run is idle or the workspace reloads.

If the device is offline, the local server continues using the last known lockfile and materialization state. New or changed rollout policies apply after the next successful registry sync.

## Marketplace Compatibility

Marketplace behavior is intentionally deferred. The rollout model should not assume that all skills are free, internal, or manually approved. Future marketplace listing, purchase, rating, and entitlement data should sit above catalog identity and rollout policy rather than changing local materialization semantics.

## Testing

- DB/schema test: rollout policy stores exactly one target type.
- API test: user-global and workspace targets conflict for the same skill and audience.
- API test: organization skills support either user-global or workspace target, but not both for the same audience.
- API test: platform skills support either user-global or workspace target, but not both for the same audience.
- API test: locked policy cannot be removed by a normal user.
- Resolver test: `all-org-users` applies only to members of that organization.
- Resolver test: selected workspace policy applies only to the chosen workspaces.
- Resolver test: a new user receives a matching rollout policy without backfill rows.
- Resolver test: locked policy cannot be shadowed.
- Desktop E2E: public skill installed as user-global appears across that user's workspaces.
- Desktop E2E: organization skill installed into selected workspaces appears only there.
- Desktop E2E: retargeting moves the skill without leaving parallel user-global and workspace installs.
