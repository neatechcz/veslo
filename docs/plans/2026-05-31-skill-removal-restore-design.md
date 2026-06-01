# Skill Removal and Restore Design

## Context

The Skills inventory already sees user-level skills and workspace-local skills
across local workspaces, but mutation actions still assume the active workspace
is the only writable target. That blocks removal for user skills and for
workspace skills whose workspace is not active.

Organization skills add a second dimension: for registry-managed skills, the
local materialized directory is not the source of truth. Removing a managed
skill must change the registry installation or distribution rule, then let local
materialization sync the runtime files.

## Goals

- Remove user skills without requiring an active workspace.
- Remove workspace skills from any known local workspace, not only the active
  workspace.
- Let organization owners remove organization-managed skills and distributions.
- Make every removal auditable and restorable.
- Restore the most recent removed version to the same target by default.
- Keep the Tauri desktop app and local Veslo server as the runtime under test.

## Non-goals

- Permanently delete immutable skill package versions from the registry.
- Allow normal users to remove locked organization or platform policies.
- Turn cloud registry into the execution environment.
- Build a marketplace or entitlement model.

## Recommendation

Use a registry-first remove/restore model for managed skills and a local
snapshot journal for unmanaged filesystem skills.

"Remove" should mean "remove this installation or distribution from this
target", not "destroy all historical skill data". The registry keeps immutable
versions and installation history. Local unmanaged skills are copied into a
recoverable Veslo-owned snapshot before their runtime directory is removed.

## Scopes

### User Skill

A user skill lives in a user-global skill root and is available across
workspaces through user scope. Removing it removes the user-global installation
from the runtime. Restore recreates it in the same user-global root from the
last captured snapshot or registry installation.

### Workspace Skill

A workspace skill belongs to one workspace. The UI targets the workspace id and
path carried by the selected inventory instance, not the active workspace. If
the workspace is local and authorized, remove and restore can run even while a
different workspace is active.

### Organization Skill

An organization skill is registry-owned. Organization owners/admins can remove
the org installation or disable the org rollout policy that distributes it.
Locked policies remain blocked. Restore re-enables/restores the same registry
object and version, then syncs materialization.

## Data Model

Extend the inventory instance model with lifecycle and registry metadata:

- `lifecycle`: `active` or `removed`
- `removedAt`, `removedBy`, and optional `removeReason`
- `registry.skillId`
- `registry.installationId`
- `registry.policyId`
- `registry.versionId`
- `registry.packageSha256`
- `registry.source`: personal, workspace, organization, or platform
- `registry.removalPolicy`: user-removable, admin-removable, or locked
- `restoreTarget`: the original user, workspace, or organization target

User and workspace filesystem skills should also get a local removal record:

- removal id
- skill name
- source scope
- source root and entry path
- workspace id when applicable
- package hash or directory hash
- snapshot directory/archive path
- actor id and display label when available
- removed timestamp
- optional reason

The local removal record should live under the Veslo data directory, not inside
the workspace, so it remains available after workspace file changes.

## API Behavior

### Local Unmanaged Skills

Existing local delete paths should become recoverable:

1. Validate the selected instance path is inside the expected skill root.
2. Snapshot the whole skill directory into the local removal journal.
3. Write an audit event with actor, target, hash, timestamp, and reason.
4. Remove the runtime skill directory.
5. Emit reload-required only for the affected active runtime.

Restore reads the removal record, verifies the destination is still authorized,
and writes the snapshot back. If a skill with the same name already exists, the
restore flow should stop and ask the user to overwrite or keep both.

### Registry Installations

For managed personal/workspace/org installations, call the registry proxy:

- remove: `DELETE /v1/skill-installations/:installationId`
- restore: `POST /v1/skill-installations/:installationId/restore`

The registry remains responsible for authorization, soft deletion, audit
events, and returning deleted installations when requested. The app should pass
Den token, org id, and user id headers through the local server proxy.

### Organization Rollout Policies

For organization rollout policies, the primary UI action should disable the
policy instead of physically deleting it:

- remove distribution: `PATCH /v1/skill-rollout-policies/:policyId` with
  `enabled: false`
- restore distribution: `PATCH /v1/skill-rollout-policies/:policyId` with
  `enabled: true`

This keeps restore possible with the current API shape. A hard delete route can
remain available for admin cleanup only if the registry stores a restorable
tombstone and exposes it back to the UI.

## UI Design

### Inventory

The default inventory shows active skills. Add a visible `Removed` filter or a
`Restore skills` action near the inventory filters. Turning it on includes
removed user, workspace, and organization entries.

Removed rows should be visually quiet but obvious:

- muted text
- "Removed" status badge
- original scope and target label
- restore action instead of remove action

### Detail Drawer

The Locations tab should become the main place to act on exact targets. Each
location row can expose:

- Remove from user skills
- Remove from this workspace
- Remove from organization
- Restore to user skills
- Restore to workspace
- Restore organization distribution

The overview-level destructive button can stay, but it must act on the selected
location only. For skills with multiple locations, the UI should require a
location choice.

### Restore Skills View

`Restore skills` opens a focused view or modal with tabs:

- User
- Workspaces
- Organization

Each row shows:

- skill name
- removed scope and target
- version
- package hash
- who removed it
- when it was removed
- restore button

By default restore uses the last removed version. Version history can still
allow restoring an older approved version when registry metadata is available.

### Confirmation

Every remove confirmation should explain the impact:

- user removal affects all workspaces using the user skill
- workspace removal affects only the selected workspace
- organization removal affects all users/workspaces reached by that org
  installation or rollout

The dialog can include an optional reason field. The reason goes to audit and
restore history.

## Error Handling

- Hide remove for entries that are definitely not removable.
- Disable with a reason only for temporary blocks, such as in-flight requests or
  missing connection.
- Block locked policies with a clear organization policy message.
- If restore destination has a name conflict, do not overwrite silently.
- If registry restore succeeds but local materialization sync fails, show the
  registry state as restored and leave a sync/reload-required message.
- If local snapshot restore fails halfway, keep the removal record so retry is
  possible.

## Sync and Reload

After remove or restore:

- refresh app-wide skill inventory
- refresh registry metadata when the target is managed
- run materialization sync for user-global or workspace managed skills when safe
- mark reload required for the active runtime only when the active runtime is
  affected
- do not require switching to the target workspace just to remove or restore

## Authorization

- User-global local skills: current desktop user.
- Workspace-local skills: known local workspace path and authorized root.
- Organization skills: Den auth must identify an organization owner/admin, and
  the registry must enforce this before accepting mutation.
- Locked organization/platform policies: blocked for normal organization-owner
  removal unless a higher admin path explicitly permits it.

## Testing Strategy

Prefer desktop E2E for the primary workflows:

- remove a user skill and restore it without changing workspace
- remove a workspace skill from a non-active local workspace and restore it
- organization owner removes and restores an organization installation/policy
- locked organization policy is visible as non-removable

Support with focused lower-level tests where E2E would be brittle:

- inventory builds active and removed instances with lifecycle metadata
- mutation target resolution uses target workspace id, not active workspace id
- local remove writes snapshot/audit before deleting runtime files
- registry remove/restore proxies send Den context headers
- rollout remove uses disable/enable rather than hard delete in normal UI

## Documentation Updates

After implementation, update the durable feature documentation for skill
registry and distribution to describe removal, restore, audit, and organization
owner behavior. If local removal journal paths become part of the developer
contract, document them in the state/config reference.
