import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

const { createInternalPlatformAdminRecipientsRouter } = await import("../src/http/internal-platform-admin-recipients.js")

async function startServer(options: Parameters<typeof createInternalPlatformAdminRecipientsRouter>[0]) {
  const app = express()
  app.use("/v1/internal", createInternalPlatformAdminRecipientsRouter(options))
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

test("platform admin recipients route rejects missing and wrong bearer auth", async () => {
  const server = await startServer({
    token: "internal-token",
    listRecipients: async () => [{ userId: "user_admin", email: "admin@example.test", name: "Admin" }],
  })
  try {
    const missing = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`)
    assert.equal(missing.status, 401)
    assert.equal((await missing.json()).error, "platform_admin_recipients_unauthorized")

    const wrong = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer wrong-token" },
    })
    assert.equal(wrong.status, 403)
    assert.equal((await wrong.json()).error, "platform_admin_recipients_forbidden")
  } finally {
    await server.close()
  }
})

test("platform admin recipients route returns active platform admin emails", async () => {
  const server = await startServer({
    token: "internal-token",
    listRecipients: async () => [
      { userId: "user_admin", email: "ADMIN@example.test", name: "Admin" },
      { userId: "user_admin_2", email: "admin@example.test", name: "Duplicate" },
      { userId: "user_other", email: "other@example.test", name: "Other" },
    ],
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer internal-token" },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      recipients: [
        { userId: "user_admin", email: "admin@example.test", name: "Admin" },
        { userId: "user_other", email: "other@example.test", name: "Other" },
      ],
    })
  } finally {
    await server.close()
  }
})

test("platform admin recipients route reports missing configuration", async () => {
  const server = await startServer({
    token: null,
    listRecipients: async () => [],
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/platform-admin-recipients`, {
      headers: { Authorization: "Bearer internal-token" },
    })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, "platform_admin_recipients_not_configured")
  } finally {
    await server.close()
  }
})
