# Skill Registry and Distribution

The skill registry is Veslo's cloud-backed catalog for distributing skill packages across personal, workspace, organization, and platform scopes. Local Veslo server remains responsible for installing packages into runtime skill roots and for triggering any workspace reload needed after install, update, disable, or removal.

## Model

Registry skill records describe identity and governance:

- id, slug, display name, description, and tags
- visibility: `personal`, `workspace`, `organization`, or `platform`
- review status: `draft`, `pending_review`, `approved`, or `rejected`
- latest version summary when a visible version exists

Registry package versions are immutable. Each version points to a package archive whose manifest follows the Veslo skill package model: schema version 1, `SKILL.md` entrypoint, normalized file paths, file digests, metadata, and package digest. The registry can store and serve package bytes, but the local server validates the manifest before using an archive.

Installations connect a skill version to a target:

- personal installations apply to the signed-in user
- workspace installations apply to one workspace
- organization installations define org-managed availability or default rollout

Workspace skill sets represent the effective, reconciled registry-backed skills for a workspace. They contain at most one installation per `skillId` and are separate from locally discovered `.opencode/skills/` inventory rows, though applying a workspace skill set ultimately materializes local runtime skill files through Veslo server.

## Registry API

The expected cloud registry routes are:

- `GET /v1/skills`
- `POST /v1/skills`
- `GET /v1/skills/:skillId`
- `POST /v1/skills/:skillId/versions`
- `GET /v1/skills/:skillId/versions`
- `GET /v1/skill-versions/:versionId/package`
- `POST /v1/skill-installations`
- `PATCH /v1/skill-installations/:installationId`
- `DELETE /v1/skill-installations/:installationId`
- `POST /v1/skill-installations/:installationId/restore`
- `GET /v1/workspaces/:workspaceId/skill-set`
- `PATCH /v1/workspaces/:workspaceId/skill-set`
- `POST /v1/skills/:skillId/review-requests`
- `POST /v1/skill-review-requests/:requestId/approve`
- `POST /v1/skill-review-requests/:requestId/reject`
- `GET /v1/skills/search`

## Authorization

Personal users can create personal skills, publish personal versions, install personal skills, search visible skills, and request broader review.

Workspace collaborators can read workspace skill sets. Workspace admins can patch workspace skill sets and manage workspace-targeted installations.

Org skill admins can manage organization-scoped skills, review requests, approvals, rejections, restores, and org installations.

Platform admins can manage platform-scoped skills and moderate registry state across tenants.

## Local Runtime Contract

The Veslo app should call the cloud registry for discovery, review, search, and desired skill-set sync. The local Veslo server should validate registry responses before installing or activating anything locally.

Local validators are intentionally narrow. They check only response shapes consumed by Veslo today:

- skill list and search responses
- skill detail responses
- version list responses
- package download responses
- installation responses
- workspace skill-set responses
- review request responses

Validators strip unneeded fields from typed results and reject invalid required fields. Package responses are additionally validated against the skill package manifest model and embedded file bytes so registry downloads stay compatible with local pack/unpack behavior.

## Runtime Semantics

Installing or updating a registry-backed skill should follow the same local safety rules as other skill changes:

- download and validate the package archive
- unpack through Veslo server-owned package install behavior
- write only inside the intended skill target
- refresh inventory after the local mutation
- trigger workspace reload when the effective runtime skill set changes

Registry distribution does not make cloud the execution environment. The Tauri desktop app and local Veslo server remain the runtime under test; the cloud registry owns catalog, package, review, and installation metadata.
