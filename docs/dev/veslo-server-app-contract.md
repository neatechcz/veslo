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

## Workspace Scope

Many routes are workspace-scoped and should be called with an active workspace id.

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
