import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { createApp } from "../src/index.js"

test("GET /admin/credentials serves the admin shell without embedding a custom credential form", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/credentials`)

    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /AI Gateway Admin/i)
    assert.match(html, /Credentials/i)
    assert.match(html, /Users/i)
    assert.match(html, /Sign in with Browser/i)
    assert.doesNotMatch(html, /<form[^>]+id="login-form"/i)
    assert.doesNotMatch(html, /type="password"/i)
    assert.doesNotMatch(html, /OpenAI Shared Pool A/i)
    assert.doesNotMatch(html, /Anthropic Shared Pool B/i)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js uses browser handoff auth instead of custom email-password sign-in", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /\/auth\/browser\/start/)
    assert.match(script, /\/auth\/browser\/exchange/)
    assert.match(script, /host\.docker\.internal/)
    assert.match(script, /127\.0\.0\.1/)
    assert.doesNotMatch(script, /\/admin\/api\/auth\/sign-in/)
    assert.doesNotMatch(script, /loginPassword/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/app.js preserves auth callback query params until browser exchange completes", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/app.js`)

    assert.equal(response.status, 200)
    const script = await response.text()
    assert.match(script, /const nextPath = page === "overview" \? "\/admin" : `\/admin\/\$\{page\}`/)
    assert.match(script, /if \(location\.pathname !== nextPath\) {\s*history\.replaceState\(null, "", nextPath\);\s*}/)
    assert.doesNotMatch(
      script,
      /history\.replaceState\(null, "", page === "overview" \? "\/admin" : `\/admin\/\$\{page\}`\);/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/session returns 401 when no bearer token is present", async () => {
  const app = createApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/session`)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/credentials rejects invalid bearer tokens before serving read models", async () => {
  const app = createApp({
    admin: {
      async startBrowserAuth() {
        return {
          authorizeUrl: "https://den.example.test/?desktopOnboarding=1&sid=test",
          sessionId: "session_test",
          expiresAt: null,
        }
      },
      async exchangeBrowserAuth() {
        throw new Error("unused")
      },
      async getSession() {
        throw Object.assign(new Error("forbidden"), { status: 403 })
      },
      async listUsers() {
        return []
      },
      async createUser() {
        throw new Error("unused")
      },
      async updateUser() {
        throw new Error("unused")
      },
      async disableUser() {
        throw new Error("unused")
      },
      async enableUser() {
        throw new Error("unused")
      },
      async deleteUser() {
        return
      },
      async listCredentials() {
        return { credentials: [{ id: "cred_1" }] as never[] }
      },
      async listSessions() {
        return { sessions: [] }
      },
      async getUsage() {
        return {
          summary: { totalTokens: 0, totalRequests: 0 },
          groupBy: "total",
          filters: { credentials: [], users: [], orgs: [] },
          series: [],
          topCredentials: [],
          topUsers: [],
          topOrgs: [],
        }
      },
      async listAlerts() {
        return { alerts: [] }
      },
      async listAudit() {
        return { events: [] }
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      headers: {
        authorization: "Bearer not-a-real-token",
      },
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "forbidden" })
  } finally {
    server.close()
    await once(server, "close")
  }
})
