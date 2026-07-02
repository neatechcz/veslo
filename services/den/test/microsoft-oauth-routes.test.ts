import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { errorMiddleware } from "../src/http/errors.js"
import {
  createUnavailableMicrosoftOAuthClient,
  type MicrosoftOAuthClient,
} from "../src/microsoft/oauth.js"
import {
  InMemoryMicrosoftConnectionStore,
  UnavailableMicrosoftConnectionStore,
  type MicrosoftConnectionStore,
} from "../src/microsoft/store.js"

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
  store?: MicrosoftConnectionStore
  oauth?: MicrosoftOAuthClient
  now?: () => number
  exchange?: (code: string) => Promise<{
    accessToken: string
    refreshToken: string
    expiresAt: string
    scope?: string
  }>
} = {}) {
  const store = input.store ?? new InMemoryMicrosoftConnectionStore()
  const exchangeCalls: string[] = []
  const revokedTokens: string[] = []
  const { createMicrosoftRouter } = await import("../src/http/microsoft.js")
  const oauth = input.oauth ?? {
    startAuthorization: async (input: any) => {
      const authorizeUrl = new URL("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize")
      authorizeUrl.searchParams.set("state", input.state)
      authorizeUrl.searchParams.set("scope", input.scopes.join(" "))
      authorizeUrl.searchParams.set("redirect_uri", input.redirectUri)
      authorizeUrl.searchParams.set("prompt", "consent")
      return { authorizeUrl: authorizeUrl.toString() }
    },
    exchangeCode: async (exchangeInput: any) => {
      exchangeCalls.push(exchangeInput.code)
      return await (input.exchange?.(exchangeInput.code) ?? {
        accessToken: "microsoft_access_token",
        refreshToken: "microsoft_refresh_token",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: "openid profile offline_access https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All",
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
    createMicrosoftRouter({
      stateSecret: "microsoft_state_secret_01234567890123456789",
      successRedirectUrl: "https://app.veslo.work/settings/integrations/microsoft",
      authorize: async (req) => createOrgContext(req.params.orgId),
      store,
      oauth,
      now: input.now,
    }),
  )
  app2.use(errorMiddleware)

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

test("microsoft OAuth start returns a SharePoint authorization URL", async () => {
  const server = await startServer()

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start`,
    )

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      authorizeUrl: string
      state: string
      connectorId: string
      scopes: string[]
    }
    const authorizeUrl = new URL(payload.authorizeUrl)
    assert.equal(authorizeUrl.origin, "https://login.microsoftonline.com")
    assert.equal(authorizeUrl.searchParams.get("state"), payload.state)
    assert.equal(authorizeUrl.searchParams.get("prompt"), "consent")
    assert.equal(payload.connectorId, "microsoft-sharepoint")
    assert.deepEqual(payload.scopes, [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ])
    assert.deepEqual(authorizeUrl.searchParams.get("scope")?.split(" "), payload.scopes)
  } finally {
    await server.close()
  }
})

test("microsoft OAuth start rejects unknown connector ids", async () => {
  const server = await startServer()

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-teams/oauth/start`,
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "unknown_microsoft_connector" })
  } finally {
    await server.close()
  }
})

test("microsoft OAuth start reports unavailable OAuth configuration clearly", async () => {
  const server = await startServer({
    oauth: createUnavailableMicrosoftOAuthClient(),
  })

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start`,
    )

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: "microsoft_oauth_not_configured",
      connectorId: "microsoft-sharepoint",
    })
  } finally {
    await server.close()
  }
})

test("microsoft OAuth callback stores a grant and redirects without token material", async () => {
  const server = await startServer()

  try {
    const startResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start`,
    )
    const startPayload = await startResponse.json() as { state: string }

    const callbackResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/integrations/microsoft/oauth/callback?code=microsoft_code_123&state=${encodeURIComponent(startPayload.state)}`,
      { redirect: "manual" },
    )

    assert.equal(callbackResponse.status, 302)
    const location = callbackResponse.headers.get("location") ?? ""
    assert.match(location, /status=connected/)
    assert.match(location, /provider=microsoft/)
    assert.match(location, /connectorId=microsoft-sharepoint/)
    assert.deepEqual(server.exchangeCalls, ["microsoft_code_123"])
    assert.doesNotMatch(await callbackResponse.text(), /microsoft_(access|refresh)_token/)

    const connections = await server.store.listConnections({ orgId: "org_1", userId: "user_1" })
    assert.equal(connections.length, 1)
    assert.equal(connections[0]?.connectorId, "microsoft-sharepoint")
    assert.equal(connections[0]?.state, "connected")
  } finally {
    await server.close()
  }
})

test("microsoft OAuth callback reports unavailable grant storage clearly", async () => {
  const server = await startServer({
    store: new UnavailableMicrosoftConnectionStore(),
  })

  try {
    const startResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start`,
    )
    const startPayload = await startResponse.json() as { state: string }

    const callbackResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/integrations/microsoft/oauth/callback?code=microsoft_code_123&state=${encodeURIComponent(startPayload.state)}`,
      { redirect: "manual" },
    )

    assert.equal(callbackResponse.status, 503)
    assert.deepEqual(await callbackResponse.json(), {
      error: "microsoft_token_secret_not_configured",
      connectorId: "microsoft-sharepoint",
    })
    assert.deepEqual(server.exchangeCalls, ["microsoft_code_123"])
  } finally {
    await server.close()
  }
})

test("microsoft OAuth callback rejects invalid state before exchanging code", async () => {
  const server = await startServer()

  try {
    const callbackResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/integrations/microsoft/oauth/callback?code=microsoft_code_123&state=not.signed`,
      { redirect: "manual" },
    )

    assert.equal(callbackResponse.status, 400)
    assert.deepEqual(await callbackResponse.json(), { error: "microsoft_oauth_state_invalid" })
    assert.deepEqual(server.exchangeCalls, [])
  } finally {
    await server.close()
  }
})

test("microsoft connection status and disconnect are SharePoint-scoped", async () => {
  const server = await startServer()

  try {
    await server.store.upsertConnection({
      orgId: "org_1",
      userId: "user_1",
      connectorId: "microsoft-sharepoint",
      scopes: [
        "openid",
        "profile",
        "offline_access",
        "https://graph.microsoft.com/Files.Read.All",
        "https://graph.microsoft.com/Sites.Read.All",
      ],
      grant: {
        accessToken: "sharepoint_access",
        refreshToken: "sharepoint_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: "openid profile offline_access https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All",
      },
    })

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/connections`,
    )
    assert.equal(statusResponse.status, 200)
    const statusPayload = await statusResponse.json() as {
      items: Array<{
        connectorId: string
        name: string
        connected: boolean
        state: string
      }>
    }
    assert.deepEqual(statusPayload.items.map((item) => item.connectorId), ["microsoft-sharepoint"])
    assert.equal(statusPayload.items[0]?.name, "Microsoft SharePoint")
    assert.equal(statusPayload.items[0]?.connected, true)
    assert.equal(statusPayload.items[0]?.state, "connected")

    const deleteResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/connection`,
      { method: "DELETE" },
    )
    assert.equal(deleteResponse.status, 200)
    assert.deepEqual(await deleteResponse.json(), {
      ok: true,
      connectorId: "microsoft-sharepoint",
      revokeOk: true,
    })
    assert.deepEqual(server.revokedTokens, ["sharepoint_refresh"])

    const afterDelete = await server.store.listConnections({ orgId: "org_1", userId: "user_1" })
    assert.equal(afterDelete.find((item) => item.connectorId === "microsoft-sharepoint")?.state, "revoked")
  } finally {
    await server.close()
  }
})

test("microsoft MCP route is mounted behind runtime token and grant guards", async () => {
  const server = await startServer()

  try {
    await server.store.upsertConnection({
      orgId: "org_1",
      userId: "user_1",
      connectorId: "microsoft-sharepoint",
      scopes: [
        "openid",
        "profile",
        "offline_access",
        "https://graph.microsoft.com/Files.Read.All",
        "https://graph.microsoft.com/Sites.Read.All",
      ],
      grant: {
        accessToken: "stored_microsoft_access",
        refreshToken: "stored_microsoft_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
      },
    })

    const tokenResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token`,
      { method: "POST" },
    )
    assert.equal(tokenResponse.status, 200)
    const tokenPayload = await tokenResponse.json() as { token: string; connectorId: string; expiresAt: string }
    assert.equal(tokenPayload.connectorId, "microsoft-sharepoint")
    assert.match(tokenPayload.expiresAt, /^20/)

    const proxyResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/mcp`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-veslo-connector-token": tokenPayload.token,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      },
    )

    assert.equal(proxyResponse.status, 501)
    assert.deepEqual(await proxyResponse.json(), {
      error: "microsoft_mcp_tools_not_implemented",
      connectorId: "microsoft-sharepoint",
    })
  } finally {
    await server.close()
  }
})
