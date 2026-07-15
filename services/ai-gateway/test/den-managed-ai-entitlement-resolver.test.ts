import assert from "node:assert/strict"
import test from "node:test"

import {
  DenManagedAiEntitlementResolver,
  ManagedAiEntitlementLookupError,
} from "../src/billing/den-managed-ai-entitlement-resolver.js"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("DEN entitlement resolver sends user auth and org context and caches allow and deny decisions briefly", async () => {
  let now = 1_000
  const calls: Array<{ url: string; authorization: string | null; orgId: string | null }> = []
  let canUseManagedAi = true
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test/",
    now: () => now,
    cacheTtlMs: 5_000,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        authorization: headers.get("authorization"),
        orgId: headers.get("x-veslo-org-id"),
      })
      return jsonResponse({ orgId: "org_1", canUseManagedAi })
    },
  })

  assert.deepEqual(await resolver.resolve({ token: "den-token", requestedOrgId: "org_1" }), {
    orgId: "org_1",
    canUseManagedAi: true,
  })
  canUseManagedAi = false
  assert.equal((await resolver.resolve({ token: "den-token", requestedOrgId: "org_1" })).canUseManagedAi, true)
  now = 6_001
  assert.equal((await resolver.resolve({ token: "den-token", requestedOrgId: "org_1" })).canUseManagedAi, false)
  assert.deepEqual(calls, [
    {
      url: "https://den.example.test/v1/managed-ai/entitlement",
      authorization: "Bearer den-token",
      orgId: "org_1",
    },
    {
      url: "https://den.example.test/v1/managed-ai/entitlement",
      authorization: "Bearer den-token",
      orgId: "org_1",
    },
  ])
})

test("DEN entitlement resolver coalesces concurrent lookups for the same token and org", async () => {
  let calls = 0
  let release: (() => void) | null = null
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    fetchImpl: async () => {
      calls += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return jsonResponse({ orgId: "org_1", canUseManagedAi: true })
    },
  })

  const first = resolver.resolve({ token: "den-token", requestedOrgId: "org_1" })
  const second = resolver.resolve({ token: "den-token", requestedOrgId: "org_1" })
  await Promise.resolve()
  assert.equal(calls, 1)
  release?.()
  assert.deepEqual(await first, await second)
})

test("DEN entitlement resolver isolates bearer tokens that collide under the legacy 32-bit cache hash", async () => {
  const calls: string[] = []
  const decisions = new Map([
    ["token_5wzx", true],
    ["token_c6cd", false],
  ])
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    fetchImpl: async (_input, init) => {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
      calls.push(token)
      return jsonResponse({ orgId: "org_1", canUseManagedAi: decisions.get(token) })
    },
  })

  assert.equal((await resolver.resolve({ token: "token_5wzx", requestedOrgId: "org_1" })).canUseManagedAi, true)
  assert.equal((await resolver.resolve({ token: "token_c6cd", requestedOrgId: "org_1" })).canUseManagedAi, false)
  assert.deepEqual(calls, ["token_5wzx", "token_c6cd"])
})

test("DEN entitlement resolver never caches unavailable or malformed responses", async () => {
  let calls = 0
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error("network unavailable")
      return jsonResponse({ orgId: "other_org", canUseManagedAi: true })
    },
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      resolver.resolve({ token: "den-token", requestedOrgId: "org_1" }),
      (error: unknown) => error instanceof ManagedAiEntitlementLookupError
        && error.code === "managed_ai_entitlement_unavailable"
        && error.status === 503,
    )
  }
  assert.equal(calls, 2)
})

test("DEN entitlement resolver aborts stalled DEN lookups and does not cache the timeout", async () => {
  let calls = 0
  let aborts = 0
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      calls += 1
      return new Promise<Response>((resolve, reject) => {
        const fallback = setTimeout(() => {
          resolve(jsonResponse({ orgId: "org_1", canUseManagedAi: true }))
        }, 30)
        const signal = init?.signal
        signal?.addEventListener("abort", () => {
          clearTimeout(fallback)
          aborts += 1
          reject(signal.reason)
        }, { once: true })
      })
    },
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      resolver.resolve({ token: "den-token", requestedOrgId: "org_1" }),
      (error: unknown) => error instanceof ManagedAiEntitlementLookupError
        && error.code === "managed_ai_entitlement_unavailable",
    )
  }
  assert.equal(calls, 2)
  assert.equal(aborts, 2)
})

test("DEN entitlement resolver bounds cached token and organization decisions", async () => {
  let calls = 0
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    cacheMaxEntries: 2,
    fetchImpl: async (_input, init) => {
      calls += 1
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
      return jsonResponse({ orgId: "org_1", canUseManagedAi: token !== "token-denied" })
    },
  })

  await resolver.resolve({ token: "token-one", requestedOrgId: "org_1" })
  await resolver.resolve({ token: "token-two", requestedOrgId: "org_1" })
  await resolver.resolve({ token: "token-three", requestedOrgId: "org_1" })
  await resolver.resolve({ token: "token-one", requestedOrgId: "org_1" })
  assert.equal(calls, 4)
})

test("DEN entitlement resolver keeps the timeout active while reading the DEN response body", async () => {
  let aborts = 0
  const resolver = new DenManagedAiEntitlementResolver({
    denApiBase: "https://den.example.test",
    timeoutMs: 5,
    fetchImpl: async (_input, init) => ({
      ok: true,
      status: 200,
      async json() {
        return new Promise((resolve, reject) => {
          const fallback = setTimeout(() => {
            resolve({ orgId: "org_1", canUseManagedAi: true })
          }, 30)
          const signal = init?.signal
          signal?.addEventListener("abort", () => {
            clearTimeout(fallback)
            aborts += 1
            reject(signal.reason)
          }, { once: true })
        })
      },
    }) as Response,
  })

  await assert.rejects(
    resolver.resolve({ token: "den-token", requestedOrgId: "org_1" }),
    (error: unknown) => error instanceof ManagedAiEntitlementLookupError
      && error.code === "managed_ai_entitlement_unavailable",
  )
  assert.equal(aborts, 1)
})

test("DEN entitlement resolver preserves only safe organization-context errors", async () => {
  const cases = [
    { denStatus: 400, denError: "org_context_required", status: 400, code: "org_context_required" },
    { denStatus: 403, denError: "organization_forbidden", status: 403, code: "organization_forbidden" },
    { denStatus: 404, denError: "organization_required", status: 404, code: "organization_required" },
    { denStatus: 500, denError: "database_url_secret", status: 503, code: "managed_ai_entitlement_unavailable" },
  ]

  for (const entry of cases) {
    const resolver = new DenManagedAiEntitlementResolver({
      denApiBase: "https://den.example.test",
      fetchImpl: async () => jsonResponse({ error: entry.denError, billing: { secret: "must-not-leak" } }, entry.denStatus),
    })
    await assert.rejects(
      resolver.resolve({ token: "den-token", requestedOrgId: null }),
      (error: unknown) => error instanceof ManagedAiEntitlementLookupError
        && error.code === entry.code
        && error.status === entry.status
        && !error.message.includes("must-not-leak")
        && !error.message.includes("database_url_secret"),
    )
  }
})
