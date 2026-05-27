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

Organization-shared workspaces should commit `.opencode/veslo.skills.lock.json` when they opt into registry-backed skills. The lockfile records the resolved skill set identity, revision, installation ids, version ids, skill names, and package hashes. Managed package payloads should not be committed unless an organization explicitly chooses vendored skills for regulated or offline operation.

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
- `GET /v1/skill-registry-events`

## Authorization

Personal users can create personal skills, publish personal versions, install personal skills, search visible skills, and request broader review.

Workspace collaborators can read workspace skill sets. Workspace admins can patch workspace skill sets and manage workspace-targeted installations.

Org skill admins can manage organization-scoped skills, review requests, approvals, rejections, restores, and org installations.

Platform admins can manage platform-scoped skills and moderate registry state across tenants.

Registry event polling returns ordered mutation events visible to the caller and can be narrowed by org, workspace, cursor, and limit. Clients can use it as the baseline update transport until an SSE or WebSocket stream is available.

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

The local Veslo server materializes managed workspace skills into `.opencode/skills/veslo-managed/` and records both a root manifest and per-skill ownership markers. Managed replacements and removals create pre-change backups under the Veslo data directory. Unmanaged user skill directories are never overwritten by registry sync unless they have first been adopted into Veslo-managed ownership.

Registry search can be reached through the local server at `/v1/skills/search` when the desktop app needs server-side registry auth and validation. Registry update polling can be reached through `/v1/skill-registry-events`; app clients should invalidate inventory for all visible events, mark active workspace updates as pending reload, and materialize idle workspace or personal-global updates through the local server. Workspace runtime sync uses `/workspace/:id/skills/materialization`; personal-global sync uses `/skills/materialization`. Writes require host or owner auth and active runs should return a pending reload state instead of mutating files.

The local Skills UI can show filterable inventory rows, bulk selection, detail tabs, locations, version history, and review evidence using local inventory plus registry metadata when available. Clicking an inventory card or row toggles its bulk selection state; the skill detail drawer opens from the row edit affordance so selection and inspection remain separate. Detail drawer tabs, location labels, version history, action labels, disabled reasons, and review text are resolved through runtime localization. Local copy and move actions transfer an active workspace-local skill into the user-global skill root. Registry actions such as organization publish, system catalog approval, restore, and adoption require registry mutation routes; until those routes are connected, the UI must not synthesize registry writes from filesystem-only data. Local adoption preparation can package an unmanaged skill for registry upload, but registry-side version and installation creation remains backend-owned.

## Skill Detail Actions

The detail drawer action bar operates on the selected skill location unless a location row in the Locations tab provides a more specific source location.

- Edit opens the skill editor for the exact writable skill location in the active workspace. It is unavailable for global, managed, read-only, or non-active-workspace locations until those mutation paths are explicitly supported.
- Copy to global copies a writable skill from the active workspace into the user-global skill root so it becomes available in all workspaces. The workspace-local source remains in place.
- Move to global performs the same global copy, then deletes the original workspace-local source. If deletion fails, the operation reports the failure instead of silently hiding it.
- Delete removes the exact writable active-workspace skill location. Global, managed, read-only, and non-active-workspace delete paths remain disabled with a visible reason.
- Publish to organization opens a review request for publishing the current skill version into an organization catalog. This is a registry governance action and does not change the local runtime while registry mutation routes are disconnected.
- Request system catalog approval opens a review request for platform-level approval before the current skill version can be distributed through the system catalog. The approval is for catalog distribution, not for local use of the skill.
- Restore version is a registry-backed version action. It stays pending until registry version restore routes are connected.

Unavailable actions must be disabled or explain their unavailable state. They should not look clickable if the app can already determine that the selected location cannot support the operation.

Registry distribution does not make cloud the execution environment. The Tauri desktop app and local Veslo server remain the runtime under test; the cloud registry owns catalog, package, review, and installation metadata.
