# Skill Registry and Distribution

The skill registry is Veslo's cloud-backed catalog for distributing skill packages across personal, workspace, organization, and platform scopes. Local Veslo server remains responsible for installing packages into runtime skill roots and for triggering any workspace reload needed after install, update, disable, or removal.

## Model

Registry skill records describe identity and governance:

- id, slug, display name, description, and tags
- visibility: `personal`, `workspace`, `organization`, or `platform`
- review status: `draft`, `pending_review`, `approved`, or `rejected`
- latest version summary when a visible version exists

Registry package versions are immutable. Each version points to a package archive whose manifest follows the Veslo skill package model: schema version 1, `SKILL.md` entrypoint, normalized file paths, file digests, metadata, and package digest. The registry can store and serve package bytes, but the local server validates the manifest before using an archive.

Catalog source and install target are separate concepts. Catalog source
describes governance and visibility: personal, organization, or platform.
Install target describes where the package is materialized locally: user skill
root or a specific workspace. An organization skill remains organization-owned
when installed as a user skill, and a platform skill remains platform-owned when
installed into selected workspaces.

Installations and rollout policies connect a skill version to a target:

- personal installations apply to the signed-in user
- workspace installations apply to one workspace
- organization installations define org-managed availability or default rollout
- rollout policies define default distribution without creating per-recipient
  rows up front

Workspace skill sets represent the effective, reconciled registry-backed skills for a workspace. They contain at most one installation per `skillId` and are separate from locally discovered `.opencode/skills/` inventory rows, though applying a workspace skill set ultimately materializes local runtime skill files through Veslo server.

A rollout policy can target either `user-global` or `workspace`, never both for
the same effective audience and skill. Changing between those targets is a
retarget or move operation, not a second parallel installation. Selected
workspace installs can have one policy row per workspace because they share the
same target type.

Rollout policies can be `user_removable`, `admin_removable`, or `locked`.
Locked policies are reserved for required system or office-style skills. They
must be enforced by API and UI as non-removable for normal users, but they
remain data-driven rather than hardcoded in the app.

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
- `GET /v1/skill-rollout-policies`
- `POST /v1/skill-rollout-policies`
- `PATCH /v1/skill-rollout-policies/:policyId`
- `DELETE /v1/skill-rollout-policies/:policyId`
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

Org skill admins can manage organization-scoped skills, review requests, approvals, rejections, restores, org installations, and organization rollout policies.

Platform admins can manage platform-scoped skills, platform rollout policies, and moderate registry state across tenants.

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

The local Veslo server materializes server-controlled workspace skills into `.opencode/skills/veslo-managed/` and records both a root manifest and per-skill ownership markers. Server-controlled replacements and removals create pre-change backups under the Veslo data directory. Existing user skill directories are never overwritten by registry sync unless the user explicitly installs the registry-backed version into a server-controlled target.

Registry search can be reached through the local server at `/v1/skills/search` when the desktop app needs server-side registry auth and validation. Registry update polling can be reached through `/v1/skill-registry-events`; app clients should invalidate inventory for all visible events, mark active workspace updates as pending reload, and materialize idle workspace or personal-global updates through the local server. Workspace runtime sync uses `/workspace/:id/skills/materialization`; personal-global sync uses `/skills/materialization`. Registry writes are proxied through local host or owner-authenticated routes for skill creation, immutable version publishing, installation create/update/delete/restore, rollout policy create/update/delete, review request create/approve/reject, and workspace skill-set replacement. Filesystem materialization writes require host or owner auth and active runs should return a pending reload state instead of mutating files.

Rollout policy events are registry events. A user-global rollout can be
materialized by `/skills/materialization/sync-global`; a selected-workspace
rollout can be materialized by `/workspace/:id/skills/materialization/sync`.
When both target types are active for the same effective skill/audience because
of legacy data or a race, the resolver and materialization sync response must
return a target conflict and avoid materializing both variants.

Registry search is server-side. The registry indexes package metadata plus searchable text/code files under the configured size limit. Query handling can expand localized terms, starting with Czech-to-English skill discovery terms such as meeting-minutes searches, so the app should pass the UI language instead of trying to implement semantic search locally.

The local Skills UI can show filterable inventory rows, bulk selection, detail tabs, locations, version history, and review evidence using local inventory plus registry metadata when available. Clicking an inventory card or row toggles its bulk selection state; the skill detail drawer opens from the row edit affordance so selection and inspection remain separate. Detail drawer tabs, location labels, version history, action labels, unavailable reasons, and review text are resolved through runtime localization. Local copy and move actions transfer writable local workspace skills into the user skill root, including homogeneous selections from more than one local workspace. A user skill can also be installed into a selected local workspace, which creates a workspace-local copy without removing the user-skill source. In the default all-scope inventory view, a skill that has both a user-global instance and workspace-local copies is shown once in the all-workspaces group; the workspace copies remain available through workspace scope filtering and the location-aware detail actions. Private app-created workspaces may appear in the workspace-skill inventory when they already contain skills, but they are not valid install targets and must be omitted from install target pickers. The bulk toolbar should show the same transfer actions that are relevant to the selected inventory scope: user-skill selections can install to workspace through the workspace picker, workspace-skill selections can copy or move to user skills, and mixed user/workspace selections should not expose transfer actions. Registry-backed install and publish preparation packages a local skill and submits the registry create-skill, create-version, and create-installation sequence through the local server while leaving existing filesystem files in place until materialization policy explicitly installs the registry-backed version. Registry actions beyond local install preparation should call the local proxy only when the UI has concrete registry ids for the selected version, installation, review request, or workspace skill-set change, then refresh registry metadata and local inventory after success.

Local workspace and user skills can be removed from the global Skills inventory when the target path is known and writable, including local workspace skills from a non-active workspace. Removal is recoverable: Veslo server snapshots the skill directory, removes the original directory, and stores a removal journal record under the Veslo data directory. The removed/deleted skills filter shows journaled removals with restore actions. Restoring a local removal copies the verified snapshot back to its original location and marks the removal record restored. Bulk removal uses the server-backed `POST /skills/batch-remove` route so mixed selections can return per-item success and failure details without the app guessing which backend mutation path applies.

Organization-managed and other registry-managed skills are removed and restored through registry state, not by directly deleting local materialized files. Installation-backed removals call the registry installation delete/restore routes. Rollout-backed removals disable or re-enable the rollout policy. After a registry-managed removal or restore succeeds, the app asks the local server to resync the affected personal-global or workspace materialization before refreshing registry metadata and local inventory, so server-controlled skill files do not stay stale. Locked policies are not removable by normal users, and organization-owned mutations require the appropriate organization-owner or skill-admin permissions enforced by the registry/local proxy path.

## Skill Detail Actions

The detail drawer action bar operates on the selected skill location unless a location row in the Locations tab provides a more specific source location.

- Edit opens the skill editor for the exact writable skill location in the active workspace. It is unavailable for user-skill, server-controlled, read-only, or non-active-workspace locations until those mutation paths are explicitly supported.
- Copy to user skills copies a writable local workspace skill into the user skill root so it becomes available across workspaces. The workspace-local source remains in place.
- Move to user skills performs the same user-skill copy, then removes the original workspace-local source. If removal fails, the operation reports the failure instead of silently hiding it.
- Install to workspace copies a user skill into a selected local workspace skill root. The user-skill source remains installed and available across workspaces. Private app-created workspaces are excluded from the target picker.
- Remove deletes the exact writable local skill location through Veslo server and records a recoverable removal. User skills and writable local workspace skills can be removed from inventory when their concrete path is available; read-only and locked managed locations stay unavailable.
- Publish to organization opens a review request for publishing the current skill version into an organization catalog. This is a registry governance action and does not change the local runtime until a later installation or workspace skill-set sync applies it.
- Request system catalog approval opens a review request for platform-level approval before the current skill version can be distributed through the system catalog. The approval is for catalog distribution, not for local use of the skill.
- Restore restores a local removal from the server journal, restores a deleted registry installation, or re-enables an available rollout policy, depending on the selected location context. The UI must refresh local inventory, registry metadata, or both before presenting the updated state.

Unavailable actions should be hidden when the app can determine that the selected location cannot support the operation. A visible action may be disabled only when it is relevant to the selected location but temporarily blocked, for example by an in-flight request.

Registry distribution does not make cloud the execution environment. The Tauri desktop app and local Veslo server remain the runtime under test; the cloud registry owns catalog, package, review, and installation metadata.

Future marketplace behavior should sit above catalog identity and rollout
policy. Pricing, listing, ratings, purchases, and entitlements are not part of
the current runtime install model.
