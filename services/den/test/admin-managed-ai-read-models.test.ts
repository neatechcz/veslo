import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { MySqlDialect } from "drizzle-orm/mysql-core"

import { createAdminRouter } from "../src/http/admin.js"
import { createManagedAiAdminRouteDeps } from "../src/managed-ai/http/admin.js"
import { MySqlUsageRepository } from "../src/managed-ai/usage/mysql-repository.js"

function createUsageDb(rows: unknown[]) {
  let whereClause: unknown

  return {
    db: {
      select() {
        return {
          from() {
            return {
              async where(clause: unknown) {
                whereClause = clause
                return rows
              },
            }
          },
        }
      },
    },
    whereClause() {
      return whereClause
    },
  }
}

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

function createCredential(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Credential ${id}`,
    provider: "openai",
    type: "oauth",
    state: "healthy",
    scope: "platform:openai",
    activeLeases: 2,
    alertCount: 0,
    lastRefreshAt: "2026-04-02T10:00:00.000Z",
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 144,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  }
}

function createSessionRecord(id: string, provider: "openai" | "anthropic", credentialId: string) {
  return {
    id,
    sessionId: "session_shared_1",
    provider,
    userLabel: "Admin",
    orgLabel: "Personal",
    projectLabel: "Gateway rollout",
    workerLabel: "local-runtime",
    credentialId,
    state: "healthy",
    retries: 0,
    lastSeenAt: "2026-04-02T10:10:00.000Z",
    lastFailoverAt: null,
  }
}

function createUsageResponse() {
  return {
    summary: {
      totalTokens: 900,
      totalRequests: 9,
    },
    groupBy: "user",
    filters: {
      credentials: [{ id: "cred_openai_1", label: "Credential cred_openai_1" }],
      users: [{ id: "user_admin", label: "Admin" }],
      orgs: [],
    },
    series: [
      {
        key: "user_admin",
        label: "Admin",
        totalTokens: 900,
        totalRequests: 9,
      },
    ],
    topCredentials: [{ id: "cred_openai_1", label: "Credential cred_openai_1", totalTokens: 900 }],
    topUsers: [{ id: "user_admin", label: "Admin", totalTokens: 900 }],
    topOrgs: [],
    credentialUsage: [],
  }
}

function createCodexStatus() {
  return {
    available: true,
    source: "codex_exec_rate_limits",
    label: "Codex limits available",
    detail: null,
    checkedAt: "2026-04-28T10:00:00.000Z",
    planType: "plus",
    limits: {
      fiveHour: {
        label: "5h",
        usedPercent: 100,
        windowMinutes: 300,
        resetAt: "2026-04-30T18:00:00.000Z",
      },
      weekly: {
        label: "Weekly",
        usedPercent: 33,
        windowMinutes: 10080,
        resetAt: "2026-05-01T12:00:00.000Z",
      },
    },
  }
}

function createAlert(id: string) {
  return {
    id,
    title: "Provider rate limits increasing",
    severity: "high",
    source: "provider-rate-limit",
    status: "active",
    credentialId: "cred_openai_1",
    affectedSessions: 3,
    firstSeenAt: "2026-04-03T10:00:00.000Z",
    lastSeenAt: "2026-04-03T10:05:00.000Z",
    owner: null,
    runbook: "Inspect quota pressure and rotate session load across healthy credentials.",
  }
}

function createAuditEvent(id: string) {
  return {
    id,
    timestamp: "2026-04-02T10:20:00.000Z",
    actor: "admin@example.test",
    action: "credential.rotate",
    entityType: "credential",
    entityId: "cred_openai_1",
    result: "ok",
    summary: "Rotated a gateway credential.",
    changedFields: ["updatedAt"],
  }
}

function createReadModelApp(options: {
  credentials?: ReturnType<typeof createCredential>[]
  usage?: ReturnType<typeof createUsageResponse>
  codexStatusProvider?: { getStatus(input: { credentialId: string; credentialName: string }): Promise<unknown> }
} = {}) {
  const session = createSession()
  const credentials = options.credentials ?? [createCredential("cred_openai_1")]
  const app = express()
  app.use(express.json())
  app.use(
    "/admin/api",
    createAdminRouter({
      async getSessionSnapshot() {
        return session
      },
      ...createManagedAiAdminRouteDeps({
        async getAdminSession() {
          return session
        },
        aiAccess: {} as any,
        alerts: {
          async listAlerts() {
            return [createAlert("alert_health_1")]
          },
        },
        audit: {
          async recordEvent() {
            return
          },
          async listEvents() {
            return [createAuditEvent("audit_repo_1")]
          },
        },
        credentials: {
          async listAdminCredentials() {
            return credentials
          },
        } as any,
        leases: {
          async listAdminSessions() {
            return [
              createSessionRecord("lease_openai_1", "openai", "cred_openai_1"),
              createSessionRecord("lease_anthropic_1", "anthropic", "cred_anthropic_1"),
            ]
          },
        } as any,
        secrets: {} as any,
        usage: {
          async aggregateUsage(input) {
            assert.equal(input.groupBy, options.usage?.groupBy ?? "user")
            return options.usage ?? createUsageResponse()
          },
        } as any,
        codexStatusProvider: options.codexStatusProvider as any,
        now: () => new Date("2026-04-30T12:00:00.000Z"),
      }),
    }),
  )
  return app
}

test("GET /admin/api/credentials returns repository-backed credentials", async () => {
  const app = createReadModelApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      credentials: [
        {
          ...createCredential("cred_openai_1"),
          alertCount: 1,
          linkedAlertIds: ["alert_health_1"],
        },
      ],
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/credentials includes Codex token totals and eligibility", async () => {
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        cachedTokens: 50,
        totalTokens: 0,
      }),
    ],
    codexStatusProvider: {
      async getStatus() {
        return createCodexStatus()
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`)

    assert.equal(response.status, 200)
    const body = await response.json()
    const codex = body.credentials.find((entry: { id: string }) => entry.id === "cred_codex_1")
    const openai = body.credentials.find((entry: { id: string }) => entry.id === "cred_openai_1")
    assert.equal(openai.upstreamStatus, undefined)
    assert.equal(codex.cachedTokens, 50)
    assert.equal(codex.totalTokens, 0)
    assert.equal(codex.upstreamStatus.limits.fiveHour.usedPercent, 100)
    assert.deepEqual(codex.eligibility, {
      state: "exhausted",
      reason: "5h limit exhausted",
      resetAt: "2026-04-30T18:00:00.000Z",
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/sessions returns provider-scoped active leases", async () => {
  const app = createReadModelApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/sessions`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      sessions: [
        createSessionRecord("lease_openai_1", "openai", "cred_openai_1"),
        createSessionRecord("lease_anthropic_1", "anthropic", "cred_anthropic_1"),
      ],
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage aggregates usage by user", async () => {
  const app = createReadModelApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=user`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ...createUsageResponse(),
      credentialUsage: [
        {
          id: "cred_openai_1",
          label: "Credential cred_openai_1",
          name: "Credential cred_openai_1",
          provider: "openai",
          state: "healthy",
          activeLeases: 2,
          cachedTokens: 0,
          totalTokens: 900,
          totalRequests: 0,
          lastUsedAt: null,
          upstreamStatus: null,
        },
      ],
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage includes rich credential usage with cached tokens and Codex eligibility", async () => {
  const usage = {
    ...createUsageResponse(),
    groupBy: "credential" as const,
    series: [
      {
        key: "cred_openai_1",
        label: "cred_openai_1",
        totalTokens: 900,
        totalRequests: 9,
      },
    ],
    credentialUsage: [
      {
        id: "cred_openai_1",
        label: "cred_openai_1",
        cachedTokens: 4,
        totalTokens: 900,
        totalRequests: 9,
      },
    ],
  }
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        cachedTokens: 50,
        totalTokens: 0,
      }),
    ],
    usage,
    codexStatusProvider: {
      async getStatus() {
        return createCodexStatus()
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=credential`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credentialUsage, [
      {
        id: "cred_openai_1",
        label: "Credential cred_openai_1",
        name: "Credential cred_openai_1",
        provider: "openai",
        state: "healthy",
        activeLeases: 2,
        cachedTokens: 4,
        totalTokens: 900,
        totalRequests: 9,
        lastUsedAt: null,
        upstreamStatus: null,
      },
      {
        id: "cred_codex_1",
        label: "Credential cred_codex_1",
        name: "Credential cred_codex_1",
        provider: "codex_oauth",
        state: "healthy",
        activeLeases: 0,
        cachedTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
        lastUsedAt: null,
        upstreamStatus: createCodexStatus(),
        eligibility: {
          state: "exhausted",
          reason: "5h limit exhausted",
          resetAt: "2026-04-30T18:00:00.000Z",
        },
      },
    ])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("MySqlUsageRepository aggregates stored totals by org", async () => {
  const fakeDb = createUsageDb([
    {
      credential_record_id: "cred_openai_1",
      owner_user_id: "user_admin",
      org_id: "org_admin",
      input_tokens: 1,
      output_tokens: 2,
      cached_tokens: 4,
      total_tokens: 99,
    },
  ])
  const repository = new MySqlUsageRepository(fakeDb.db as any)

  const response = await repository.aggregateUsage({
    groupBy: "org",
    credentialId: null,
    userId: null,
    orgId: null,
  })

  assert.deepEqual(response, {
    summary: {
      totalTokens: 99,
      totalRequests: 1,
    },
    groupBy: "org",
    filters: {
      credentials: [{ id: "cred_openai_1", label: "cred_openai_1" }],
      users: [{ id: "user_admin", label: "user_admin" }],
      orgs: [{ id: "org_admin", label: "org_admin" }],
    },
    series: [
      {
        key: "org_admin",
        label: "org_admin",
        totalTokens: 99,
        totalRequests: 1,
      },
    ],
    topCredentials: [{ id: "cred_openai_1", label: "cred_openai_1", totalTokens: 99 }],
    topUsers: [{ id: "user_admin", label: "user_admin", totalTokens: 99 }],
    topOrgs: [{ id: "org_admin", label: "org_admin", totalTokens: 99 }],
    credentialUsage: [
      {
        id: "cred_openai_1",
        label: "cred_openai_1",
        cachedTokens: 4,
        totalTokens: 99,
        totalRequests: 1,
      },
    ],
  })
})

test("MySqlUsageRepository filters unknown org usage with org_id IS NULL", async () => {
  const fakeDb = createUsageDb([])
  const repository = new MySqlUsageRepository(fakeDb.db as any)

  await repository.aggregateUsage({
    groupBy: "org",
    credentialId: null,
    userId: null,
    orgId: "unknown-org",
  })

  const dialect = new MySqlDialect()
  assert.deepEqual(dialect.sqlToQuery(fakeDb.whereClause() as never), {
    sql: "`credential_usage_event`.`org_id` is null",
    params: [],
  })
})

test("GET /admin/api/alerts and /admin/api/audit return managed ai read models", async () => {
  const app = createReadModelApp()
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const alertsResponse = await fetch(`http://127.0.0.1:${port}/admin/api/alerts`)
    assert.equal(alertsResponse.status, 200)
    assert.deepEqual(await alertsResponse.json(), {
      alerts: [createAlert("alert_health_1")],
    })

    const auditResponse = await fetch(`http://127.0.0.1:${port}/admin/api/audit`)
    assert.equal(auditResponse.status, 200)
    assert.deepEqual(await auditResponse.json(), {
      events: [createAuditEvent("audit_repo_1")],
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})
