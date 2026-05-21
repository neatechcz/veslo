import assert from "node:assert/strict"
import test from "node:test"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  process.env.PROVISIONER_MODE = "owned-server"
  process.env.OWNED_WORKER_MANAGER_URL = "http://worker-manager:8790"
  process.env.OWNED_WORKER_MANAGER_TOKEN = "owned-manager-token"
  process.env.OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX = "workers.veslo.work"
}

test("owned-server provisioner calls internal worker manager with bearer auth", () => {
  return (async () => {
    setupEnv()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = []

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({
        url,
        method,
        authorization: headers.get("authorization"),
        body,
      })

      if (url === "http://worker-manager:8790/workers" && method === "POST") {
        return new Response(
          JSON.stringify({
            worker: {
              id: "11111111-2222-3333-4444-555555555555",
              provider: "owned-server",
              url: "https://11111111-2222-3333-4444-555555555555.workers.veslo.work",
              status: "healthy",
              region: "owned-server",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (
        url === "http://worker-manager:8790/workers/11111111-2222-3333-4444-555555555555" &&
        method === "DELETE"
      ) {
        return new Response(null, { status: 204 })
      }

      throw new Error(`unexpected fetch in test: ${method} ${url}`)
    }

    try {
      const { deprovisionWorker, provisionWorker } = await import("../src/workers/provisioner.js")
      const result = await provisionWorker({
        workerId: "11111111-2222-3333-4444-555555555555",
        name: "owned cloud check",
        hostToken: "host-token",
        clientToken: "client-token",
      })

      assert.equal(result.provider, "owned-server")
      assert.equal(result.status, "healthy")
      assert.equal(result.region, "owned-server")
      assert.equal(result.url, "https://11111111-2222-3333-4444-555555555555.workers.veslo.work")

      const createCall = calls.find((entry) => entry.method === "POST")
      assert.ok(createCall?.body, "expected worker manager create request")
      assert.equal(createCall.authorization, "Bearer owned-manager-token")

      const createPayload = JSON.parse(createCall.body) as {
        workerId?: string
        name?: string
        hostToken?: string
        clientToken?: string
        publicDomainSuffix?: string
      }
      assert.equal(createPayload.workerId, "11111111-2222-3333-4444-555555555555")
      assert.equal(createPayload.name, "owned cloud check")
      assert.equal(createPayload.hostToken, "host-token")
      assert.equal(createPayload.clientToken, "client-token")
      assert.equal(createPayload.publicDomainSuffix, "workers.veslo.work")

      await deprovisionWorker({
        workerId: "11111111-2222-3333-4444-555555555555",
        instanceUrl: result.url,
      })

      const deleteCall = calls.find((entry) => entry.method === "DELETE")
      assert.equal(deleteCall?.authorization, "Bearer owned-manager-token")
      assert.equal(deleteCall?.url, "http://worker-manager:8790/workers/11111111-2222-3333-4444-555555555555")
    } finally {
      globalThis.fetch = originalFetch
    }
  })()
})
