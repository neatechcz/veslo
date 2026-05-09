import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { createDebugLogService, createMemoryDebugLogStore } = await import("../src/debug-logs/repository.js")

test("debug log retention purge deletes expired rows and keeps fresh rows", async () => {
  const store = createMemoryDebugLogStore()
  const service = createDebugLogService({
    store,
    masterKey: "test-master-key",
    masterKeyVersion: "v1",
    retentionDays: 30,
    generateId: (() => {
      let next = 1
      return () => `dbg_${next++}`
    })(),
    now: () => new Date("2026-05-09T10:00:00.000Z"),
  })

  await service.ingestBatch({
    batchId: "batch_1",
    events: [
      {
        id: "evt_1",
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        source: "engine",
        stream: "stdout",
        timestamp: 1778322000000000000,
        sequenceNo: 1,
        payload: { line: "expired" },
      },
    ],
  })
  await service.ingestBatch({
    batchId: "batch_2",
    events: [
      {
        id: "evt_2",
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        source: "engine",
        stream: "stdout",
        timestamp: 1778322000000000000,
        sequenceNo: 2,
        payload: { line: "fresh" },
      },
    ],
  })

  store.events[0]!.expiresAt = new Date("2026-05-08T10:00:00.000Z")
  store.batches[0]!.expiresAt = new Date("2026-05-08T10:00:00.000Z")

  assert.deepEqual(await service.purgeExpired(new Date("2026-05-09T10:00:00.000Z")), {
    eventsDeleted: 1,
    batchesDeleted: 1,
  })
  assert.deepEqual(store.events.map((entry) => entry.eventId), ["evt_2"])
  assert.deepEqual(store.batches.map((entry) => entry.batchId), ["batch_2"])
})

test("den startup wires a daily debug log retention loop", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(indexSource, /DEBUG_LOG_RETENTION_INTERVAL_MS = 86_400_000/)
  assert.match(indexSource, /function startDebugLogRetentionLoop/)
  assert.match(indexSource, /startDebugLogRetentionLoop\(debugLogService\)/)
})

test("debug log ingest docs describe Den env and read APIs", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const stateDoc = readFileSync(new URL("../../../docs/dev/state-and-config-reference.md", import.meta.url), "utf8")
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8")

  for (const expected of [
    "DEN_LOG_INGEST_TOKEN",
    "DEN_LOG_MASTER_KEY",
    "DEN_LOG_MASTER_KEY_VERSION",
    "DEN_LOG_RETENTION_DAYS",
  ]) {
    assert.match(readme, new RegExp(expected))
    assert.match(envExample, new RegExp(expected))
  }

  assert.match(readme, /POST \/v1\/internal\/debug-logs/)
  assert.match(readme, /GET \/admin\/api\/debug-logs/)
  assert.match(stateDoc, /Den Debug Log Ingest/)
  assert.match(stateDoc, /platform-admin-only/)
})
