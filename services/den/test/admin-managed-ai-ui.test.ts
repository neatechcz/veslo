import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
  MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
})

const { createManagedAiAdminUiRouter } = await import("../src/managed-ai/http/admin.js")

function createSession() {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  }
}

function createUiApp() {
  const app = express()
  app.use(express.json())
  app.use(
    createManagedAiAdminUiRouter({
      async getAdminSession() {
        return createSession()
      },
      openAiOAuth: {
        async startAuthorization() {
          return { authorizeUrl: "https://auth.openai.com/oauth/authorize?client_id=test" }
        },
        async exchangeCode() {
          throw new Error("unused")
        },
        async refreshToken() {
          throw new Error("unused")
        },
      },
      alerts: {
        async listAlerts() {
          return []
        },
      },
      audit: {
        async recordEvent() {
          return
        },
      },
      credentials: {
        async listAdminCredentials() {
          return []
        },
      } as any,
      secrets: {} as any,
    }),
  )
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" })
  })
  return app
}

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>) {
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const { port } = server.address() as AddressInfo
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
    await once(server, "close")
  }
}

test("GET /admin redirects to the canonical AI Gateway admin", async () => {
  await withServer(createUiApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin`, { redirect: "manual" })

    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "https://ai.veslo.work/admin")
  })
})

test("GET /admin subpages redirect to matching AI Gateway admin subpages", async () => {
  await withServer(createUiApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/credentials?provider=codex_oauth`, { redirect: "manual" })

    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "https://ai.veslo.work/admin/credentials?provider=codex_oauth")
  })
})

test("GET /admin/app.js no longer serves a DEN admin frontend asset", async () => {
  await withServer(createUiApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/app.js`, { redirect: "manual" })

    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "https://ai.veslo.work/admin/app.js")
  })
})

test("DEN admin API paths are preserved as API routes instead of redirected page traffic", async () => {
  await withServer(createUiApp(), async (baseUrl) => {
    const apiRootResponse = await fetch(`${baseUrl}/admin/api`, { redirect: "manual" })
    assert.equal(apiRootResponse.status, 404)
    assert.equal(apiRootResponse.headers.get("location"), null)

    const missingApiResponse = await fetch(`${baseUrl}/admin/api/credentials`, { redirect: "manual" })

    assert.equal(missingApiResponse.status, 404)
    assert.equal(missingApiResponse.headers.get("location"), null)

    const oauthResponse = await fetch(`${baseUrl}/admin/api/credentials/openai/oauth/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      redirect: "manual",
    })
    assert.equal(oauthResponse.status, 200)
    const payload = await oauthResponse.json()
    assert.match(payload.authorizeUrl, /https:\/\/auth\.openai\.com\/oauth\/authorize/)
    assert.equal(typeof payload.state, "string")
  })
})
