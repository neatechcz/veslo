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

test("org mcp catalog returns an empty list for allowed org access", async () => {
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
    assert.deepEqual(await response.json(), { items: [] })
    assert.deepEqual(calls, [{ orgId: "org_1", minimumRole: "member" }])
  } finally {
    await server.close()
  }
})

test("den index mounts org mcp catalog router under /v1/orgs", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /app\.use\("\/v1\/orgs",\s*orgMcpCatalogRouter\)/)
})
