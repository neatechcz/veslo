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
    capacity: {
      codexCredentials: {
        total: 0,
        measurable: 0,
        unknown: 0,
        unavailable: 0,
      },
      fiveHour: {
        usedPercent: null,
        remainingPercent: null,
        measurableCredentials: 0,
      },
      weekly: {
        usedPercent: null,
        remainingPercent: null,
        measurableCredentials: 0,
      },
      credentials: [],
    },
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
  onAggregateUsageInput?: (input: {
    groupBy: string
    credentialId: string | null
    userId: string | null
    orgId: string | null
  }) => void
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
            options.onAggregateUsageInput?.(input)
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
    assert.deepEqual(body.capacity, {
      codexCredentials: {
        total: 1,
        measurable: 1,
        unknown: 0,
        unavailable: 0,
      },
      fiveHour: {
        usedPercent: 100,
        remainingPercent: 0,
        measurableCredentials: 1,
      },
      weekly: {
        usedPercent: 33,
        remainingPercent: 67,
        measurableCredentials: 1,
      },
      credentials: [{
        id: "cred_codex_1",
        name: "Credential cred_codex_1",
        state: "healthy",
        fiveHourRemainingPercent: 0,
        weeklyRemainingPercent: 67,
        statusAvailable: true,
        limitsAvailable: true,
      }],
    })
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

test("GET /admin/api/usage keeps capacity overview based on the full Codex pool under usage filters", async () => {
  const usage = {
    ...createUsageResponse(),
    groupBy: "user" as const,
    credentialUsage: [
      {
        id: "cred_codex_1",
        label: "cred_codex_1",
        cachedTokens: 9,
        totalTokens: 90,
        totalRequests: 2,
      },
    ],
    topCredentials: [{ id: "cred_codex_1", label: "cred_codex_1", totalTokens: 90 }],
  }
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_codex_2", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    usage,
    codexStatusProvider: {
      async getStatus(input) {
        return {
          ...createCodexStatus(),
          limits: {
            fiveHour: {
              label: "5h",
              usedPercent: input.credentialId === "cred_codex_1" ? 20 : 80,
              windowMinutes: 300,
              resetAt: "2026-04-30T18:00:00.000Z",
            },
            weekly: {
              label: "Weekly",
              usedPercent: input.credentialId === "cred_codex_1" ? 40 : 60,
              windowMinutes: 10080,
              resetAt: "2026-05-01T12:00:00.000Z",
            },
          },
        }
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=user&userId=user_admin`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credentialUsage.map((entry: { id: string }) => entry.id), ["cred_codex_1"])
    assert.deepEqual(body.capacity.codexCredentials, {
      total: 2,
      measurable: 2,
      unknown: 0,
      unavailable: 0,
    })
    assert.deepEqual(body.capacity.fiveHour, {
      usedPercent: 50,
      remainingPercent: 50,
      measurableCredentials: 2,
    })
    assert.deepEqual(body.capacity.weekly, {
      usedPercent: 50,
      remainingPercent: 50,
      measurableCredentials: 2,
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage separates unknown and unavailable Codex capacity from measurable remaining capacity", async () => {
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_codex_measured", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_codex_unknown", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_codex_unavailable", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    usage: {
      ...createUsageResponse(),
      groupBy: "credential" as const,
    },
    codexStatusProvider: {
      async getStatus(input) {
        if (input.credentialId === "cred_codex_unknown") {
          return {
            ...createCodexStatus(),
            source: "codex_exec_no_rate_limits",
            label: "Codex OK, limits unknown",
            limits: null,
          }
        }
        if (input.credentialId === "cred_codex_unavailable") {
          return null
        }
        return {
          ...createCodexStatus(),
          limits: {
            fiveHour: {
              label: "5h",
              usedPercent: 80,
              windowMinutes: 300,
              resetAt: "2026-04-30T18:00:00.000Z",
            },
            weekly: {
              label: "Weekly",
              usedPercent: 95,
              windowMinutes: 10080,
              resetAt: "2026-05-01T12:00:00.000Z",
            },
          },
        }
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
    assert.deepEqual(body.capacity.codexCredentials, {
      total: 3,
      measurable: 1,
      unknown: 1,
      unavailable: 1,
    })
    assert.deepEqual(body.capacity.fiveHour, {
      usedPercent: 80,
      remainingPercent: 20,
      measurableCredentials: 1,
    })
    assert.deepEqual(body.capacity.weekly, {
      usedPercent: 95,
      remainingPercent: 5,
      measurableCredentials: 1,
    })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage excludes non-functional Codex credentials from capacity overview", async () => {
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_codex_healthy", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_codex_unhealthy", {
        provider: "codex_oauth",
        state: "unhealthy",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    usage: {
      ...createUsageResponse(),
      groupBy: "credential" as const,
    },
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
    assert.deepEqual(body.credentialUsage.map((entry: { id: string; state: string }) => ({
      id: entry.id,
      state: entry.state,
    })), [
      { id: "cred_codex_healthy", state: "healthy" },
      { id: "cred_codex_unhealthy", state: "unhealthy" },
    ])
    assert.deepEqual(body.capacity.codexCredentials, {
      total: 1,
      measurable: 1,
      unknown: 0,
      unavailable: 0,
    })
    assert.deepEqual(body.capacity.credentials.map((entry: { id: string }) => entry.id), ["cred_codex_healthy"])
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage filtered by credential only returns the selected credential row", async () => {
  const usage = {
    ...createUsageResponse(),
    groupBy: "credential" as const,
    series: [
      {
        key: "cred_codex_1",
        label: "cred_codex_1",
        totalTokens: 120,
        totalRequests: 3,
      },
    ],
    topCredentials: [{ id: "cred_codex_1", label: "cred_codex_1", totalTokens: 120 }],
    credentialUsage: [
      {
        id: "cred_codex_1",
        label: "cred_codex_1",
        cachedTokens: 12,
        totalTokens: 120,
        totalRequests: 3,
      },
    ],
  }
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    usage,
    codexStatusProvider: {
      async getStatus() {
        return createCodexStatus()
      },
    },
    onAggregateUsageInput(input) {
      assert.equal(input.credentialId, "cred_codex_1")
      assert.equal(input.userId, null)
      assert.equal(input.orgId, null)
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=credential&credentialId=cred_codex_1`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credentialUsage.map((entry: { id: string }) => entry.id), ["cred_codex_1"])
    assert.equal(body.credentialUsage[0].cachedTokens, 12)
    assert.equal(body.credentialUsage[0].totalTokens, 120)
    assert.equal(body.credentialUsage[0].eligibility.state, "exhausted")
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage filtered by user only returns credentials in the filtered aggregate", async () => {
  const usage = {
    ...createUsageResponse(),
    groupBy: "user" as const,
    credentialUsage: [
      {
        id: "cred_codex_1",
        label: "cred_codex_1",
        cachedTokens: 9,
        totalTokens: 90,
        totalRequests: 2,
      },
    ],
    topCredentials: [{ id: "cred_codex_1", label: "cred_codex_1", totalTokens: 90 }],
  }
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_anthropic_1", {
        provider: "anthropic",
      }),
    ],
    usage,
    codexStatusProvider: {
      async getStatus() {
        return createCodexStatus()
      },
    },
    onAggregateUsageInput(input) {
      assert.equal(input.credentialId, null)
      assert.equal(input.userId, "user_admin")
      assert.equal(input.orgId, null)
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=user&userId=user_admin`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credentialUsage.map((entry: { id: string }) => entry.id), ["cred_codex_1"])
    assert.equal(body.credentialUsage[0].cachedTokens, 9)
    assert.equal(body.credentialUsage[0].totalTokens, 90)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("GET /admin/api/usage filtered by org only returns credentials in the filtered aggregate", async () => {
  const usage = {
    ...createUsageResponse(),
    groupBy: "org" as const,
    credentialUsage: [
      {
        id: "cred_anthropic_1",
        label: "cred_anthropic_1",
        cachedTokens: 7,
        totalTokens: 70,
        totalRequests: 2,
        lastUsedAt: "2026-04-29T12:30:00.000Z",
      },
    ],
    topCredentials: [{ id: "cred_anthropic_1", label: "cred_anthropic_1", totalTokens: 70 }],
  }
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_anthropic_1", {
        provider: "anthropic",
      }),
    ],
    usage,
    codexStatusProvider: {
      async getStatus() {
        return createCodexStatus()
      },
    },
    onAggregateUsageInput(input) {
      assert.equal(input.credentialId, null)
      assert.equal(input.userId, null)
      assert.equal(input.orgId, "org_admin")
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=org&orgId=org_admin`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credentialUsage.map((entry: { id: string }) => entry.id), ["cred_anthropic_1"])
    assert.equal(body.credentialUsage[0].lastUsedAt, "2026-04-29T12:30:00.000Z")
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
      created_at: new Date("2026-04-29T10:00:00.000Z"),
    },
    {
      credential_record_id: "cred_openai_1",
      owner_user_id: "user_admin",
      org_id: "org_admin",
      input_tokens: 3,
      output_tokens: 4,
      cached_tokens: 5,
      total_tokens: 101,
      created_at: new Date("2026-04-29T11:00:00.000Z"),
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
      totalTokens: 200,
      totalRequests: 2,
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
        totalTokens: 200,
        totalRequests: 2,
      },
    ],
    topCredentials: [{ id: "cred_openai_1", label: "cred_openai_1", totalTokens: 200 }],
    topUsers: [{ id: "user_admin", label: "user_admin", totalTokens: 200 }],
    topOrgs: [{ id: "org_admin", label: "org_admin", totalTokens: 200 }],
    credentialUsage: [
      {
        id: "cred_openai_1",
        label: "cred_openai_1",
        cachedTokens: 9,
        totalTokens: 200,
        totalRequests: 2,
        lastUsedAt: "2026-04-29T11:00:00.000Z",
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

test("GET /admin/api/alerts includes synthetic Codex capacity threshold alerts", async () => {
  const app = createReadModelApp({
    credentials: [
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        name: "Codex Team One",
        activeLeases: 0,
        totalTokens: 0,
      }),
      createCredential("cred_codex_2", {
        provider: "codex_oauth",
        name: "Codex Team Two",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    codexStatusProvider: {
      async getStatus() {
        return {
          ...createCodexStatus(),
          checkedAt: "2026-06-06T12:00:00.000Z",
          limits: {
            fiveHour: {
              label: "5h",
              usedPercent: 95,
              windowMinutes: 300,
              resetAt: null,
            },
            weekly: {
              label: "Weekly",
              usedPercent: 80,
              windowMinutes: 10080,
              resetAt: null,
            },
          },
        }
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/alerts`)

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.alerts.map((alert: { id: string; severity: string }) => ({
      id: alert.id,
      severity: alert.severity,
    })).slice(0, 2), [
      {
        id: "alert_codex_capacity_five_hour_95",
        severity: "critical",
      },
      {
        id: "alert_codex_capacity_weekly_80",
        severity: "medium",
      },
    ])
    assert.match(body.alerts[0].runbook, /Codex Team One.*5h 5% remaining.*weekly 20% remaining/)
  } finally {
    server.close()
    await once(server, "close")
  }
})
