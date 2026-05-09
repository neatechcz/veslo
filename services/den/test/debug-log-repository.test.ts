import assert from "node:assert/strict"
import test from "node:test"

const { createMemoryDebugLogStore, createDebugLogService } = await import("../src/debug-logs/repository.js")

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    userId: "user_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    workerId: "worker_1",
    sessionId: "session_1",
    runId: "run_1",
    source: "engine",
    stream: "stdout",
    level: "info",
    timestamp: 1778322000000000000,
    sequenceNo: 1,
    payload: { line: "secret log line", nested: { exitCode: 0 } },
    ...overrides,
  }
}

function createService() {
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

  return { service, store }
}

test("debug log service stores encrypted events and decrypts details", async () => {
  const { service, store } = createService()

  const result = await service.ingestBatch({
    batchId: "batch_1",
    events: [makeEvent()],
  })

  assert.deepEqual(result.acceptedBatchIds, ["batch_1"])
  assert.equal(store.events.length, 1)
  assert.equal(store.events[0]?.payloadCiphertext.includes("secret log line"), false)
  assert.equal(store.events[0]?.payloadSha256.length, 64)

  const detail = await service.getLog("dbg_1")
  assert.equal(detail?.id, "dbg_1")
  assert.deepEqual(detail?.payload, { line: "secret log line", nested: { exitCode: 0 } })
})

test("debug log service treats repeated batch ids and idempotency keys as accepted retries", async () => {
  const { service, store } = createService()

  await service.ingestBatch({ batchId: "batch_1", idempotencyKey: "idem_1", events: [makeEvent()] })
  const repeatByBatch = await service.ingestBatch({ batchId: "batch_1", events: [makeEvent({ id: "evt_2" })] })
  const repeatByKey = await service.ingestBatch({
    batchId: "batch_2",
    idempotencyKey: "idem_1",
    events: [makeEvent({ id: "evt_3" })],
  })

  assert.deepEqual(repeatByBatch.acceptedBatchIds, ["batch_1"])
  assert.equal(repeatByBatch.idempotent, true)
  assert.deepEqual(repeatByKey.acceptedBatchIds, ["batch_2"])
  assert.equal(repeatByKey.idempotent, true)
  assert.equal(store.events.length, 1)
})

test("debug log service searches, exports, and purges by metadata", async () => {
  const { service, store } = createService()

  await service.ingestBatch({
    batchId: "batch_1",
    events: [
      makeEvent({ id: "evt_1", userId: "user_1", source: "engine", payload: { line: "engine line" } }),
      makeEvent({ id: "evt_2", userId: "user_2", source: "router", payload: { line: "router line" } }),
    ],
  })

  const userOne = await service.searchLogs({ userId: "user_1" })
  assert.equal(userOne.events.length, 1)
  assert.equal(userOne.events[0]?.eventId, "evt_1")
  assert.equal(userOne.events[0]?.payloadPreview, "{\"line\":\"engine line\"}")

  const exported = await service.exportLogs({ source: "router" })
  assert.equal(exported.length, 1)
  assert.deepEqual(exported[0]?.payload, { line: "router line" })

  store.events[0]!.expiresAt = new Date("2026-05-08T10:00:00.000Z")
  const purged = await service.purgeExpired(new Date("2026-05-09T10:00:00.000Z"))
  assert.deepEqual(purged, { eventsDeleted: 1, batchesDeleted: 0 })
  assert.equal(store.events.length, 1)
})
