# Den Log Ingest Design

## Problem

Veslo currently keeps runtime logs in several local-only places:

- `veslo-server` audit logs in local JSONL files
- `agentlab` automation logs in workspace `.log` files
- `opencode-router` logs in its own local file
- engine, `veslo-server`, and router `stdout/stderr` buffers in desktop memory

This is useful for local debugging, but it does not give the team a reliable way to inspect how the product behaved after the fact across real user environments. We need a cloud-backed logging path into Den that preserves full-fidelity log content for developer debugging and failure analysis.

The requested operating model is:

- capture the complete content of all logs
- enable this by default for all production users
- store logs in Den for 30 days
- provide no end-user UI for the feature
- keep the stored payload encrypted
- keep the master key under our control via environment configuration
- rotate keys only manually, on explicit developer request

## Goals

- Ship a centralized log ingest pipeline through `veslo-server`.
- Preserve full-fidelity raw log content, including prompts, tool output, and process streams.
- Store encrypted log payloads in Den with enough metadata to support developer debugging.
- Keep upload resilient when Den is temporarily unavailable.
- Make retention deterministic with a 30-day expiry policy.
- Avoid introducing a user-facing logs UI.
- Keep key management simple enough for the current team: one master key in environment configuration, manual rotation only.

## Non-Goals

- End-user access to uploaded logs.
- Organization admin access to uploaded logs.
- Automatic key rotation.
- External KMS integration for the first version.
- Replacing existing local logging paths.
- Redacting or minimizing log content before upload.
- Building a polished read/query interface on top of Den.

## Chosen Approach

The selected approach is a centralized ingest architecture:

- all local log sources converge on `veslo-server`
- `veslo-server` is the only component that uploads logs to Den
- Den accepts encrypted log batches and stores them in a dedicated log table

This was chosen over direct multi-component upload because it gives us one security boundary, one retry/batching implementation, one auth model, and one place to evolve the pipeline.

## Architecture

### Central ingest boundary

`veslo-server` becomes the sole cloud upload boundary for logs.

It ingests and normalizes:

- its own audit and internal event logs
- live process `stdout/stderr` from desktop-managed services
- existing file-backed logs such as `agentlab` and router logs

Desktop still owns process spawning, but process output is no longer treated as an in-memory-only diagnostics buffer. Instead, desktop forwards those live stream events into the `veslo-server` log pipeline.

### Normalized event model

Every log record is normalized into one internal event shape before spooling or upload. Each event carries:

- `userId`
- `orgId`
- `workspaceId`
- `workerId` when available
- `sessionId` when available
- `runId` when available
- `source` such as `engine`, `veslo-server`, `opencode-router`, `agentlab`, `audit`
- `stream` such as `stdout`, `stderr`, `event`, `file`
- event timestamp
- sequence number within the source stream
- raw payload content

The payload is intentionally full-fidelity and not reduced to a small structured subset.

### Local spool before upload

`veslo-server` does not upload synchronously on the hot path. Instead it writes normalized events into a local durable spool under the Veslo data directory, then ships batches asynchronously to Den.

This preserves logs during:

- transient Den outages
- local network failures
- temporary auth or ingest failures

The app continues running even when upload is degraded.

### Den as encrypted storage

Den receives batched log events over a dedicated internal ingest route. It validates an internal ingest credential, encrypts the payloads, and stores encrypted log records plus searchable metadata.

Den is storage and retention authority, not the component that collects raw logs directly from desktop or router processes.

## Data Model

### New Den log table

Do not overload `audit_event`. Add a dedicated table for debug logs, for example `debug_log_event`.

Each record has two categories of fields.

#### Cleartext metadata

These fields stay queryable:

- `id`
- `created_at`
- `expires_at`
- `org_id`
- `user_id`
- `workspace_id`
- `worker_id`
- `session_id`
- `run_id`
- `source`
- `stream`
- `level` when known
- `sequence_no`
- `content_sha256`
- `payload_bytes`
- `encryption_key_version`
- optional batch correlation fields such as `batch_id`

#### Encrypted payload fields

These fields are opaque in storage:

- `ciphertext`
- `nonce` or `iv`
- `encrypted_data_key` or equivalent envelope metadata
- `compression` metadata if compression is enabled

### Payload format

Before encryption, payloads are stored as a compact JSON object containing:

- the raw log body
- optional source path for file-backed events
- optional runtime context snapshot
- optional chunk metadata if a large payload was split

We intentionally store the real raw body, not a reduced summary, because the explicit goal is post-hoc developer debugging from the exact original content.

### Retention

Every inserted record gets `expires_at = created_at + 30 days`.

Den runs a cleanup job that permanently deletes expired rows. There is no indefinite archive tier in the first version.

## Security Model

### Master key ownership

The master key is not stored in the database and not committed to the repository.

Den reads it from environment configuration:

- `DEN_LOG_MASTER_KEY`
- `DEN_LOG_MASTER_KEY_VERSION`

This keeps key custody in our own infrastructure and avoids introducing an external KMS dependency in the first version.

### Encryption behavior

Payloads are encrypted at ingest time before being written to the Den database.

The chosen model is envelope-style encryption implemented inside Den with an environment-provided master key:

- plaintext payload exists only in process memory during ingest
- ciphertext plus encryption metadata go to the DB
- decryption is only possible to code running with access to Den runtime secrets

Because the master key lives in the Den runtime, anyone with full production secret access can ultimately decrypt logs. This is weaker than a dedicated KMS, but it matches the current operational preference for self-managed keys and low operational complexity.

### Manual key rotation

There is no automatic rotation.

When developers request a rotation:

- a new `DEN_LOG_MASTER_KEY`
- and a new `DEN_LOG_MASTER_KEY_VERSION`

are deployed manually

New log records use the new key version. Old records remain readable by version until they expire naturally within 30 days. No automatic re-encryption job is required for the first version.

### Ingest authentication

`veslo-server` uploads with a dedicated server-to-server ingest credential, not with end-user Den session tokens.

Example:

- `DEN_LOG_INGEST_URL`
- `DEN_LOG_INGEST_TOKEN`

This keeps user auth and internal log shipping auth separate.

## Operational Behavior

### Log source adapters

The pipeline needs adapters for three source classes:

1. live process streams
- engine `stdout/stderr`
- `veslo-server` `stdout/stderr`
- `opencode-router` `stdout/stderr`

2. Veslo internal events
- audit events
- internal diagnostic events

3. file-backed logs
- `agentlab` logs
- router file logs
- legacy audit JSONL where still relevant

### Batching

`veslo-server` batches events by size and/or event count before upload.

Batches must carry a stable `batch_id` so Den ingest can behave idempotently when retries resend a previously accepted batch.

### Retry and failure handling

On upload failure:

- keep the batch in local spool
- retry with exponential backoff
- never block the main application flow

If the local spool exceeds a configured limit, prefer dropping the oldest unsent batches and emitting an explicit local error marker rather than blocking app functionality.

### Compression

Compress payload blobs before encryption. This reduces storage cost without changing the debugging contract.

### Existing local logs

Cloud ingest does not replace local logs. Existing local files and in-memory diagnostics remain useful for immediate host-side debugging.

## Privacy And Content Scope

The approved requirement is explicit: upload the complete content of all logs.

That means the encrypted payload may contain:

- prompts
- tool outputs
- stack traces
- file paths
- user and org identifiers
- message content
- auth-adjacent values that appear in raw text streams

For this reason, access is intentionally restricted:

- no UI
- no org-level read surface
- developer-only usage through code/DB access

## Testing Strategy

### `veslo-server`

- unit tests for event normalization
- unit tests for spool persistence and replay
- unit tests for batch idempotency and dedupe metadata
- unit tests for source adapters
- integration tests for upload retry behavior

### Den

- schema tests for log record persistence
- contract tests for ingest auth
- tests for encryption/decryption helpers
- tests for manual key version handling
- tests for retention cleanup

### Desktop host layer

- tests that process stream events are forwarded into the server pipeline
- tests that existing diagnostics buffers still work after forwarding is added

## Rollout

### Phase 1

- add Den schema and ingest endpoint
- add `veslo-server` spool, batch, and upload pipeline
- wire desktop-managed live streams into the pipeline
- wire internal audit events into the pipeline

### Phase 2

- add file-backed log shippers for legacy and workspace log files
- add local spool size guardrails and monitoring
- add internal developer tooling for decryption and inspection

## Open Questions Resolved

- Full content logs: yes
- Default enabled for all users: yes
- Retention: 30 days
- Access surface: no UI
- Intended readers: developers only
- Key custody: self-managed
- Key storage: environment configuration
- Key rotation: manual only

## Summary

The final design is a centralized, full-fidelity logging pipeline where `veslo-server` becomes the sole uploader, Den stores encrypted payloads plus searchable metadata, and keys stay under our control via environment configuration with manual rotation. This gives the team durable production-grade debugging visibility without adding end-user surfaces or external KMS dependencies in the first version.
