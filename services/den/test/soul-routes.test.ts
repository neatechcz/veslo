import assert from "node:assert/strict"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { errorMiddleware } from "../src/http/errors.js"
import { InMemorySoulStore, type SoulRouteContext } from "../src/soul/store.js"

type TestSession = {
  userId?: string
  orgId?: string | null
  orgRole?: SoulRouteContext["orgRole"]
  isPlatformAdmin?: boolean
}

async function startServer() {
  setupEnv()
  const { createSoulRouter } = await import("../src/http/soul.js")
  const app = express()
  app.use(express.json({ limit: "2mb" }))
  app.use(
    "/v1",
    createSoulRouter({
      store: new InMemorySoulStore(),
      resolveUserContext: async (req, res) => {
        const userId = req.header("x-test-user-id")
        if (!userId) {
          res.status(401).json({ error: "unauthorized" })
          return null
        }
        return { userId }
      },
      resolveOrganizationContext: async (req, res) => {
        const userId = req.header("x-test-user-id")
        const orgId = req.header("x-test-org-id")
        if (!userId || !orgId) {
          res.status(401).json({ error: "unauthorized" })
          return null
        }
        return {
          userId,
          orgId,
          orgRole: (req.header("x-test-org-role") as SoulRouteContext["orgRole"]) ?? "member",
          isPlatformAdmin: req.header("x-test-platform-admin") === "1",
        }
      },
    }),
  )
  app.use(errorMiddleware)

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

async function jsonRequest(baseUrl: string, path: string, init: RequestInit & { session?: TestSession } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  headers.set("x-test-user-id", init.session?.userId ?? "user_1")
  if (init.session?.orgId) headers.set("x-test-org-id", init.session.orgId)
  if (init.session?.orgRole) headers.set("x-test-org-role", init.session.orgRole)
  if (init.session?.isPlatformAdmin) headers.set("x-test-platform-admin", "1")

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

test("PATCH /v1/soul/user stores current User Soul and exposes version history", async () => {
  const server = await startServer()
  try {
    const update = await jsonRequest(server.baseUrl, "/soul/user", {
      method: "PATCH",
      body: JSON.stringify({
        content: "# User Soul\n\n- Remember server-backed data.",
        changeSummary: "Capture server-backed Soul",
        baseVersionId: null,
      }),
    })

    assert.equal(update.response.status, 200)
    assert.equal(update.body.scope, "user")
    assert.equal(update.body.ownerId, "user_1")
    assert.equal(update.body.versions.length, 1)
    assert.equal(update.body.versions[0].content, "# User Soul\n\n- Remember server-backed data.")
    assert.equal(update.body.currentVersionId, update.body.versions[0].id)

    const read = await jsonRequest(server.baseUrl, "/soul/user")
    assert.equal(read.response.status, 200)
    assert.equal(read.body.currentVersionId, update.body.currentVersionId)

    const versions = await jsonRequest(server.baseUrl, "/soul/user/versions")
    assert.equal(versions.response.status, 200)
    assert.deepEqual(versions.body.versions.map((version: { id: string }) => version.id), [update.body.currentVersionId])
    assert.equal(versions.body.nextCursor, null)
  } finally {
    await server.close()
  }
})

test("GET /v1/soul/user/versions returns newest versions first when paginated", async () => {
  const server = await startServer()
  try {
    let baseVersionId: string | null = null
    const savedIds: string[] = []
    for (let index = 1; index <= 3; index += 1) {
      const update = await jsonRequest(server.baseUrl, "/soul/user", {
        method: "PATCH",
        body: JSON.stringify({
          content: `Memory ${index}`,
          changeSummary: `Save ${index}`,
          baseVersionId,
        }),
      })
      assert.equal(update.response.status, 200)
      baseVersionId = update.body.currentVersionId
      savedIds.push(update.body.currentVersionId)
    }

    const versions = await jsonRequest(server.baseUrl, "/soul/user/versions?limit=2")
    assert.equal(versions.response.status, 200)
    assert.deepEqual(
      versions.body.versions.map((version: { id: string }) => version.id),
      [savedIds[2], savedIds[1]],
    )
    assert.equal(versions.body.nextCursor, "2")
  } finally {
    await server.close()
  }
})

test("PATCH /v1/soul/user rejects stale baseVersionId", async () => {
  const server = await startServer()
  try {
    const first = await jsonRequest(server.baseUrl, "/soul/user", {
      method: "PATCH",
      body: JSON.stringify({
        content: "First memory",
        changeSummary: "First save",
        baseVersionId: null,
      }),
    })
    assert.equal(first.response.status, 200)

    const stale = await jsonRequest(server.baseUrl, "/soul/user", {
      method: "PATCH",
      body: JSON.stringify({
        content: "Stale memory",
        changeSummary: "Stale save",
        baseVersionId: null,
      }),
    })
    assert.equal(stale.response.status, 409)
    assert.equal(stale.body.error, "soul_conflict")
  } finally {
    await server.close()
  }
})

test("organization Soul writes require organization admin access", async () => {
  const server = await startServer()
  try {
    const member = await jsonRequest(server.baseUrl, "/soul/organization", {
      method: "PATCH",
      session: { userId: "user_1", orgId: "org_1", orgRole: "member" },
      body: JSON.stringify({
        content: "Org memory",
        changeSummary: "Save org memory",
        baseVersionId: null,
      }),
    })
    assert.equal(member.response.status, 403)
    assert.equal(member.body.error, "organization_soul_admin_required")

    const admin = await jsonRequest(server.baseUrl, "/soul/organization", {
      method: "PATCH",
      session: { userId: "admin_1", orgId: "org_1", orgRole: "organization_admin" },
      body: JSON.stringify({
        content: "Org memory",
        changeSummary: "Save org memory",
        baseVersionId: null,
      }),
    })
    assert.equal(admin.response.status, 200)
    assert.equal(admin.body.scope, "organization")
    assert.equal(admin.body.ownerId, "org_1")
  } finally {
    await server.close()
  }
})

test("POST /v1/soul/user/versions/:versionId/restore creates restore audit version", async () => {
  const server = await startServer()
  try {
    const first = await jsonRequest(server.baseUrl, "/soul/user", {
      method: "PATCH",
      body: JSON.stringify({
        content: "Original memory",
        changeSummary: "Original save",
        baseVersionId: null,
      }),
    })
    const second = await jsonRequest(server.baseUrl, "/soul/user", {
      method: "PATCH",
      body: JSON.stringify({
        content: "Changed memory",
        changeSummary: "Second save",
        baseVersionId: first.body.currentVersionId,
      }),
    })
    assert.equal(second.response.status, 200)

    const restore = await jsonRequest(server.baseUrl, `/soul/user/versions/${encodeURIComponent(first.body.currentVersionId)}/restore`, {
      method: "POST",
      body: JSON.stringify({ changeSummary: "Restore original" }),
    })
    assert.equal(restore.response.status, 200)
    assert.equal(restore.body.versions.length, 3)
    const restored = restore.body.versions[2]
    assert.equal(restored.content, "Original memory")
    assert.equal(restored.source, "restore")
    assert.equal(restored.baseVersionId, second.body.currentVersionId)
    assert.equal(restored.restoreSourceVersionId, first.body.currentVersionId)
    assert.equal(restore.body.currentVersionId, restored.id)
  } finally {
    await server.close()
  }
})

test("den index mounts the DB-backed Soul router under /v1", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /import \{ createSoulRouter \} from "\.\/http\/soul\.js"/)
  assert.match(source, /app\.use\("\/v1", createSoulRouter\(\)\)/)
})
