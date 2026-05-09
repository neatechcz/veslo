# VSLO-176 Den Debug Log Ingest Backend-First Design

**Date:** 2026-05-09
**Issue:** VSLO-176
**Scope:** Backend-first slice of Den debug-log ingest, encrypted storage, retention, and developer read APIs.

## Context

VSLO-176 is the Den/cloud half of the debug-log pipeline. The neighboring app-side cards are already implemented:

- VSLO-174 wires `veslo-server` debug-log spool, uploader, and local `POST /debug-logs`.
- VSLO-175 wires the Tauri forwarder that sends supervised process output into `veslo-server`.

The missing piece is Den accepting batches from `veslo-server`, storing payloads securely, and giving developers a controlled way to query the stored logs.

## Decision

Implement a backend-first slice now:

1. `POST /v1/internal/debug-logs` server-to-server ingest.
2. Dedicated Den DB tables for log events and idempotent batch tracking.
3. AES-GCM encrypted payload storage using Den env keys.
4. Thirty-day retention with purge support.
5. Platform-admin-only read APIs for search, row detail, and JSONL download.

The full static admin UI "Debug Logs" page remains out of scope for this slice. The API shape should make that UI straightforward to add later without changing ingest/storage behavior.

## Ingest Contract

Den should accept the already implemented `veslo-server` upload shape:

```ts
interface DebugLogUploadRequest {
  batchId: string;
  events: DebugLogEvent[];
}
```

`Idempotency-Key` is optional. If present, Den records it. If absent, Den uses `batchId` as the idempotency key.

Success response:

```ts
interface DebugLogUploadResponse {
  acceptedBatchIds: string[];
}
```

This matches `packages/server/src/debug-log-uploader.ts`, which treats a batch as confirmed when the response contains the submitted batch id.

The older VSLO-176 issue text mentions `{ batch: DebugLogEvent[] }`. This design does not make that the primary contract because the client side now sends `{ batchId, events }`. A compatibility parser may accept `{ batch }` only if it does not complicate validation, but it is not required for this backend-first slice.

## Auth

Ingest uses a dedicated internal bearer token:

- `DEN_LOG_INGEST_TOKEN`

Requests without `Authorization: Bearer <token>` return `401`. Requests with the wrong token return `403`. This route does not use user session auth.

Read APIs use the existing Den platform-admin session gate for this slice. The `debug-logs-reader` role from VSLO-176 is deferred because current Den role primitives are platform admin and org roles. A later ACL slice can add a dedicated role without changing storage.

## Environment

Add Den env parsing for:

- `DEN_LOG_INGEST_TOKEN`
- `DEN_LOG_MASTER_KEY`
- `DEN_LOG_MASTER_KEY_VERSION`
- `DEN_LOG_RETENTION_DAYS`, default `30`

When ingest is called, Den requires all three security values: ingest token, master key, and key version. Startup can allow missing values so local Den development remains possible when the feature is unused.

## Storage Model

Add `debug_log_event`.

Cleartext searchable fields:

- `id`
- `batch_id`
- `event_id`
- `created_at`
- `expires_at`
- `event_timestamp`
- `org_id`
- `user_id`
- `workspace_id`
- `worker_id`
- `session_id`
- `run_id`
- `source`
- `stream`
- `level`
- `sequence_no`
- `payload_sha256`
- `payload_bytes`
- `encryption_key_version`

Encrypted fields:

- `payload_ciphertext`
- `payload_iv`
- `payload_auth_tag`

Indexes:

- unique `(batch_id, event_id)` to prevent duplicate event rows.
- `(user_id, event_timestamp)`
- `(org_id, event_timestamp)`
- `(workspace_id, event_timestamp)`
- `(session_id, event_timestamp)`
- `(run_id, event_timestamp)`
- `(expires_at)`

Add `debug_log_batch`.

Fields:

- `id`
- `batch_id`
- `idempotency_key`
- `event_count`
- `created_at`
- `expires_at`

Unique indexes:

- `batch_id`
- `idempotency_key`

The batch table is the fast idempotency check. If a retry uses an already accepted batch id or idempotency key, Den returns success without inserting duplicate events.

## Encryption

Use Node `crypto` AES-256-GCM, matching the style of the existing managed AI secret encryption helper.

The effective key is derived from `DEN_LOG_MASTER_KEY` with SHA-256 and used through `createSecretKey`. Payload plaintext is `JSON.stringify(event.payload)`.

Store:

- ciphertext base64
- IV base64
- auth tag base64
- key version
- payload SHA-256 and byte length for diagnostics

Tests must prove the stored ciphertext does not include raw payload text and that decrypting through the repository/API returns the original payload.

## Read APIs

Add platform-admin-only admin API endpoints:

- `GET /admin/api/debug-logs`
- `GET /admin/api/debug-logs/:eventId`
- `GET /admin/api/debug-logs/export`

Search filters:

- `userId`
- `orgId`
- `workspaceId`
- `sessionId`
- `runId`
- `source`
- `stream`
- `level`
- `from`
- `to`
- `limit`
- `cursor`

List results return metadata and a short payload preview. Detail returns metadata plus decrypted payload. Export returns JSONL for the active filters with decrypted payloads.

For the backend-first slice, read access is intentionally coarse: platform admins can read all debug logs. A later `debug-logs-reader` role can narrow this without changing the API surface.

## Retention

On ingest, set `expires_at = now + retentionDays`.

Add a purge function that deletes rows where `expires_at < now` from both tables. Start a lightweight daily interval from Den startup and expose the function for tests. The first pass can also run one purge at startup.

## Data Enrichment

This slice stores the metadata exactly as sent by `veslo-server`. Server-side events may currently carry empty `userId`, `orgId`, or `workspaceId`. That means lookup by user/workspace is only as complete as the app-side metadata. Fixing upstream enrichment is a follow-up unless implementation discovers a reliable Den-side mapping.

## Testing

Use TDD for each behavior:

- env parsing for new Den log settings.
- crypto roundtrip and non-plaintext storage.
- payload validation.
- ingest rejects missing/wrong bearer token.
- ingest persists encrypted events and returns `acceptedBatchIds`.
- ingest is idempotent for repeated batch id and `Idempotency-Key`.
- invalid batch returns stable `400`.
- admin search requires platform admin and filters by metadata.
- detail decrypts payload.
- export returns JSONL.
- retention purge deletes expired rows and keeps fresh rows.
- startup/migration tests ensure tables and indexes are present.

## Out of Scope

- Full static Admin UI "Debug Logs" page.
- Dedicated `debug-logs-reader` role.
- Live tail UI.
- Graphs, aggregation, or alerting.
- Den-side enrichment for empty event user/org/workspace metadata.
- Changes to `veslo-server` or Tauri debug-log forwarding.
