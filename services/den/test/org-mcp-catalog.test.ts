import assert from "node:assert/strict"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

async function loadRouter() {
  setupEnv()
  return import("../src/http/org-mcp-catalog.js")
}

async function startServer(authorize: (req: any, res: any, options: any) => Promise<unknown>) {
  const { createOrgMcpCatalogRouter } = await loadRouter()
  const app = express()
  app.use("/v1/orgs", createOrgMcpCatalogRouter({ authorize }))

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

test("org mcp catalog requires an authenticated session", async () => {
  const authorizeCalls: Array<{ orgId: string; minimumRole: string }> = []
  const server = await startServer(async (_req, res, options) => {
    authorizeCalls.push({
      orgId: options.orgId,
      minimumRole: options.minimumRole,
    })
    res.status(401).json({ error: "unauthorized" })
    return null
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
    assert.deepEqual(authorizeCalls, [{ orgId: "org_1", minimumRole: "member" }])
  } finally {
    await server.close()
  }
})

test("org mcp catalog authorizes allowed org access", async () => {
  const calls: Array<{ orgId: string; minimumRole: string }> = []
  const server = await startServer(async (req, _res, options) => {
    calls.push({
      orgId: options.orgId,
      minimumRole: options.minimumRole,
    })

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
        id: req.params.orgId,
        name: "Org One",
        slug: "org-one",
        ownerUserId: "user_1",
      },
      membershipId: "membership_1",
      orgRole: "member",
      isPlatformAdmin: false,
    }
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`)
    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{ orgId: "org_1", minimumRole: "member" }])
  } finally {
    await server.close()
  }
})

test("org mcp catalog includes platform Google Workspace connectors", async () => {
  const server = await startServer(async (req, _res, options) => ({
    session: {
      user: {
        id: "user_1",
        email: "user@example.com",
        emailVerified: true,
        name: "User One",
      },
    },
    organization: {
      id: req.params.orgId,
      name: "Org One",
      slug: "org-one",
      ownerUserId: "user_1",
    },
    membershipId: "membership_1",
    orgRole: "member",
    isPlatformAdmin: false,
  }))

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`)
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      items: Array<{
        id: string
        name: string
        config: {
          type: string
          url: string
          oauth: boolean
          headers?: Record<string, string>
        }
        source: { scope: string }
        provider?: { id: string; group: string }
        authorization?: {
          type: string
          provider: string
          connectorId: string
          scopes: string[]
          startPath: string
          runtimeTokenPath: string
          statusPath: string
          disconnectPath: string
        }
      }>
    }

    assert.deepEqual(payload.items.map((item) => item.id), [
      "google-gmail",
      "google-calendar",
      "google-drive",
    ])

    const expectedConnectors = [
      {
        id: "google-gmail",
        urlPattern: /\/v1\/orgs\/org_1\/integrations\/google\/google-gmail\/mcp$/,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      },
      {
        id: "google-calendar",
        urlPattern: /\/v1\/orgs\/org_1\/integrations\/google\/google-calendar\/mcp$/,
        scopes: [
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.freebusy",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ],
      },
      {
        id: "google-drive",
        urlPattern: /\/v1\/orgs\/org_1\/integrations\/google\/google-drive\/mcp$/,
        scopes: [
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
        ],
      },
    ]

    const itemsById = new Map(payload.items.map((item) => [item.id, item]))

    for (const expected of expectedConnectors) {
      const item = itemsById.get(expected.id)
      assert.ok(item, `missing ${expected.id}`)
      assert.equal(item.source.scope, "platform")
      assert.equal(item.provider?.id, "google")
      assert.equal(item.config.type, "remote")
      assert.match(item.config.url, expected.urlPattern)
      assert.equal(item.config.oauth, false)
      assert.equal(item.config.headers?.["X-Veslo-Connector"], expected.id)
      assert.equal(item.authorization?.type, "veslo-server-oauth")
      assert.equal(item.authorization?.provider, "google")
      assert.equal(item.authorization?.connectorId, expected.id)
      assert.deepEqual(item.authorization?.scopes, expected.scopes)
      assert.equal(
        item.authorization?.startPath,
        `/v1/orgs/org_1/integrations/google/${expected.id}/oauth/start`,
      )
      assert.equal(
        item.authorization?.runtimeTokenPath,
        `/v1/orgs/org_1/integrations/google/${expected.id}/runtime-token`,
      )
      assert.equal(item.authorization?.statusPath, "/v1/orgs/org_1/integrations/google/connections")
      assert.equal(
        item.authorization?.disconnectPath,
        `/v1/orgs/org_1/integrations/google/${expected.id}/connection`,
      )
    }

    const serializedPayload = JSON.stringify(payload)
    assert.doesNotMatch(serializedPayload, /VESLO_GOOGLE_MCP_CLIENT_ID/)
    assert.doesNotMatch(serializedPayload, /VESLO_GOOGLE_MCP_CLIENT_SECRET/)
    assert.doesNotMatch(serializedPayload, /clientSecret/)
  } finally {
    await server.close()
  }
})

test("den index mounts org mcp catalog router under /v1/orgs", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /app\.use\("\/v1\/orgs",\s*createOrgMcpCatalogRouter\(/)
  assert.match(source, /connectorBaseUrl:\s*env\.googleWorkspace\.connectorBaseUrl/)
})
