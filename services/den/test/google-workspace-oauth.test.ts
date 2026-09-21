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
  attachmentDownloadTtlMs?: number
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
      attachmentDownloadTtlMs: input.attachmentDownloadTtlMs,
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

async function connectGoogleConnector(
  server: Awaited<ReturnType<typeof startServer>>,
  connectorId: "google-gmail" | "google-calendar" | "google-drive" = "google-gmail",
) {
  await server.store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId,
    scopes: connectorId === "google-gmail"
      ? [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ]
      : ["https://www.googleapis.com/auth/calendar.events.readonly"],
    grant: {
      accessToken: `stored_${connectorId}_access`,
      refreshToken: `stored_${connectorId}_refresh`,
      expiresAt: "2030-06-19T12:00:00.000Z",
    },
  })

  const tokenResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/${connectorId}/runtime-token`,
    { method: "POST" },
  )
  assert.equal(tokenResponse.status, 200)
  return await tokenResponse.json() as { token: string }
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

test("google Gmail MCP tools/list adds the Veslo attachment download tool", async () => {
  const upstreamCalls: string[] = []
  const server = await startServer({
    fetchImpl: async (url) => {
      upstreamCalls.push(String(url))
      return Response.json({
        jsonrpc: "2.0",
        result: {
          tools: [{ name: "get_message", description: "Get a Gmail message" }],
        },
        id: "list-1",
      })
    },
  })

  try {
    const tokenPayload = await connectGoogleConnector(server)
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: "list-1" }),
      },
    )

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      result: { tools: Array<{ name: string; inputSchema?: { required?: string[] } }> }
    }
    assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["get_message", "download_attachment"])
    assert.deepEqual(payload.result.tools[1]?.inputSchema?.required, [
      "messageId",
      "attachmentId",
      "filename",
      "mimeType",
    ])
    assert.equal(upstreamCalls.length, 1)
  } finally {
    await server.close()
  }
})

test("google Calendar MCP tools/list remains an unmodified pass-through", async () => {
  const upstreamPayload = {
    jsonrpc: "2.0",
    result: { tools: [{ name: "list_events" }] },
    id: "list-calendar",
  }
  const server = await startServer({
    fetchImpl: async () => Response.json(upstreamPayload),
  })

  try {
    const tokenPayload = await connectGoogleConnector(server, "google-calendar")
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-calendar/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: "list-calendar" }),
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), upstreamPayload)
  } finally {
    await server.close()
  }
})

test("google Gmail MCP download_attachment returns a scoped URL without forwarding the tool call", async () => {
  const upstreamCalls: string[] = []
  const server = await startServer({
    now: () => 1_781_000_000_000,
    fetchImpl: async (url) => {
      upstreamCalls.push(String(url))
      throw new Error("unexpected upstream call")
    },
  })

  try {
    const tokenPayload = await connectGoogleConnector(server)
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.staging.veslo.work",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: "download-1",
          params: {
            name: "download_attachment",
            arguments: {
              messageId: "message_1",
              attachmentId: "attachment_1",
              filename: "archive.zip",
              mimeType: "application/zip",
            },
          },
        }),
      },
    )

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      id: string
      result: {
        content: Array<{ type: string; text: string }>
        structuredContent: {
          downloadUrl: string
          filename: string
          mimeType: string
          expiresAt: string
        }
      }
    }
    assert.equal(payload.id, "download-1")
    assert.match(
      payload.result.structuredContent.downloadUrl,
      /^https:\/\/api\.staging\.veslo\.work\/v1\/integrations\/google\/gmail\/attachment-download\?token=/,
    )
    assert.equal(payload.result.structuredContent.filename, "archive.zip")
    assert.equal(payload.result.structuredContent.mimeType, "application/zip")
    assert.equal(payload.result.structuredContent.expiresAt, "2026-06-09T10:18:20.000Z")
    assert.match(payload.result.content[0]?.text ?? "", /save.*workspace/i)
    assert.equal(upstreamCalls.length, 0)
  } finally {
    await server.close()
  }
})

test("google Gmail MCP download_attachment rejects invalid arguments as JSON-RPC invalid params", async () => {
  const server = await startServer()

  try {
    const tokenPayload = await connectGoogleConnector(server)
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 7,
          params: {
            name: "download_attachment",
            arguments: {
              messageId: "message_1",
              attachmentId: " ",
              filename: "archive.zip",
              mimeType: "application/zip",
            },
          },
        }),
      },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      error: {
        code: -32602,
        message: "invalid_params",
        data: { invalid: "attachmentId" },
      },
      id: 7,
    })
  } finally {
    await server.close()
  }
})

test("google Gmail attachment URL returns exact ZIP bytes with safe download headers", async () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x10])
  const gmailCalls: Array<{ url: string; authorization: string | null }> = []
  const server = await startServer({
    now: () => 1_781_000_000_000,
    fetchImpl: async (url, init) => {
      gmailCalls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return Response.json({
        size: zipBytes.byteLength,
        data: zipBytes.toString("base64url"),
      })
    },
  })

  try {
    const tokenPayload = await connectGoogleConnector(server)
    const toolResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
          params: {
            name: "download_attachment",
            arguments: {
              messageId: "message/1",
              attachmentId: "attachment+1",
              filename: "../unsafe\r\narchive.zip",
              mimeType: "application/zip",
            },
          },
        }),
      },
    )
    const toolPayload = await toolResponse.json() as {
      result: { structuredContent: { downloadUrl: string } }
    }

    const downloadResponse = await fetch(toolPayload.result.structuredContent.downloadUrl)
    assert.equal(downloadResponse.status, 200)
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), zipBytes)
    assert.equal(downloadResponse.headers.get("content-type"), "application/zip")
    assert.equal(downloadResponse.headers.get("content-disposition"), "attachment; filename=\"unsafearchive.zip\"")
    assert.equal(downloadResponse.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(gmailCalls, [{
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message%2F1/attachments/attachment%2B1",
      authorization: "Bearer stored_google-gmail_access",
    }])
  } finally {
    await server.close()
  }
})

test("google Gmail attachment URL rejects tampered and expired tokens", async () => {
  let now = 1_781_000_000_000
  const server = await startServer({
    now: () => now,
    attachmentDownloadTtlMs: 1_000,
  })

  try {
    const tokenPayload = await connectGoogleConnector(server)
    const toolResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/google/google-gmail/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
          params: {
            name: "download_attachment",
            arguments: {
              messageId: "message_1",
              attachmentId: "attachment_1",
              filename: "archive.zip",
              mimeType: "application/zip",
            },
          },
        }),
      },
    )
    const toolPayload = await toolResponse.json() as {
      result: { structuredContent: { downloadUrl: string } }
    }
    const downloadUrl = toolPayload.result.structuredContent.downloadUrl

    const tamperedResponse = await fetch(`${downloadUrl}tampered`)
    assert.equal(tamperedResponse.status, 401)
    assert.deepEqual(await tamperedResponse.json(), { error: "google_gmail_attachment_token_invalid" })

    now += 1_000
    const expiredResponse = await fetch(downloadUrl)
    assert.equal(expiredResponse.status, 401)
    assert.deepEqual(await expiredResponse.json(), { error: "google_gmail_attachment_token_invalid" })
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
