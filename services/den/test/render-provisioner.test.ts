import assert from "node:assert/strict"
import test from "node:test"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  process.env.PROVISIONER_MODE = "render"
  process.env.RENDER_API_BASE = "https://api.render.com/v1"
  process.env.RENDER_API_KEY = "test-render-key"
  process.env.RENDER_OWNER_ID = "test-owner-id"
  process.env.RENDER_WORKER_VESLO_VERSION = "0.11.113"
}

test("render provisioner uses install command compatible with published orchestrator package", () => {
  return (async () => {
    setupEnv()
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body?: string }> = []

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url === "https://api.render.com/v1/services" && method === "POST") {
        return new Response(JSON.stringify({ service: { id: "svc_test" } }), { status: 200 })
      }

      if (url === "https://api.render.com/v1/services/svc_test/deploys?limit=1" && method === "GET") {
        return new Response(JSON.stringify([{ deploy: { id: "dep_test", status: "live" } }]), { status: 200 })
      }

      if (url === "https://api.render.com/v1/services/svc_test" && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "svc_test",
            serviceDetails: {
              url: "https://worker.example",
              region: "oregon",
            },
          }),
          { status: 200 },
        )
      }

      if (url === "https://worker.example/health" && method === "GET") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      throw new Error(`unexpected fetch in test: ${method} ${url}`)
    }

    try {
      const { provisionWorker } = await import("../src/workers/provisioner.js")
      const result = await provisionWorker({
        workerId: "11111111-2222-3333-4444-555555555555",
        name: "cloud-check",
        hostToken: "host-token",
        clientToken: "client-token",
      })

      assert.equal(result.provider, "render")
      assert.equal(result.status, "healthy")
      assert.equal(result.url, "https://worker.example")

      const createCall = calls.find((entry) => entry.url === "https://api.render.com/v1/services" && entry.method === "POST")
      assert.ok(createCall?.body, "expected Render service create payload")

      const payload = JSON.parse(createCall.body) as {
        serviceDetails?: { envSpecificDetails?: { buildCommand?: string } }
      }

      const buildCommand = payload.serviceDetails?.envSpecificDetails?.buildCommand ?? ""
      assert.match(buildCommand, /openwork-orchestrator@/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })()
})
