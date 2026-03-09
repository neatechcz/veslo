import assert from "node:assert/strict"
import test from "node:test"
import { DesktopAuthHandoffTable } from "../src/db/schema.js"

function primeDenEnv() {
  process.env.DATABASE_URL ??= "mysql://veslo:test@127.0.0.1:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "https://api.veslo.test"
}

async function loadDesktopAuthModule() {
  primeDenEnv()
  return import(`../src/http/desktop-auth.js?ts=${Date.now()}`)
}

test("desktop auth handoff schema exposes required columns", () => {
  assert.ok(DesktopAuthHandoffTable.id)
  assert.ok(DesktopAuthHandoffTable.code)
  assert.ok(DesktopAuthHandoffTable.user_id)
  assert.ok(DesktopAuthHandoffTable.org_id)
  assert.ok(DesktopAuthHandoffTable.session_token)
  assert.ok(DesktopAuthHandoffTable.expires_at)
  assert.ok(DesktopAuthHandoffTable.consumed_at)
  assert.ok(DesktopAuthHandoffTable.created_at)
})

test("buildDesktopAuthHandoffRecord creates single-use handoff metadata", async () => {
  const { DESKTOP_AUTH_HANDOFF_TTL_MS, buildDesktopAuthHandoffRecord } = await loadDesktopAuthModule()
  const now = new Date("2026-03-09T10:00:00.000Z")

  const result = buildDesktopAuthHandoffRecord({
    userId: "user-1",
    orgId: "org-1",
    sessionToken: "session-token-1",
    now,
    createId: () => "handoff-1",
    createCode: () => "code-1",
  })

  assert.deepEqual(result, {
    id: "handoff-1",
    code: "code-1",
    user_id: "user-1",
    org_id: "org-1",
    session_token: "session-token-1",
    expires_at: new Date(now.getTime() + DESKTOP_AUTH_HANDOFF_TTL_MS),
    consumed_at: null,
    created_at: now,
  })
})

test("resolveDesktopAuthHandoffStatus rejects expired and consumed handoffs", async () => {
  const { resolveDesktopAuthHandoffStatus } = await loadDesktopAuthModule()
  const now = new Date("2026-03-09T10:00:00.000Z")

  assert.deepEqual(
    resolveDesktopAuthHandoffStatus({
      expires_at: new Date("2026-03-09T09:59:59.000Z"),
      consumed_at: null,
    }, now),
    { ok: false, error: "expired" },
  )

  assert.deepEqual(
    resolveDesktopAuthHandoffStatus({
      expires_at: new Date("2026-03-09T10:05:00.000Z"),
      consumed_at: new Date("2026-03-09T10:01:00.000Z"),
    }, now),
    { ok: false, error: "consumed" },
  )

  assert.deepEqual(
    resolveDesktopAuthHandoffStatus({
      expires_at: new Date("2026-03-09T10:05:00.000Z"),
      consumed_at: null,
    }, now),
    { ok: true },
  )
})

test("buildDesktopAuthExchangePayload returns desktop cloud auth state", async () => {
  const { buildDesktopAuthExchangePayload } = await loadDesktopAuthModule()

  assert.deepEqual(
    buildDesktopAuthExchangePayload({
      apiBaseUrl: "https://api.veslo.test",
      token: "desktop-session-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "Veslo User",
      },
      organization: {
        id: "org-1",
        name: "Personal",
        slug: "personal-org",
        ownerUserId: "user-1",
      },
    }),
    {
      apiBaseUrl: "https://api.veslo.test",
      token: "desktop-session-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "Veslo User",
      },
      organization: {
        id: "org-1",
        name: "Personal",
        slug: "personal-org",
        ownerUserId: "user-1",
      },
    },
  )
})
