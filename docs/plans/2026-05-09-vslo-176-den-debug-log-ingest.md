# VSLO-176 Den Debug Log Ingest Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the backend-first VSLO-176 slice: Den accepts debug-log batches from `veslo-server`, stores encrypted payloads, supports idempotent retries, purges expired rows, and exposes platform-admin read/export APIs.

**Architecture:** Add a small Den debug-log module containing validation, encryption, repository/service, ingest router, admin router helpers, and retention purge. Mount ingest under `/v1/internal/debug-logs` with internal bearer auth and mount read/export through the existing `/admin/api` router dependency surface.

**Tech Stack:** Express, Drizzle MySQL, Zod, Node `crypto`, Node test runner via `tsx --test`.

---

### Task 1: Env and Crypto Primitives

**Files:**
- Modify: `services/den/src/env.ts`
- Create: `services/den/src/debug-logs/crypto.ts`
- Test: `services/den/test/debug-log-env.test.ts`
- Test: `services/den/test/debug-log-crypto.test.ts`

**Step 1: Write failing env tests**

Add tests proving:
- `DEN_LOG_INGEST_TOKEN`, `DEN_LOG_MASTER_KEY`, `DEN_LOG_MASTER_KEY_VERSION`, and `DEN_LOG_RETENTION_DAYS` parse into `env.debugLogs`.
- retention defaults to `30`.
- invalid retention days throws.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-env.test.ts
```

Expected: FAIL because `debugLogs` env does not exist.

**Step 2: Implement env parsing**

Add optional schema keys, parse a `debugLogs` object:

```ts
debugLogs: {
  ingestToken: parsed.DEN_LOG_INGEST_TOKEN?.trim() || null,
  masterKey: parsed.DEN_LOG_MASTER_KEY?.trim() || null,
  masterKeyVersion: parsed.DEN_LOG_MASTER_KEY_VERSION?.trim() || null,
  retentionDays: parsePositiveNumber(parsed.DEN_LOG_RETENTION_DAYS, 30, "DEN_LOG_RETENTION_DAYS"),
}
```

**Step 3: Write failing crypto tests**

Cover:
- encrypt/decrypt roundtrip.
- ciphertext does not include raw payload text.
- key version is preserved in the envelope.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-crypto.test.ts
```

Expected: FAIL because crypto module does not exist.

**Step 4: Implement crypto**

Create AES-256-GCM helpers:

- `createDebugLogEncryptionKey(masterKey: string)`
- `encryptDebugLogPayload(input: { key; keyVersion; payload })`
- `decryptDebugLogPayload(input: { key; envelope })`

Use SHA-256 key derivation, 12-byte IV, base64 fields.

**Step 5: Verify**

Run both focused tests. Expected: PASS.

### Task 2: Schema and Boot-Time Table Creation

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Add: `services/den/drizzle/0012_debug_logs.sql`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/debug-log-schema.test.ts`

**Step 1: Write failing schema/startup test**

Assert:
- schema exports `DebugLogEventTable` and `DebugLogBatchTable`.
- `index.ts` contains `CREATE TABLE IF NOT EXISTS \`debug_log_event\``.
- required indexes are ensured: batch, user/time, org/time, workspace/time, session/time, run/time, expires.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-schema.test.ts
```

Expected: FAIL because schema/table creation is missing.

**Step 2: Implement schema**

Add tables:

- `DebugLogEventTable`
- `DebugLogBatchTable`

Use clear metadata columns and encrypted payload envelope fields from the design.

**Step 3: Add migration SQL**

Add SQL matching the Drizzle schema. Use MySQL indexes:

- `debug_log_batch_batch_id` unique
- `debug_log_batch_idempotency_key` unique
- `debug_log_event_batch_event` unique
- metadata/time indexes
- `debug_log_event_expires_at`
- `debug_log_batch_expires_at`

**Step 4: Wire `ensureTables()`**

Create both tables and ensure indexes in `services/den/src/index.ts`.

**Step 5: Verify**

Run focused schema test. Expected: PASS.

### Task 3: Validation and Repository

**Files:**
- Create: `services/den/src/debug-logs/types.ts`
- Create: `services/den/src/debug-logs/validation.ts`
- Create: `services/den/src/debug-logs/repository.ts`
- Test: `services/den/test/debug-log-validation.test.ts`
- Test: `services/den/test/debug-log-repository.test.ts`

**Step 1: Write failing validation tests**

Cover:
- valid `{ batchId, events }` returns parsed data.
- empty events returns an issue.
- missing required event fields returns an issue.
- `payload` must be an object.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-validation.test.ts
```

Expected: FAIL because validation module does not exist.

**Step 2: Implement validation**

Use Zod. Keep source and stream length bounded, event count `1..1000`, and level optional enum.

**Step 3: Write failing repository tests**

Use a memory repository first to lock behavior without a DB:

- first accepted batch stores encrypted events.
- repeated batch id is idempotent and inserts no new events.
- same `Idempotency-Key` is idempotent.
- search filters by metadata.
- detail decrypts payload.
- export returns decrypted rows.
- purge removes expired records only.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-repository.test.ts
```

Expected: FAIL because repository module does not exist.

**Step 4: Implement repository/service contracts**

Create:

- `DebugLogStore` interface.
- `createMemoryDebugLogStore()` for route tests.
- `createDbDebugLogStore(db)` for production.
- `createDebugLogService({ store, masterKey, masterKeyVersion, retentionDays })`.

Service methods:

- `ingestBatch({ batchId, idempotencyKey, events })`
- `searchLogs(filters)`
- `getLog(eventId)`
- `exportLogs(filters)`
- `purgeExpired(now)`

**Step 5: Verify**

Run validation and repository tests. Expected: PASS.

### Task 4: Ingest Route

**Files:**
- Create: `services/den/src/http/debug-logs.ts`
- Modify: `services/den/src/index.ts`
- Test: `services/den/test/debug-log-ingest-route.test.ts`
- Test: `services/den/test/debug-log-index.test.ts`

**Step 1: Write failing route tests**

Create an Express app with the router and memory service. Cover:

- no authorization header returns `401`.
- wrong bearer token returns `403`.
- missing crypto config returns `503` or stable config error.
- invalid body returns `400 invalid_debug_log_batch`.
- valid body returns `202` with `acceptedBatchIds`.
- repeated batch returns `202` without duplicate memory rows.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-ingest-route.test.ts
```

Expected: FAIL because route module does not exist.

**Step 2: Implement route**

Router factory:

```ts
createDebugLogsIngestRouter({
  ingestToken,
  service,
})
```

Mount in `index.ts`:

```ts
app.use("/v1/internal", createDebugLogsIngestRouter(...))
```

Mount before generic `express.json()` only if route needs a larger JSON limit; otherwise use the existing parser.

**Step 3: Add index mounting test**

Assert source mounts `/v1/internal` debug logs router and creates service/store.

**Step 4: Verify**

Run focused route and index tests. Expected: PASS.

### Task 5: Admin Read and Export APIs

**Files:**
- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Test: `services/den/test/debug-log-admin-route.test.ts`

**Step 1: Write failing admin route tests**

Cover:
- unauthenticated/non-admin request is rejected through `getSessionSnapshot`.
- `GET /debug-logs` returns metadata list with preview.
- `GET /debug-logs/:eventId` returns decrypted payload.
- `GET /debug-logs/export` returns JSONL with decrypted payload.
- filters are passed to the service.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-admin-route.test.ts
```

Expected: FAIL because admin route deps have no debug-log handlers.

**Step 2: Extend admin route deps**

Add optional deps:

- `listDebugLogs`
- `getDebugLog`
- `exportDebugLogs`

Add router handlers under `/admin/api/debug-logs`.

**Step 3: Implement runtime deps**

In `admin-runtime.ts`, provide handlers that call the production debug-log service and require platform admin through the existing snapshot path.

**Step 4: Verify**

Run focused admin route tests. Expected: PASS.

### Task 6: Retention Loop and Docs

**Files:**
- Modify: `services/den/src/index.ts`
- Modify: `services/den/README.md`
- Modify: `services/den/.env.example`
- Modify: `docs/dev/state-and-config-reference.md`
- Test: `services/den/test/debug-log-retention.test.ts`

**Step 1: Write failing retention test**

Assert startup exposes/starts a due purge loop or source contains `startDebugLogRetentionLoop`, and service purge deletes only expired records.

Run:

```bash
pnpm --dir services/den exec tsx --test test/debug-log-retention.test.ts
```

Expected: FAIL until loop/source and purge behavior exist.

**Step 2: Implement retention loop**

Add:

- `DEBUG_LOG_RETENTION_INTERVAL_MS = 86_400_000`
- `startDebugLogRetentionLoop(service)`
- one immediate purge at startup
- unref interval

**Step 3: Update docs/env sample**

Document:

- ingest URL `/v1/internal/debug-logs`
- `DEN_LOG_INGEST_TOKEN`
- `DEN_LOG_MASTER_KEY`
- `DEN_LOG_MASTER_KEY_VERSION`
- `DEN_LOG_RETENTION_DAYS`
- read APIs are platform-admin-only for this slice.

**Step 4: Verify**

Run retention test. Expected: PASS.

### Task 7: Final Verification

**Files:**
- All touched files.

**Step 1: Run focused VSLO-176 tests**

```bash
pnpm --dir services/den exec tsx --test \
  test/debug-log-env.test.ts \
  test/debug-log-crypto.test.ts \
  test/debug-log-schema.test.ts \
  test/debug-log-validation.test.ts \
  test/debug-log-repository.test.ts \
  test/debug-log-ingest-route.test.ts \
  test/debug-log-admin-route.test.ts \
  test/debug-log-retention.test.ts \
  test/debug-log-index.test.ts
```

Expected: PASS.

**Step 2: Run full Den tests**

```bash
pnpm --dir services/den test
```

Expected: PASS, with existing external-contract skips allowed.

**Step 3: Typecheck Den**

```bash
pnpm --dir services/den build
```

Expected: PASS.

**Step 4: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected: only VSLO-176 backend/docs files changed.
