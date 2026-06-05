# Registry-Aware Skill Creator Design

## Goal

Update Veslo's skill-creator guidance so it creates skills through the real Veslo
skill model instead of assuming every new skill belongs only to the active
workspace.

The skill-creator must know the product scopes users see: user skill, workspace
skill, organization skill, and public skill. It must also know the API scopes
used by Veslo: `user`, `workspace`, `org`, and `system`.

## Problem

The existing skill-creator guidance is workspace-first. That is no longer enough
for the current product model. Veslo now separates local runtime files from the
cloud-backed skill registry, package versions, installations, review requests,
workspace skill sets, rollout policies, and local materialization.

The skill-creator should not invent a simplified workflow. It should describe
what the app can really do today and choose the right path for the requested
scope.

## Product Terms And API Mapping

Use product terms in user-facing text:

- User skill: available to the current user across workspaces.
- Workspace skill: available in one workspace.
- Organization skill: owned by an organization catalog.
- Public skill: available through the platform/system catalog.

Use API scopes only when describing or calling the API:

- User skill -> `scope: "user"` / registry visibility `personal`
- Workspace skill -> `scope: "workspace"` / registry visibility `workspace`
- Organization skill -> `scope: "org"` / registry visibility `organization`
- Public skill -> `scope: "system"` / registry visibility `platform`

Public/platform skills are not simply public files. They are system-scoped
registry records with immutable package versions and platform-admin-controlled
approval and rollout.

## Scope Gate

Before creating or updating a skill, the skill-creator must determine the target
scope.

If the user did not explicitly choose a scope, ask exactly one question and wait:

> Where should this skill live: user skill, workspace skill, organization skill,
> or public skill?

Do not assume workspace scope.

## Shared Authoring Workflow

All scopes share the same authoring path:

1. Understand the skill with concrete user prompts and success criteria.
2. Design the skill directory as a complete package, not only a pasted
   `SKILL.md` body.
3. Create or update the skill directory with `SKILL.md` and optional
   `scripts/`, `references/`, and `assets/`.
4. Validate the skill metadata, trigger description, and bundled resources.
5. Package the complete skill directory into a registry package archive before
   any registry publish/install workflow.

The scope changes only the publish, install, approval, and materialization steps.

## Scope Workflows

### User Skill

Use this when the skill should be available across the current user's
workspaces.

1. Create or update a package-ready skill directory.
2. Create a registry skill with `scope: "user"`.
3. Create a package version.
4. Create a skill installation with `scope: "user"`.
5. Trigger or report user-skill materialization and any required reload.

The skill-creator may report the skill as installed only after the registry
installation succeeds or the local fallback path clearly succeeds.

### Workspace Skill

Use this when the skill should apply only to one workspace.

1. Create or update a package-ready skill directory.
2. Create a registry skill with `scope: "workspace"` and `workspaceId`.
3. Create a package version.
4. Create a workspace installation or update the workspace skill set.
5. Trigger or report workspace materialization and any required reload.

Private app-created workspaces are not valid install targets unless the product
explicitly allows that target in the picker/API context.

### Organization Skill

Use this when the skill should be owned by an organization catalog.

1. Create or update a package-ready skill directory.
2. Create a registry skill with `scope: "org"` and `orgId`.
3. Create a package version.
4. Create a review request with `scope: "org"`.
5. Report pending organization approval.

Do not claim the skill is distributed or runtime-installed until approval and a
separate installation, rollout policy, or workspace skill-set sync applies it.

### Public Skill

Use this when the skill should be published through the platform/system catalog.

1. Create or update a package-ready skill directory.
2. Create a registry skill with `scope: "system"`.
3. Create a package version.
4. Create a review request with `scope: "system"`.
5. Report pending platform approval.

This path requires platform-admin authority for system skill creation, approval,
and platform rollout management. Normal users should be told that the action is
blocked if the required platform permissions are unavailable.

## Public Skill Locking

Veslo can model a public skill that ordinary users cannot change:

- Package versions are immutable.
- `scope: "system"` skills require platform-admin authority for system-level
  mutation.
- Platform rollout policies can use `removalPolicy: "locked"` so normal users
  cannot remove the managed rollout.

This is not a "nobody can ever change it" guarantee. Platform admins can still
publish new versions or change platform rollout policy. A stronger sealed skill
state would be a separate product feature.

## Real API Surface

The skill-creator should describe these API operations as the real registry
workflow:

- `POST /v1/skills`
- `POST /v1/skills/:skillId/versions`
- `POST /v1/skill-installations`
- `PATCH /v1/workspaces/:workspaceId/skill-set`
- `POST /v1/skills/:skillId/review-requests`
- `POST /v1/skill-review-requests/:requestId/approve`
- `POST /v1/skill-rollout-policies`
- `POST /skills/materialization/sync-global`
- `POST /workspace/:id/skills/materialization/sync`

The local Veslo server proxies registry writes when registry configuration is
available. If registry configuration or required permissions are missing, the
skill-creator must report the block instead of pretending the skill was
published or installed.

## Single Skill Versus Multiple Skills

Keep one `skill-creator` entrypoint.

Separate user/workspace/organization/public skills would be overkill today
because most of the workflow is shared. The differences are scope, required
identifiers, approval requirements, and post-create API calls.

If the main skill becomes too long, move detailed scope-specific API workflows
into a reference file and keep `SKILL.md` as the router:

1. Ask for scope when missing.
2. Follow the shared authoring workflow.
3. Load the scope-specific reference only when needed.

## Non-Goals

- Do not implement a marketplace, pricing, ratings, purchases, or entitlement
  system.
- Do not treat cloud registry as the runtime executor.
- Do not replace local materialization and reload semantics.
- Do not create four separate public user-facing skills unless future workflow
  complexity proves the shared workflow is too large.

## Success Criteria

- The skill-creator never assumes workspace scope when scope is missing.
- User-facing output uses user/workspace/organization/public terminology.
- API-facing instructions use the real `user`/`workspace`/`org`/`system`
  scopes.
- Organization and public workflows produce review requests, not false claims of
  immediate distribution.
- Public/platform locking is described as immutable package versions plus locked
  rollout policy, with platform-admin authority still able to publish future
  versions.
