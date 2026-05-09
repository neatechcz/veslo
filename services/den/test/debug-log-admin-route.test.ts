import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"

function buildSession() {
  return {
    user: {
      id: "user_admin_1",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: "org_1",
    organizations: [
      {
        id: "org_1",
        name: "Veslo",
        slug: "veslo",
        ownerUserId: "user_admin_1",
        role: "owner" as const,
      },
    ],
  }
}

async function startServer(router: express.Router) {
  const app = express()
  app.use(router)
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

test("admin debug log routes return list, detail, and JSONL export", async () => {
  const seenQueries: Array<Record<string, unknown>> = []
  const server = await startServer(
    createAdminRouter({
      async getSessionSnapshot() {
        return buildSession()
      },
      async listDebugLogs(req) {
        seenQueries.push(req.query)
        return {
          events: [
            {
              id: "dbg_1",
              batchId: "batch_1",
              eventId: "evt_1",
              userId: "user_1",
              orgId: "org_1",
              workspaceId: "workspace_1",
              workerId: null,
              sessionId: "session_1",
              runId: null,
              source: "engine",
              stream: "stdout",
              level: "info",
              eventTimestamp: "2026-05-09T10:00:00.000Z",
              sequenceNo: 1,
              payloadSha256: "a".repeat(64),
              payloadBytes: 16,
              payloadPreview: "{\"line\":\"hello\"}",
            },
          ],
        }
      },
      async getDebugLog(req) {
        return {
          event: {
            id: req.params.eventId,
            batchId: "batch_1",
            eventId: "evt_1",
            userId: "user_1",
            orgId: "org_1",
            workspaceId: "workspace_1",
            workerId: null,
            sessionId: "session_1",
            runId: null,
            source: "engine",
            stream: "stdout",
            level: "info",
            eventTimestamp: "2026-05-09T10:00:00.000Z",
            sequenceNo: 1,
            payloadSha256: "a".repeat(64),
            payloadBytes: 16,
            payloadPreview: "{\"line\":\"hello\"}",
            payload: { line: "hello" },
          },
        }
      },
      async exportDebugLogs() {
        return {
          filename: "debug-logs.jsonl",
          body: `${JSON.stringify({ id: "dbg_1", payload: { line: "hello" } })}\n`,
        }
      },
    }),
  )

  try {
    const list = await fetch(`http://127.0.0.1:${server.port}/debug-logs?userId=user_1&source=engine`)
    assert.equal(list.status, 200)
    assert.equal((await list.json()).events[0].id, "dbg_1")
    assert.equal(seenQueries[0]?.userId, "user_1")
    assert.equal(seenQueries[0]?.source, "engine")

    const detail = await fetch(`http://127.0.0.1:${server.port}/debug-logs/dbg_1`)
    assert.equal(detail.status, 200)
    assert.deepEqual((await detail.json()).event.payload, { line: "hello" })

    const exported = await fetch(`http://127.0.0.1:${server.port}/debug-logs/export`)
    assert.equal(exported.status, 200)
    assert.equal(exported.headers.get("content-type")?.startsWith("application/x-ndjson"), true)
    assert.match(await exported.text(), /"dbg_1"/)
  } finally {
    await server.close()
  }
})

test("admin debug log routes return 501 when handlers are not wired", async () => {
  const server = await startServer(
    createAdminRouter({
      async getSessionSnapshot() {
        return buildSession()
      },
    }),
  )

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`)
    assert.equal(response.status, 501)
    assert.equal((await response.json()).error, "not_implemented")
  } finally {
    await server.close()
  }
})
