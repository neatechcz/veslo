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

function createMockResponse() {
  return {
    statusCode: 200,
    body: null as unknown,
    ended: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    end() {
      this.ended = true
      return this
    },
  }
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

test("createDesktopAuthHandlers.createHandoff requires an authenticated session", async () => {
  const { createDesktopAuthHandlers } = await loadDesktopAuthModule()
  const res = createMockResponse()
  let inserted = false

  const handlers = createDesktopAuthHandlers({
    apiBaseUrl: "https://api.veslo.test",
    getSessionContext: async (_req, response) => {
      response.status(401).json({ error: "unauthorized" })
      return null
    },
    resolveOrganization: async () => {
      throw new Error("resolveOrganization should not be called")
    },
    insertHandoff: async () => {
      inserted = true
    },
    findHandoffByCode: async () => null,
    markHandoffConsumed: async () => false,
    loadUserSummary: async () => null,
    loadOrganizationSummary: async () => null,
  })

  await handlers.createHandoff({ body: {} } as any, res as any)

  assert.equal(res.statusCode, 401)
  assert.equal(inserted, false)
})

test("createDesktopAuthHandlers.createHandoff binds the handoff to the resolved organization", async () => {
  const { createDesktopAuthHandlers } = await loadDesktopAuthModule()
  const res = createMockResponse()
  const inserted: Array<Record<string, unknown>> = []

  const handlers = createDesktopAuthHandlers({
    apiBaseUrl: "https://api.veslo.test",
    now: () => new Date("2026-03-09T10:00:00.000Z"),
    createId: () => "handoff-1",
    createCode: () => "code-1",
    getSessionContext: async () => ({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "Veslo User",
      },
      sessionToken: "session-token-1",
    }),
    resolveOrganization: async (_session, requestedOrgId) => ({
      ok: true,
      organization: {
        id: requestedOrgId ?? "org-default",
        name: "Personal",
        slug: "personal",
        ownerUserId: "user-1",
      },
    }),
    insertHandoff: async (record) => {
      inserted.push(record)
    },
    findHandoffByCode: async () => null,
    markHandoffConsumed: async () => false,
    loadUserSummary: async () => null,
    loadOrganizationSummary: async () => null,
  })

  await handlers.createHandoff({ body: { orgId: "org-1" } } as any, res as any)

  assert.equal(res.statusCode, 201)
  assert.deepEqual(inserted, [
    {
      id: "handoff-1",
      code: "code-1",
      user_id: "user-1",
      org_id: "org-1",
      session_token: "session-token-1",
      expires_at: new Date("2026-03-09T10:05:00.000Z"),
      consumed_at: null,
      created_at: new Date("2026-03-09T10:00:00.000Z"),
    },
  ])
  assert.deepEqual(res.body, {
    code: "code-1",
    expiresAt: "2026-03-09T10:05:00.000Z",
    organization: {
      id: "org-1",
      name: "Personal",
      slug: "personal",
      ownerUserId: "user-1",
    },
  })
})

test("createDesktopAuthHandlers.exchange returns desktop auth state and consumes the code once", async () => {
  const { createDesktopAuthHandlers } = await loadDesktopAuthModule()
  const res = createMockResponse()
  const consumed: Array<{ id: string; consumedAt: Date }> = []

  const handlers = createDesktopAuthHandlers({
    apiBaseUrl: "https://api.veslo.test",
    now: () => new Date("2026-03-09T10:01:00.000Z"),
    getSessionContext: async () => null,
    resolveOrganization: async () => ({ ok: false, status: 400, error: "organization_forbidden" }),
    insertHandoff: async () => undefined,
    findHandoffByCode: async (code) => ({
      id: "handoff-1",
      code,
      user_id: "user-1",
      org_id: "org-1",
      session_token: "session-token-1",
      expires_at: new Date("2026-03-09T10:05:00.000Z"),
      consumed_at: null,
      created_at: new Date("2026-03-09T10:00:00.000Z"),
    }),
    markHandoffConsumed: async (id, consumedAt) => {
      consumed.push({ id, consumedAt })
      return true
    },
    loadUserSummary: async () => ({
      id: "user-1",
      email: "user@example.com",
      name: "Veslo User",
    }),
    loadOrganizationSummary: async () => ({
      id: "org-1",
      name: "Personal",
      slug: "personal",
      ownerUserId: "user-1",
    }),
  })

  await handlers.exchange({ body: { code: "code-1" } } as any, res as any)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(consumed, [
    {
      id: "handoff-1",
      consumedAt: new Date("2026-03-09T10:01:00.000Z"),
    },
  ])
  assert.deepEqual(res.body, {
    apiBaseUrl: "https://api.veslo.test",
    token: "session-token-1",
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "Veslo User",
    },
    organization: {
      id: "org-1",
      name: "Personal",
      slug: "personal",
      ownerUserId: "user-1",
    },
  })
})

test("createDesktopAuthHandlers.exchange rejects already-consumed handoffs", async () => {
  const { createDesktopAuthHandlers } = await loadDesktopAuthModule()
  const res = createMockResponse()

  const handlers = createDesktopAuthHandlers({
    apiBaseUrl: "https://api.veslo.test",
    now: () => new Date("2026-03-09T10:01:00.000Z"),
    getSessionContext: async () => null,
    resolveOrganization: async () => ({ ok: false, status: 400, error: "organization_forbidden" }),
    insertHandoff: async () => undefined,
    findHandoffByCode: async (code) => ({
      id: "handoff-1",
      code,
      user_id: "user-1",
      org_id: "org-1",
      session_token: "session-token-1",
      expires_at: new Date("2026-03-09T10:05:00.000Z"),
      consumed_at: new Date("2026-03-09T10:00:30.000Z"),
      created_at: new Date("2026-03-09T10:00:00.000Z"),
    }),
    markHandoffConsumed: async () => {
      throw new Error("markHandoffConsumed should not be called")
    },
    loadUserSummary: async () => null,
    loadOrganizationSummary: async () => null,
  })

  await handlers.exchange({ body: { code: "code-1" } } as any, res as any)

  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.body, {
    error: "desktop_auth_code_consumed",
  })
})
