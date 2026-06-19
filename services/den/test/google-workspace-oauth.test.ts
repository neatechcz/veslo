import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import {
  createGoogleWorkspaceGrantEncryptionKey,
  decryptGoogleWorkspaceGrant,
  encryptGoogleWorkspaceGrant,
  InMemoryGoogleWorkspaceConnectionStore,
} from "../src/google-workspace/store.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:8788",
})

function createOrgContext(orgId: string) {
  return {
    session: {
      user: {
        id: "user_1",
        email: "user@example.com",
        emailVerified: true,
        name: "User One",
      },
    },
    organization: {
      id: orgId,
      name: "Org One",
      slug: "org-one",
      ownerUserId: "user_1",
    },
    membershipId: "membership_1",
    orgRole: "member" as const,
    isPlatformAdmin: false,
  }
}

async function startServer(input: {
  store?: InMemoryGoogleWorkspaceConnectionStore
  now?: () => number
  fetchImpl?: typeof fetch
  exchange?: (code: string) => Promise<{
    accessToken: string
    refreshToken: string
    expiresAt: string
    scope?: string
  }>
} = {}) {
  const store = input.store ?? new InMemoryGoogleWorkspaceConnectionStore()
  const exchangeCalls: string[] = []
  const revokedTokens: string[] = []
  const { createGoogleWorkspaceRouter } = await import("../src/http/google-workspace.js")
  const oauth = {
    startAuthorization: async (input: any) => {
      const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
      authorizeUrl.searchParams.set("state", input.state)
      authorizeUrl.searchParams.set("scope", input.scopes.join(" "))
      authorizeUrl.searchParams.set("redirect_uri", input.redirectUri)
      authorizeUrl.searchParams.set("access_type", "offline")
      return { authorizeUrl: authorizeUrl.toString() }
    },
    exchangeCode: async (exchangeInput: any) => {
      exchangeCalls.push(exchangeInput.code)
      return await (input.exchange?.(exchangeInput.code) ?? {
        accessToken: "google_access_token",
        refreshToken: "google_refresh_token",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      })
    },
    refreshToken: async () => {
      throw new Error("unused")
    },
    revokeToken: async (refreshToken: string) => {
      revokedTokens.push(refreshToken)
    },
  }

  const app2 = express()
  app2.use(express.json())
  app2.use(
    "/v1",
    createGoogleWorkspaceRouter({
      stateSecret: "google_state_secret_01234567890123456789",
      successRedirectUrl: "https://app.veslo.work/settings/integrations/google",
      authorize: async (req) => createOrgContext(req.params.orgId),
      store,
      oauth,
      now: input.now,
      fetchImpl: input.fetchImpl,
    }),
  )

  const server = app2.listen(0, "127.0.0.1")
  await once(server, "listening")

  return {
    port: (server.address() as AddressInfo).port,
    store,
    exchangeCalls,
    revokedTokens,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

test("google workspace OAuth start returns a connector-scoped authorization URL", async () => {
  const server = await startServer()

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/oauth/start`,
    )

    assert.equal(response.status, 200)
    const payload = await response.json() as { authorizeUrl: string; state: string }
    const authorizeUrl = new URL(payload.authorizeUrl)
    assert.equal(authorizeUrl.origin, "https://accounts.google.com")
    assert.equal(authorizeUrl.searchParams.get("state"), payload.state)
    assert.equal(authorizeUrl.searchParams.get("access_type"), "offline")
    assert.deepEqual(authorizeUrl.searchParams.get("scope")?.split(" "), [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ])
  } finally {
    await server.close()
  }
})

test("google workspace OAuth start rejects unknown connector ids", async () => {
  const server = await startServer()

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-chat/oauth/start`,
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "unknown_google_workspace_connector" })
  } finally {
    await server.close()
  }
})

test("google workspace OAuth callback stores a grant without returning token material", async () => {
  const server = await startServer()

  try {
    const startResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/oauth/start`,
    )
    const startPayload = await startResponse.json() as { state: string }

    const callbackResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/integrations/google/oauth/callback?code=google_code_123&state=${encodeURIComponent(startPayload.state)}`,
      { redirect: "manual" },
    )

    assert.equal(callbackResponse.status, 302)
    assert.match(callbackResponse.headers.get("location") ?? "", /status=connected/)
    assert.deepEqual(server.exchangeCalls, ["google_code_123"])
    assert.doesNotMatch(await callbackResponse.text(), /google_(access|refresh)_token/)

    const connections = await server.store.listConnections({ orgId: "org_1", userId: "user_1" })
    assert.equal(connections.length, 1)
    assert.equal(connections[0]?.connectorId, "google-gmail")
    assert.equal(connections[0]?.state, "connected")
  } finally {
    await server.close()
  }
})

test("google workspace runtime token authenticates MCP proxy requests with the stored Google access token", async () => {
  const upstreamCalls: Array<{ url: string; method: string; authorization: string | null; body: string }> = []
  const server = await startServer({
    fetchImpl: async (url, init) => {
      upstreamCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
      })
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true }, id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  try {
    await server.store.upsertConnection({
      orgId: "org_1",
      userId: "user_1",
      connectorId: "google-gmail",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      grant: {
        accessToken: "stored_google_access",
        refreshToken: "stored_google_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
      },
    })

    const tokenResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/runtime-token`,
      { method: "POST" },
    )
    assert.equal(tokenResponse.status, 200)
    const tokenPayload = await tokenResponse.json() as { token: string }

    const proxyResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp?session=abc`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      },
    )

    assert.equal(proxyResponse.status, 200)
    assert.deepEqual(await proxyResponse.json(), { jsonrpc: "2.0", result: { ok: true }, id: 1 })
    assert.equal(upstreamCalls.length, 1)
    assert.match(upstreamCalls[0]?.url ?? "", /^https:\/\/gmailmcp\.googleapis\.com\/mcp\/v1\?session=abc$/)
    assert.equal(upstreamCalls[0]?.method, "POST")
    assert.equal(upstreamCalls[0]?.authorization, "Bearer stored_google_access")
    assert.match(upstreamCalls[0]?.body ?? "", /tools\/list/)
  } finally {
    await server.close()
  }
})

test("google workspace MCP proxy rejects requests without a valid runtime token", async () => {
  const server = await startServer()

  try {
    const proxyResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      { method: "POST" },
    )

    assert.equal(proxyResponse.status, 401)
    assert.deepEqual(await proxyResponse.json(), { error: "google_workspace_runtime_token_invalid" })
  } finally {
    await server.close()
  }
})

test("google workspace connection status and disconnect are per connector", async () => {
  const server = await startServer()

  try {
    await server.store.upsertConnection({
      orgId: "org_1",
      userId: "user_1",
      connectorId: "google-gmail",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      grant: {
        accessToken: "gmail_access",
        refreshToken: "gmail_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      },
    })
    await server.store.upsertConnection({
      orgId: "org_1",
      userId: "user_1",
      connectorId: "google-calendar",
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      grant: {
        accessToken: "calendar_access",
        refreshToken: "calendar_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: "https://www.googleapis.com/auth/calendar.events.readonly",
      },
    })

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/connections`,
    )
    assert.equal(statusResponse.status, 200)
    const statusPayload = await statusResponse.json() as { items: Array<{ connectorId: string; connected: boolean }> }
    assert.equal(statusPayload.items.find((item) => item.connectorId === "google-gmail")?.connected, true)
    assert.equal(statusPayload.items.find((item) => item.connectorId === "google-calendar")?.connected, true)
    assert.equal(statusPayload.items.find((item) => item.connectorId === "google-drive")?.connected, false)

    const deleteResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/connection`,
      { method: "DELETE" },
    )
    assert.equal(deleteResponse.status, 200)

    const afterDelete = await server.store.listConnections({ orgId: "org_1", userId: "user_1" })
    assert.deepEqual(await deleteResponse.json(), { ok: true, connectorId: "google-gmail", revokeOk: true })
    assert.deepEqual(server.revokedTokens, ["gmail_refresh"])
    assert.equal(afterDelete.find((item) => item.connectorId === "google-gmail")?.state, "revoked")
    assert.equal(afterDelete.find((item) => item.connectorId === "google-calendar")?.state, "connected")
  } finally {
    await server.close()
  }
})

test("google workspace grant encryption does not store token plaintext", () => {
  const key = createGoogleWorkspaceGrantEncryptionKey("google_secret_key_01234567890123456789")
  const encrypted = encryptGoogleWorkspaceGrant(key, {
    accessToken: "plain_access_token",
    refreshToken: "plain_refresh_token",
    expiresAt: "2030-06-19T12:00:00.000Z",
    scope: "scope_a scope_b",
  })

  const serialized = JSON.stringify(encrypted)
  assert.doesNotMatch(serialized, /plain_access_token/)
  assert.doesNotMatch(serialized, /plain_refresh_token/)
  assert.deepEqual(decryptGoogleWorkspaceGrant(key, encrypted), {
    accessToken: "plain_access_token",
    refreshToken: "plain_refresh_token",
    expiresAt: "2030-06-19T12:00:00.000Z",
    scope: "scope_a scope_b",
  })
})
