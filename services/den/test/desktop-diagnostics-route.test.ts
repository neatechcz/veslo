import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

const [
  { createDesktopDiagnosticsRouter },
  { createDebugLogService, createMemoryDebugLogStore },
] = await Promise.all([
  import("../src/http/desktop-diagnostics.js"),
  import("../src/debug-logs/repository.js"),
])

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    userId: "user_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    source: "Veslo bootstrap",
    stream: "diagnostic",
    timestamp: 1778322000000000000,
    sequenceNo: 1,
    payload: {
      eventType: "veslo-server-launch:spawn-failed",
      diagnostics: {
        installId: "install_1",
        bootId: "boot_1",
      },
    },
    ...overrides,
  }
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "batch_1",
    installId: "install_1",
    bootId: "boot_1",
    userId: "user_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    deliveryPath: "desktop-direct-fallback",
    events: [makeEvent()],
    ...overrides,
  }
}

async function startServer(options: {
  service: ReturnType<typeof createDebugLogService> | null
  authorize?: Parameters<typeof createDesktopDiagnosticsRouter>[0]["authorize"]
}) {
  const app = express()
  app.use("/v1", createDesktopDiagnosticsRouter(options))

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

function authorize() {
  return {
    session: {
      user: {
        id: "user_1",
        email: "user@example.test",
        emailVerified: true,
        name: "User",
      },
    },
    organization: {
      id: "org_1",
      name: "Org",
      slug: "org",
      ownerUserId: "user_1",
    },
    membershipId: "membership_1",
    orgRole: "member" as const,
    isPlatformAdmin: false,
  }
}

test("desktop diagnostics ingest accepts authenticated bootstrap diagnostics", async () => {
  const { service, store } = createService()
  const server = await startServer({ service, authorize: async () => authorize() })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/desktop-diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEnvelope()),
    })

    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, acceptedBatchIds: ["batch_1"] })
    assert.equal(store.events.length, 1)
  } finally {
    await server.close()
  }
})

test("desktop diagnostics ingest rejects non-diagnostics events", async () => {
  const { service, store } = createService()
  const server = await startServer({ service, authorize: async () => authorize() })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/desktop-diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEnvelope({
        events: [makeEvent({
          source: "Veslo UI",
          stream: "stderr",
          payload: { line: "arbitrary ui log" },
        })],
      })),
    })

    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, "invalid_desktop_diagnostics_event")
    assert.equal(store.events.length, 0)
  } finally {
    await server.close()
  }
})

test("desktop diagnostics ingest rejects user mismatches", async () => {
  const { service, store } = createService()
  const server = await startServer({ service, authorize: async () => authorize() })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/desktop-diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEnvelope({
        userId: "user_2",
        events: [makeEvent({ userId: "user_2" })],
      })),
    })

    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, "desktop_diagnostics_user_mismatch")
    assert.equal(store.events.length, 0)
  } finally {
    await server.close()
  }
})
