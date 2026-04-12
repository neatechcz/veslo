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

test("debug log inspect route requires bearer auth and returns recent rows", async () => {
  const calls: Array<{ limit: number; source: string | null; workspaceId: string | null }> = []
  const app = express()
  app.use(express.json())
  app.use(
    createDebugLogsRouter({
      ingestToken: "ingest-token",
      async storeBatch(batch) {
        return { ok: true, acceptedBatchIds: [batch.batchId] }
      },
      async readRecent(input) {
        calls.push(input)
        return {
          ok: true,
          rows: [
            {
              id: "evt-1",
              source: input.source ?? "audit",
              workspaceId: input.workspaceId ?? "ws_1",
              payload: { text: "hello" },
            },
          ],
        }
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo

    const unauthorized = await fetch(`http://127.0.0.1:${port}/recent?limit=5&source=audit&workspaceId=ws_1`)
    assert.equal(unauthorized.status, 401)

    const authorized = await fetch(`http://127.0.0.1:${port}/recent?limit=5&source=audit&workspaceId=ws_1`, {
      headers: { Authorization: "Bearer ingest-token" },
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), {
      ok: true,
      rows: [
        {
          id: "evt-1",
          source: "audit",
          workspaceId: "ws_1",
          payload: { text: "hello" },
        },
      ],
    })
    assert.deepEqual(calls, [{ limit: 5, source: "audit", workspaceId: "ws_1" }])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("debug log ingest route includes nested error details for internal failures", async () => {
  const app = express()
  app.use(express.json())
  app.use(
    createDebugLogsRouter({
      ingestToken: "ingest-token",
      async storeBatch() {
        throw new Error("outer failure", {
          cause: new Error("inner failure"),
        })
      },
    }),
  )

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ingest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batchId: "batch-1", events: [] }),
    })

    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: "internal_error",
      message: "outer failure",
      details: ["inner failure"],
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
