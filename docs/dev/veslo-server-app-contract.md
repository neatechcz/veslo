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
- capabilities discovery
- OpenCode and OpenCode Router proxying

The app should prefer these server surfaces over inventing parallel client-only behavior.

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
  Can review, approve, reject, publish, restore, and manage organization-scoped skills and installations for the org.
- Platform admin
  Can manage platform-scoped skills, approve platform distribution, moderate all review requests, and perform registry support actions across tenants.

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
- `PATCH /v1/workspaces/:workspaceId/skill-set`
  Requires host or owner auth. Replaces the desired registry-backed skill set for a workspace.

Server-controlled registry package materialization is a local server responsibility:

- `GET /skills/materialization`
  Requires client auth. Returns local server-controlled user skill materialization status.
- `POST /skills/materialization/sync-global`
  Requires host or owner auth. Downloads desired user-skill registry installations, validates package archives, writes server-controlled user skill directories, and returns `pending` without mutating files when the caller reports an active run.
- `GET /workspace/:id/skills/materialization`
  Requires client auth. Returns local server-controlled skill materialization status for the workspace.
- `POST /workspace/:id/skills/materialization/sync`
  Requires host or owner auth. Downloads the desired registry workspace skill set, validates package archives, writes server-controlled runtime skill directories, and returns `pending` without mutating files when the caller reports an active run.

## Workspace Scope

Many routes are workspace-scoped and should be called with an active workspace id. Desktop-launched local servers pass the app workspace id into the server process so app state, registry workspace skill-set sync, and `/workspace/:id/*` routes share the same identifier instead of falling back to a path-hash id.

Common app flows:

- `GET /workspaces`
  Discover available workspaces and active workspace.
- `GET /workspace/:id/config`
  Read workspace-scoped Veslo config.
- `PATCH /workspace/:id/config`
  Update workspace-scoped Veslo config such as reload settings.
- `POST /workspace/:id/engine/reload`
  Ask the engine to reread config for a workspace.

Use workspace-scoped URLs whenever possible, including the mounted `/w/:id/...` forms.

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

The app expects Veslo server to record config mutations and host-level actions into the audit trail.

Relevant route:

- `GET /workspace/:id/audit`

Settings developer tools surface this audit data directly. If you add a server-side mutation, ensure it is visible in audit when appropriate.

## Debug Log Ingest Contract

Veslo server exposes a host-token-protected ingest route the desktop shell uses to forward captured stdout/stderr from sidecars (and its own tracing) into the durable log pipeline.

Route:

- `POST /debug-logs` — auth: host (`x-veslo-host-token`). Body: `{ batchId: string, events: DebugLogEvent[] }` validated by `validateDebugLogBatch` in `debug-log-events.ts` (1–1000 events per batch). Success returns `202 Accepted` with `{ ok: true, acceptedBatchIds: [batchId] }`. Validation failures return `400 invalid_batch` with a list of issues.

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

- The endpoint accepts and persists batches even when remote ingest is disabled. With `VESLO_LOG_INGEST_URL`/`VESLO_LOG_INGEST_TOKEN` unset the server keeps events in a local spool; once both are set the uploader drains the spool on the next flush tick.
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
