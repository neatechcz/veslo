import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

const [
  { createDebugLogsIngestRouter },
  { createDebugLogService, createMemoryDebugLogStore },
] = await Promise.all([
  import("../src/http/debug-logs.js"),
  import("../src/debug-logs/repository.js"),
])

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    userId: "user_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    source: "engine",
    stream: "stdout",
    timestamp: 1778322000000000000,
    sequenceNo: 1,
    payload: { line: "hello" },
    ...overrides,
  }
}

async function startServer(options: {
  ingestToken: string | null
  service: ReturnType<typeof createDebugLogService> | null
}) {
  const app = express()
  app.use("/v1/internal", createDebugLogsIngestRouter(options))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, "close")
    },
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
  })
  return { service, store }
}

test("debug log ingest rejects missing and wrong bearer auth", async () => {
  const { service } = createService()
  const server = await startServer({ ingestToken: "ingest-token", service })

  try {
    const missing = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: "batch_1", events: [makeEvent()] }),
    })
    assert.equal(missing.status, 401)
    assert.equal((await missing.json()).error, "debug_log_ingest_unauthorized")

    const wrong = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ batchId: "batch_1", events: [makeEvent()] }),
    })
    assert.equal(wrong.status, 403)
    assert.equal((await wrong.json()).error, "debug_log_ingest_forbidden")
  } finally {
    await server.close()
  }
})

test("debug log ingest reports missing service configuration", async () => {
  const server = await startServer({ ingestToken: "ingest-token", service: null })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ingest-token",
      },
      body: JSON.stringify({ batchId: "batch_1", events: [makeEvent()] }),
    })

    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, "debug_log_ingest_not_configured")
  } finally {
    await server.close()
  }
})

test("debug log ingest validates batches and accepts valid payloads idempotently", async () => {
  const { service, store } = createService()
  const server = await startServer({ ingestToken: "ingest-token", service })

  try {
    const invalid = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ingest-token",
      },
      body: JSON.stringify({ batchId: "batch_bad", events: [] }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, "invalid_debug_log_batch")

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ingest-token",
        "Idempotency-Key": "idem_1",
      },
      body: JSON.stringify({ batchId: "batch_1", events: [makeEvent()] }),
    })
    assert.equal(valid.status, 202)
    assert.deepEqual(await valid.json(), { acceptedBatchIds: ["batch_1"] })
    assert.equal(store.events.length, 1)

    const repeat = await fetch(`http://127.0.0.1:${server.port}/v1/internal/debug-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ingest-token",
        "Idempotency-Key": "idem_1",
      },
      body: JSON.stringify({ batchId: "batch_2", events: [makeEvent({ id: "evt_2" })] }),
    })
    assert.equal(repeat.status, 202)
    assert.deepEqual(await repeat.json(), { acceptedBatchIds: ["batch_2"] })
    assert.equal(store.events.length, 1)
  } finally {
    await server.close()
  }
})
