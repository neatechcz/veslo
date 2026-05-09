import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const schema = await import("../src/db/schema.js")

test("debug log schema exports event and batch tables", () => {
  assert.ok(schema.DebugLogEventTable)
  assert.ok(schema.DebugLogBatchTable)
})

test("debug log migration creates event, batch, and lookup indexes", () => {
  const migrationUrl = new URL("../drizzle/0012_debug_logs.sql", import.meta.url)

  assert.equal(existsSync(migrationUrl), true)

  const migration = readFileSync(migrationUrl, "utf8")
  assert.match(migration, /CREATE TABLE `debug_log_batch`/)
  assert.match(migration, /CREATE TABLE `debug_log_event`/)
  assert.match(migration, /debug_log_batch_batch_id/)
  assert.match(migration, /debug_log_batch_idempotency_key/)
  assert.match(migration, /debug_log_event_batch_event/)
  assert.match(migration, /debug_log_event_user_time/)
  assert.match(migration, /debug_log_event_org_time/)
  assert.match(migration, /debug_log_event_workspace_time/)
  assert.match(migration, /debug_log_event_session_time/)
  assert.match(migration, /debug_log_event_run_time/)
  assert.match(migration, /debug_log_event_expires_at/)
})

test("den startup ensures debug log tables and indexes", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.ok(indexSource.includes("CREATE TABLE IF NOT EXISTS \\`debug_log_batch\\`"))
  assert.ok(indexSource.includes("CREATE TABLE IF NOT EXISTS \\`debug_log_event\\`"))
  assert.match(indexSource, /ensureIndex\("debug_log_batch", "debug_log_batch_batch_id", \["batch_id"\], true\)/)
  assert.match(
    indexSource,
    /ensureIndex\("debug_log_batch", "debug_log_batch_idempotency_key", \["idempotency_key"\], true\)/,
  )
  assert.match(
    indexSource,
    /ensureIndex\("debug_log_event", "debug_log_event_batch_event", \["batch_id", "event_id"\], true\)/,
  )
  assert.match(indexSource, /ensureIndex\("debug_log_event", "debug_log_event_user_time", \["user_id", "event_timestamp"\]\)/)
  assert.match(indexSource, /ensureIndex\("debug_log_event", "debug_log_event_org_time", \["org_id", "event_timestamp"\]\)/)
  assert.match(
    indexSource,
    /ensureIndex\("debug_log_event", "debug_log_event_workspace_time", \["workspace_id", "event_timestamp"\]\)/,
  )
  assert.match(
    indexSource,
    /ensureIndex\("debug_log_event", "debug_log_event_session_time", \["session_id", "event_timestamp"\]\)/,
  )
  assert.match(indexSource, /ensureIndex\("debug_log_event", "debug_log_event_run_time", \["run_id", "event_timestamp"\]\)/)
  assert.match(indexSource, /ensureIndex\("debug_log_event", "debug_log_event_expires_at", \["expires_at"\]\)/)
})
