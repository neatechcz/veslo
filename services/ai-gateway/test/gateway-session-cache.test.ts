import assert from "node:assert/strict"
import test from "node:test"

import { DenUserSessionResolver } from "../src/auth/user-session.js"

function userResponse(userId: string) {
  return new Response(JSON.stringify({
    user: {
      id: userId,
      email: `${userId}@example.test`,
      name: userId,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("DenUserSessionResolver caches successful lookups for a short TTL", async () => {
  let now = 1_000
  const calls: string[] = []
  const resolver = new DenUserSessionResolver({
    denApiBase: "https://den.example",
    now: () => now,
    sessionCacheTtlMs: 5_000,
    fetchImpl: async (_url, init) => {
      calls.push(String(new Headers(init?.headers).get("authorization")))
      return userResponse(`user-${calls.length}`)
    },
  })

  const first = await resolver.resolveSession("den-token")
  const second = await resolver.resolveSession("den-token")

  assert.equal(first?.user.id, "user-1")
  assert.equal(second?.user.id, "user-1")
  assert.deepEqual(calls, ["Bearer den-token"])

  now = 6_001
  const third = await resolver.resolveSession("den-token")

  assert.equal(third?.user.id, "user-2")
  assert.deepEqual(calls, ["Bearer den-token", "Bearer den-token"])
})

test("DenUserSessionResolver joins concurrent lookups for the same token", async () => {
  let calls = 0
  let releaseLookup: (() => void) | null = null
  const resolver = new DenUserSessionResolver({
    denApiBase: "https://den.example",
    sessionCacheTtlMs: 5_000,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseLookup = resolve
        })
      }
      return userResponse("user-concurrent")
    },
  })

  const first = resolver.resolveSession("den-token")
  const second = resolver.resolveSession("den-token")
  await Promise.resolve()
  assert.equal(calls, 1)

  releaseLookup?.()
  assert.equal((await first)?.user.id, "user-concurrent")
  assert.equal((await second)?.user.id, "user-concurrent")
  assert.equal(calls, 1)
})

test("DenUserSessionResolver isolates bearer tokens that collide under the legacy 32-bit cache hash", async () => {
  const calls: string[] = []
  const resolver = new DenUserSessionResolver({
    denApiBase: "https://den.example",
    fetchImpl: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
      calls.push(token)
      return userResponse(token === "token_5wzx" ? "user-one" : "user-two")
    },
  })

  assert.equal((await resolver.resolveSession("token_5wzx"))?.user.id, "user-one")
  assert.equal((await resolver.resolveSession("token_c6cd"))?.user.id, "user-two")
  assert.deepEqual(calls, ["token_5wzx", "token_c6cd"])
})

test("DenUserSessionResolver does not cache failed lookups", async () => {
  let calls = 0
  const resolver = new DenUserSessionResolver({
    denApiBase: "https://den.example",
    sessionCacheTtlMs: 5_000,
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    },
  })

  assert.equal(await resolver.resolveSession("bad-token"), null)
  assert.equal(await resolver.resolveSession("bad-token"), null)
  assert.equal(calls, 2)
})
