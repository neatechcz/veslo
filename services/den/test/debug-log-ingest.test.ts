import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createDebugLogsRouter } from "../src/http/debug-logs.js"

test("debug log ingest route requires bearer auth and accepts batches", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createDebugLogsRouter({
      ingestToken: "ingest-token",
      async storeBatch(batch) {
        return { ok: true, acceptedBatchIds: [batch.batchId] }
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo

    const unauthorized = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: "batch-1", events: [] }),
    })
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ingest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batchId: "batch-1", events: [] }),
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), { ok: true, acceptedBatchIds: ["batch-1"] })
  } finally {
    server.close()
    await once(server, "close")
  }
})
