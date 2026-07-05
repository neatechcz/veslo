# Veslo Server App Contract

This document summarizes the app-facing contract between the Solid app and Veslo server.

For endpoint inventory, see `packages/server/README.md`. This file focuses on behavior that future app changes must preserve.

## Core Model

The app treats Veslo server as the canonical workspace-control API for:

- workspace-scoped config reads and writes
- plugin, MCP, skill, and command mutation
- audit trail
- import/export
- reload requests
- persistent automations and automation run history
- capabilities discovery
- OpenCode and OpenCode Router proxying

The app should prefer these server surfaces over inventing parallel client-only behavior.

## Frontend Client Module Contract

The app-facing TypeScript client lives behind the stable public barrel:

- `packages/app/src/app/lib/veslo-server.ts`
  Public export surface only. App code should keep importing `createVesloServerClient`, helper functions, `VesloServerError`, and public `Veslo*` types from this path.
- `packages/app/src/app/lib/veslo-server/client.ts`
  Composition shell for `createVesloServerClient`. It wires the domain facades, owns the compatibility flat aliases, and keeps `requestManagedAiAccessBundle` with the current small AI access surface.
- `packages/app/src/app/lib/veslo-server/types.ts`
  Public DTO/input/response types. Domain modules import shared types from this file, not from the public barrel.
- `packages/app/src/app/lib/veslo-server/connection.ts`
  URL normalization, local server URL derivation, session archive client option resolution, browser storage settings, invite links, and bundle links.
- `packages/app/src/app/lib/veslo-server/transport.ts`
  Shared request transport, auth/host/Den headers, Tauri fetch audit wrapping, multipart/binary helpers, and `VesloServerError`.
- `packages/app/src/app/lib/veslo-server-domains/*.ts`
  One UI-facing domain client facade per durable request boundary.

Current domain facades:

- `workspace.ts` for health/status/capabilities, workspace registry, config, reload, audit, import/export, provisioning, and scheduled jobs.
- `conversations.ts` for conversations, runs, transcript reads/prefetch/append, session archives, and session deletion.
- `files.ts` for inbox, file sessions, batch file ops, workspace file reads/writes, and artifacts.
- `skills.ts` for workspace skills, hub skills, user-global skill store, removals, enabled state, materialization, and registry operations.
- `soul.ts` for Soul overview, organization/user/workspace reads and writes, version restore, materialization sync, and workspace heartbeat toggle.
- `mcp.ts`, `plugins.ts`, `commands.ts`, `automations.ts`, and `messaging-identities.ts` for their matching server namespaces.
- `extensions-inventory.ts` as a read-only client aggregate over MCP, plugins, skills, and commands. It must not own mutations.

Compatibility rule:

- Existing flat methods such as `client.listWorkspaces()` and `client.listSkills()` remain available as aliases from the composition shell while new code may use domain entries such as `client.workspace.list()` and `client.skills.list()`.
- Do not add endpoint-specific methods directly to the public barrel. Add behavior to the appropriate domain facade, wire it in `client.ts`, and re-export only through the stable barrel when the public API needs it.
- Route/path tests should live near `src/app/tests/lib/veslo-server.test.ts`, `veslo-server-route-manifest-contract.test.ts`, `veslo-server-session-prefetch.test.ts`, or `veslo-server-modularization.test.ts` depending on the contract being changed.

## Resource Ownership Contract

App-facing inventory records for local MCP entries, skills, plugins, commands,
and Veslo-created user-global skills may include an `owner` envelope:

```ts
type ResourceOwner = {
  kind: "workspace" | "user" | "organization" | "platform";
  id: string;
  label?: string;
  root?: string;
};
```

`owner` identifies who owns the durable definition of the item. Existing
`scope` and `source` fields remain as legacy provenance and ordering metadata
during migration.

- Workspace-owned resources are definitions stored in workspace config or
  workspace-local files. Workspace routes should use the configured
  `workspace.id`; direct helper calls may fall back to a normalized root path.
- User-owned resources are definitions stored in user-global config/files or
  the Veslo user-global skill store. Local desktop without cloud identity uses
  the local user owner fallback.
- Organization and platform owners are reserved for registry-managed or
  policy-managed resources.
- For MCP, this owner is the config/listing owner only. MCP polling,
  connection state, OAuth grant ownership, and runtime refresh ownership remain
  separate concerns and must not be inferred from this field.

## Auth Model

There are two important auth classes:

- client bearer token
  Used for normal app connectivity and user-scoped access
- host or owner token
  Required for host-level mutations and OpenCode Router management

Important rule:

- `/opencode-router/health` accepts client auth
- other `/opencode-router/*` routes require host or owner auth

## Cloud Skill Registry Contract

The cloud skill registry is a distribution and governance service. It is not the runtime executor for local skills. Veslo desktop and Veslo server should use it to discover approved packages, download package archives, and sync desired workspace skill sets, then install or activate those packages through local server-controlled skill surfaces.

Expected registry routes:

- `GET /v1/skills`
  List skills visible to the caller. Supports filtering by owner scope, workspace, org, tag, review status, and pagination cursor.
- `POST /v1/skills`
  Create a skill record before uploading the first package version.
- `GET /v1/skills/:skillId`
  Read skill metadata and latest approved version summary.
- `POST /v1/skills/:skillId/versions`
  Publish a new package version for an existing skill.
- `GET /v1/skills/:skillId/versions`
  List package versions for a skill.
- `GET /v1/skill-versions/:versionId/package`
  Download the package archive for a concrete version. The response must validate against the local package manifest model.
- `POST /v1/skill-installations`
  Install a skill version for a personal, workspace, or organization target.
- `PATCH /v1/skill-installations/:installationId`
  Enable, disable, or move an installation to another version.
- `DELETE /v1/skill-installations/:installationId`
  Remove an installation from its target.
- `POST /v1/skill-installations/:installationId/restore`
  Restore a previously removed installation where audit and retention policy allow it.
- `GET /v1/skill-rollout-policies`
  List rollout policies visible to the caller. Policies describe default or explicit distribution intent without requiring one row per receiving user or workspace.
- `POST /v1/skill-rollout-policies`
  Create a rollout policy for an organization or platform skill. A policy targets either `user-global` or `workspace`, never both for the same skill and audience.
- `PATCH /v1/skill-rollout-policies/:policyId`
  Update enabled state, desired version policy, release channel, or removal policy where the caller has admin rights.
- `DELETE /v1/skill-rollout-policies/:policyId`
  Disable or soft-delete a rollout policy. `admin_removable` and `locked` policies reject ordinary user removal.
- `GET /v1/workspaces/:workspaceId/skill-set`
  Read the effective desired registry-backed skill set for a workspace.
- `PATCH /v1/workspaces/:workspaceId/skill-set`
  Replace or reconcile the desired registry-backed skill set for a workspace.
- `POST /v1/skills/:skillId/review-requests`
  Request approval for organization or platform distribution.
- `POST /v1/skill-review-requests/:requestId/approve`
  Approve a review request and make the requested scope/version available.
- `POST /v1/skill-review-requests/:requestId/reject`
  Reject a review request with reviewer rationale.
- `GET /v1/skills/search`
  Search visible skills by text query, tags, owner scope, review status, and package metadata.
- `GET /v1/skill-registry-events`
  Poll ordered registry mutation events visible to the caller. Supports org, workspace, cursor, and limit filters.

Auth scopes:

- Personal user
  Can create personal skills, publish personal versions, install personal skills, search visible personal/org/platform skills, and request review for broader distribution.
- Workspace collaborator/admin
  Can read workspace skill sets. Workspace admins can patch workspace skill sets and manage workspace-targeted installations.
- Org skill admin
  Can review, approve, reject, publish, restore, and manage organization-scoped skills, installations, and rollout policies for the org.
- Platform admin
  Can manage platform-scoped skills and rollout policies, approve platform distribution, moderate all review requests, and perform registry support actions across tenants.

Local contract validators live server-side and are intentionally narrow. They validate only registry response shapes consumed by the local Veslo server and app, including skill lists, skill detail, version lists, package downloads, installations, workspace skill sets, review responses, and search results. Package download validation delegates to the existing skill package manifest model so local install behavior stays aligned with pack/unpack.

Veslo server also exposes a local proxy for registry search, registry events, and registry writes. Read routes require client auth; mutation routes require host or owner auth and use server-side registry auth plus response validation:

- `GET /v1/skills/search`
  Requires client auth. Proxies configured registry search with server-side response validation. If no registry base URL is configured, returns an empty search result instead of treating the local runtime as failed.
- `GET /v1/skill-registry-events`
  Requires client auth. Proxies ordered registry mutation events with cursor, org, workspace, and limit filters. If no registry base URL is configured, returns an empty event page so the app can keep polling without surfacing a local runtime error.
- `POST /v1/skills`
  Requires host or owner auth. Proxies skill record creation with server-side registry auth and response validation.
- `POST /v1/skills/:skillId/versions`
  Requires host or owner auth. Proxies immutable package version creation for an existing registry skill.
- `GET /v1/skills/:skillId/versions`
  Requires client auth. Proxies version history lookup for a registry skill.
- `POST /v1/skills/:skillId/review-requests`
  Requires host or owner auth. Proxies publish or approval review request creation.
- `POST /v1/skill-review-requests/:requestId/approve`
  Requires host or owner auth. Proxies review approval decisions.
- `POST /v1/skill-review-requests/:requestId/reject`
  Requires host or owner auth. Proxies review rejection decisions.
- `POST /v1/skill-installations`
  Requires host or owner auth. Proxies installation creation for personal, workspace, organization, or platform targets.
- `PATCH /v1/skill-installations/:installationId`
  Requires host or owner auth. Proxies installation policy, desired version, release channel, or enabled-state updates.
- `DELETE /v1/skill-installations/:installationId`
  Requires host or owner auth. Proxies installation deletion.
- `POST /v1/skill-installations/:installationId/restore`
  Requires host or owner auth. Proxies restoration of a deleted installation.
- `GET /v1/skill-rollout-policies`
  Requires client auth. Proxies rollout policy lookup for the current registry context.
- `POST /v1/skill-rollout-policies`
  Requires host or owner auth. Proxies rollout policy creation for user-global or selected-workspace targets.
- `PATCH /v1/skill-rollout-policies/:policyId`
  Requires host or owner auth. Proxies rollout policy updates.
- `DELETE /v1/skill-rollout-policies/:policyId`
  Requires host or owner auth. Proxies rollout policy deletion or disablement.
- `PATCH /v1/workspaces/:workspaceId/skill-set`
  Requires host or owner auth. Replaces the desired registry-backed skill set for a workspace.

Organization and other managed skill removals stay on these registry mutation
surfaces. Installation-backed removals delete or restore the installation.
Rollout-backed removals disable or re-enable the rollout policy. Locked rollout
policies reject normal user removal, and organization-owned mutations require
organization-owner or skill-admin rights through the registry context.

Server-controlled registry package materialization is a local server responsibility:

- `GET /skills/materialization`
  Requires client auth. Returns local server-controlled user skill materialization status, including platform-managed desired state. When platform-managed skills are not yet materialized, the response is `pending` with `reloadRequired: true` even if no registry is configured.
- `POST /skills/materialization/sync-global`
  Requires host or owner auth. Materializes platform-managed personal-global skills even when no registry is configured. When registry is configured, also downloads desired user-skill registry installations and matching user-global rollout policies, validates package archives, writes server-controlled user skill directories, returns any resolver `conflicts`, and returns `pending` without mutating files when the caller reports an active run.
- `GET /workspace/:id/skills/materialization`
  Requires client auth. Returns local server-controlled skill materialization status for the workspace.
- `POST /workspace/:id/skills/materialization/sync`
  Requires host or owner auth. Downloads the desired registry workspace skill set and matching selected-workspace rollout policies, validates package archives, writes server-controlled runtime skill directories, returns any resolver `conflicts`, and returns `pending` without mutating files when the caller reports an active run.

Veslo-created user skills use a local server store separate from legacy
filesystem user skill roots:

- `GET /skills/user-global-store`
  Requires client auth. Returns store-backed user skills with virtual
  `veslo-user-store://<name>` paths.
- `GET /skills/user-global-store/:name`
  Requires client auth. Returns the normalized `SKILL.md` content for one
  store-backed user skill.
- `POST /skills/user-global-store`
  Requires collaborator client auth. Creates or updates one store-backed user
  skill in the Veslo data directory.
- `DELETE /skills/user-global-store/:name`
  Requires collaborator client auth. Deletes one store-backed user skill from
  the Veslo data directory.
- `POST /workspace/:id/skills/user-global-store/sync`
  Requires collaborator client auth plus host approval for the materialization
  path. Writes enabled store-backed user skills into
  `.opencode/skills/veslo-user/` for that workspace, removes stale managed
  copies, and returns conflicts instead of overwriting workspace-local skills.

Rollout policy resolution must enforce target exclusivity: the same effective
skill/audience cannot be materialized as both a user skill and a workspace skill.
If registry state contains both because of legacy data or a race, the server
returns a conflict and avoids writing both targets.

Veslo ships a platform-managed locked personal-global `veslo-automations` skill.
It is materialized under `veslo-managed` and teaches agents to use the Veslo
automation wrapper tools instead of writing external scheduler files. If an
unmanaged user-global skill with the same name already exists in any supported
global skill root, including an unmanaged directory under the target
`veslo-managed` root, sync rejects the materialization with a conflict instead
of creating an ambiguous duplicate.
Materialization entries include `source` and `removalPolicy`; the platform
automation skill is reported as `source: platform` and `removalPolicy: locked`.

## Skill Removal and Restore

Local filesystem skill removal is recoverable and server-backed. The app should
call these routes instead of deleting skill directories directly:

- `GET /skills/user-global/:name?path=...`
  Requires client or host auth. Reads an exact user-global skill path, including
  managed `veslo-managed` paths, without allowing mutation.
  User-global exact paths honor the same OpenCode global root precedence as
  materialization: `XDG_CONFIG_HOME/opencode/skills` when `XDG_CONFIG_HOME` is
  set, with the legacy HOME-based root still recognized for existing skills.

- `DELETE /workspace/:id/skills/:name`
  Requires collaborator client auth plus any host approval required for the
  target path. Removes a writable local workspace skill, including a concrete
  skill path discovered outside the active workspace when that workspace is
  configured and authorized. Returns `{ ok, name, path, removalId }`.
- `DELETE /skills/user-global/:name`
  Requires collaborator client auth. Removes a user skill by name and optional
  concrete path. Returns `{ ok, name, path, removalId, reloadRequired, trigger }`
  and emits skill reload events for configured workspaces.
- `POST /skills/batch-remove`
  Requires host auth. Accepts `{ items }` where each item is the same concrete
  target shape the app uses for skill inventory actions: `{ id?, name, scope,
  workspaceId?, path?, reason?, registry? }`. Workspace and user-skill items
  perform recoverable local removals; `registry.installationId` deletes that
  registry installation; `registry.policyId` disables that rollout policy.
  The route does not roll back partial failures. It returns
  `{ ok, succeeded, failed, results }`, with each result carrying either
  removal metadata or `{ ok: false, code, message, status }`.
- `GET /skill-removals`
  Requires collaborator-or-host access. Lists recoverable removals. Query
  parameters: `scope=workspace|user-global`, `workspaceId`, and
  `includeRestored=true`. Workspace listings are filtered to visible configured
  workspaces; user-skill listings require host or owner access.
- `POST /skill-removals/:id/restore`
  Requires host auth. Restores a journaled local skill removal after validating
  the journal record, authorized workspace roots for workspace removals,
  destination conflicts, and snapshot hash. Returns `{ ok, path, reloadRequired,
  trigger }`; workspace restores also write a `skills.restore` audit entry.

The app surfaces journaled removals in the deleted/removed skills view. A local
restore uses `restoreTarget.removalId`; a managed restore uses the registry
installation restore or rollout-policy enable route instead.

## Workspace Scope

Many routes are workspace-scoped and should be called with an active workspace id. Desktop-launched local servers pass the app workspace id into the server process so app state, registry workspace skill-set sync, and `/workspace/:id/*` routes share the same identifier instead of falling back to a path-hash id. A fresh desktop profile may restart the local server with no workspace paths at all; that is valid app-service startup and must not be treated as a missing-workspace error. When local workspace paths exist, the desktop app should pass the currently attached local workspace first and the remaining known local workspace paths after it, so a newly materialized private chat workspace is available to file-session and other workspace-scoped routes before the prompt handoff continues.

Common app flows:

- `GET /workspaces`
  Discover available workspaces and active workspace.
- `POST /workspaces/local`
  Register a desktop-local workspace with the server before workspace-scoped config, mutation, or OpenCode write flows depend on it.
- `DELETE /workspaces/:id`
  Remove a workspace from the server registry. The route must persist removal for both explicit-id entries and path-derived entries, and it must work even when the local workspace folder no longer exists on disk.
- `GET /workspace/:id/config`
  Read workspace-scoped Veslo config.
- `PATCH /workspace/:id/config`
  Update workspace-scoped Veslo config such as reload settings.
- `POST /workspace/:id/engine/reload`
  Ask the engine to reread config for a workspace.

Use workspace-scoped URLs whenever possible, including the mounted `/w/:id/...` forms.

### MCP Runtime Token Refresh

For Veslo-managed connector MCP entries, the app may call
`POST /workspace/:id/mcp/:name/runtime-token/refresh` after an
authorization-like MCP runtime status failure. The route requires the normal
client token plus Den context headers, looks up the named catalog item, fetches
a fresh connector runtime token from Den, and updates only the workspace
OpenCode MCP config header. It does not perform browser OAuth, does not revoke
provider grants, and must not be used for custom user-supplied MCP auth.

### Local Workspace Registration

For desktop-local workspaces, the app should preserve the raw platform path when registering the workspace and include current OpenCode routing metadata when available: `baseUrl`, `directory`, `opencodeUsername`, and `opencodePassword`. A duplicate `POST /workspaces/local` with updated OpenCode metadata may update the existing workspace registration instead of failing as a plain duplicate.

When a local workspace has no explicit OpenCode `baseUrl`, a desktop-launched server may derive the effective OpenCode base URL from its orchestrator daemon URL and the workspace id using the mounted workspace route: `{orchestratorDaemonUrl}/workspace/:id/opencode`. The app should still pass fresh engine metadata when it has it, because explicit routing data avoids stale path-only registrations.

Windows path checks must tolerate extended-length prefixes such as `\\?\` and compare normalized roots case-insensitively for authorization. The raw path should remain available for persistence and engine handoff; normalized paths are for comparison.

### Conversation and Transcript Reads

`GET /workspace/:id/conversations` is host-first by default. When the host
conversation store already has rows, the route returns those rows without
touching the sandbox or OpenCode database. App code may pass `sync=true` only
for a workspace whose engine is already warm or has an active run, including
ready or busy routed workspaces that are not the selected UI workspace. That
opt-in read unions the live source with host bindings and tunnels any missing
sessions back into the host store; it must not be used to cold-start another
workspace runtime.

`POST /workspace/:id/conversations/:conversationId/runs` is server-authoritative
for conversation run admission. A successful immediate submit returns
`status: "submitted"` with `runId`. If the orchestrator lifecycle reports an
active run for the conversation, the server persists the request in its durable
run queue and returns `status: "queued"` with `queueItemId`, `reservedRunId`,
`activeRunId`, and `queuePosition`. App clients must treat `queued` as an
accepted send, not as a failed send or transcript error. `run_already_active`
is an internal lifecycle lock signal and should not be surfaced as the normal
client-facing response for this route. The lifecycle active check is a
reconciled read, not a raw active-row lookup: if OpenCode reports the session
idle or the transcript probe shows a terminal assistant message, the
orchestrator completes the stale run before the server decides whether to
queue the new request.

Conversation run lifecycle orchestration is a server-owned control-plane
concern. The app talks to the conversation routes and should not duplicate
server decisions about active lifecycle locks, durable queued sends, OpenCode
submit/abort side effects, AI gateway provider-start watches, lifecycle
reconcile polling, transcript wake-up, or startup queue draining. The
orchestrator registry remains the source of truth for active run state; the
server lifecycle controller owns when to read it, register runs, schedule
reconcile, and wake the durable queue. The app's local UI queue remains a UI
workflow concern and is separate from the server durable run queue.

`POST /workspace/:id/sessions/:sessionId/transcript` persists live transcript
snapshots into the host store. `messages` plus `partsByMessageId` are the
current snapshot; callers may also send `deletedMessageIds` and
`deletedPartsByMessageId` so host-first transcript reads do not resurrect parts
or messages that the live stream removed. Callers may include a best-effort
`reason` such as `session.idle`. When the snapshot or reason indicates a
terminal turn, the server asks the orchestrator to reconcile the latest run and
wakes the durable run queue if that reconciliation reaches a terminal state.
The transcript request itself does not directly mark lifecycle rows terminal;
the orchestrator still verifies state against OpenCode first.

## Capability Discovery

The app relies on `/capabilities` and workspace capability data to decide whether a surface is:

- readable
- writable
- backed by Veslo server or OpenCode config
- backed by browser/file tools or sandbox support

When adding a new app surface, prefer extending capability reporting instead of hard-coding UI assumptions.

## Import and Export Contract

Current contract:

- `GET /workspace/:id/export`
  Export the current workspace profile
- `POST /workspace/:id/import`
  Import config content into the selected workspace

The app also supports bundle import flows through shared bundle URLs. The server remains the canonical target for applying imported content to a workspace.

## Audit Contract

The app expects Veslo server to record config mutations, host-level actions, and Soul source mutations into the audit trail.

Relevant route:

- `GET /workspace/:id/audit`

Settings developer tools surface this audit data directly. If you add a server-side mutation, ensure it is visible in audit when appropriate.

## Debug Log Ingest Contract

Veslo server exposes a host-token-protected ingest route the desktop shell uses to forward captured stdout/stderr from sidecars (and its own tracing) into the durable log pipeline.

Route:

- `POST /debug-logs` — auth: host (`x-veslo-host-token`). Body: `{ batchId: string, events: DebugLogEvent[] }` validated by `validateDebugLogBatch` in `debug-log-events.ts` (1–1000 events per batch). Success returns `202 Accepted` with `{ ok: true, acceptedBatchIds: [batchId], cloudUploadEnabled: boolean }`. When `cloudUploadEnabled` is true, the route has durably appended the batch before returning so the desktop may delete its local copy. When false, the desktop keeps or directly uploads eligible bootstrap/server-launch diagnostics. Validation failures return `400 invalid_batch` with a list of issues.

Event shape (single source of truth: `packages/server/src/debug-log-events.ts`):

```ts
interface DebugLogEvent {
  id: string;                                 // ≤ 128 chars
  userId: string;
  orgId: string;
  workspaceId: string;
  workerId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  source: string;                             // ≤ 64 chars, e.g. "orchestrator", "tauri-shell"
  stream: string;                             // ≤ 32 chars, e.g. "stdout", "stderr", "jsonl"
  level?: "info" | "warn" | "error" | null;
  timestamp: number;                          // UNIX nanos
  sequenceNo: number;                         // non-negative integer
  payload: Record<string, unknown>;
}
```

Behavior the desktop shell relies on:

- The endpoint reports whether veslo-server is configured as a cloud-capable carrier. With `VESLO_LOG_INGEST_URL`/`VESLO_LOG_INGEST_TOKEN` unset, the route returns `cloudUploadEnabled: false`; the desktop direct diagnostics fallback is responsible for eligible bootstrap/server-launch delivery after login.
- Server-originated events (`source: "veslo-server-self"` for logger output, `source: "audit"` for audit entries) join the same pipeline, so the desktop only needs to forward what it captures itself.
- Workspace/session/run identifiers are forwarded as-is. Server does not enrich them — the remote ingest (Den) is expected to derive any missing context from host token metadata.

See also `docs/dev/state-and-config-reference.md` for environment variables that control batch sizes, spool cap, and flush cadence.

## Reload Contract

Reload is an explicit server capability, not just a local app trick.

Key expectations:

- reload rereads config for the selected workspace
- reload may interrupt active sessions
- auto-reload is workspace-scoped and should respect idle-session safety

If reload behavior changes, update both server behavior and the app docs under `docs/features/workspace-config-and-sharing.md`.

## File and Artifact Contract

Veslo server also exposes:

- workspace artifact listing
- file sessions for batch read/write
- inbox uploads

The app should treat server-owned artifact provenance as canonical when available.

## App Development Rules

- Prefer server-backed mutation over direct local file writes when a Veslo server route already exists.
- If a UI change mutates `.opencode/` data, decide whether it should be expressed through the server API.
- When a route is missing but the behavior belongs in server-consumption mode, add the route rather than duplicating logic in the app.
