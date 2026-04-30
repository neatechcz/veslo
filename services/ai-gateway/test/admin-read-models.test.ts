import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import {
  createDefaultAdminService,
  type AdminSessionSnapshot,
  type AuditRecord,
  type AdminCredentialUsageRecord,
  type CredentialRecord,
  type SessionRecord,
  type UsageResponse,
} from "../src/http/admin.js"
import type { AlertRecord } from "../src/alerts/repository.js"
import { createApp } from "../src/index.js"

const AUTHORIZATION = { authorization: "Bearer admin-token" }

function createSession(): AdminSessionSnapshot {
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

function createDenClient(session = createSession()) {
  return {
    async startBrowserAuth() {
      throw new Error("unused")
    },
    async exchangeBrowserAuth() {
      throw new Error("unused")
    },
    async getSession() {
      return session
    },
    async listUsers() {
      return []
    },
    async createUser() {
      throw new Error("unused")
    },
    async updateUser() {
      throw new Error("unused")
    },
    async disableUser() {
      throw new Error("unused")
    },
    async enableUser() {
      throw new Error("unused")
    },
    async deleteUser() {
      return
    },
  }
}

function createCredential(
  id: string,
  overrides: Partial<Pick<CredentialRecord, "provider" | "type" | "state" | "activeLeases" | "totalTokens">> & {
    cachedTokens?: number
  } = {},
): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: overrides.provider ?? "openai",
    type: overrides.type ?? "oauth",
    state: overrides.state ?? "healthy",
    scope: "user_admin",
    activeLeases: overrides.activeLeases ?? 2,
    alertCount: 0,
    lastRefreshAt: "2026-04-02T10:00:00.000Z",
    lastFailureAt: null,
    cachedTokens: overrides.cachedTokens ?? 0,
    totalTokens: overrides.totalTokens ?? 144,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}

function createSessionRecord(input: {
  id: string
  provider: "openai" | "anthropic"
  credentialId: string
}): SessionRecord & { provider: "openai" | "anthropic"; sessionId: string } {
  return {
    id: input.id,
    sessionId: "session_shared_1",
    provider: input.provider,
    userLabel: "Admin",
    orgLabel: "Personal",
    projectLabel: "Gateway rollout",
    workerLabel: "local-runtime",
    credentialId: input.credentialId,
    state: "healthy",
    retries: 0,
    lastSeenAt: "2026-04-02T10:10:00.000Z",
    lastFailoverAt: null,
  }
}

function createUsageResponse(groupBy: UsageResponse["groupBy"]): UsageResponse {
  return {
    summary: {
      totalTokens: 900,
      totalRequests: 9,
    },
    groupBy,
    filters: {
      credentials: [{ id: "cred_openai_1", label: "Credential cred_openai_1" }],
      users: [{ id: "user_admin", label: "Admin" }],
      orgs: [],
    },
    series: [
      {
        key: groupBy === "user" ? "user_admin" : "cred_openai_1",
        label: groupBy === "user" ? "Admin" : "Credential cred_openai_1",
        totalTokens: 900,
        totalRequests: 9,
      },
    ],
    topCredentials: [{ id: "cred_openai_1", label: "Credential cred_openai_1", totalTokens: 900 }],
    topUsers: [{ id: "user_admin", label: "Admin", totalTokens: 900 }],
    topOrgs: [],
    credentialUsage: [
      {
        id: "cred_openai_1",
        label: "Credential cred_openai_1",
        name: "Credential cred_openai_1",
        provider: null,
        state: null,
        activeLeases: 0,
        cachedTokens: 0,
        totalTokens: 900,
        totalRequests: 9,
        lastUsedAt: null,
        upstreamStatus: null,
      },
    ],
  }
}

function createAuditEvent(id: string): AuditRecord {
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

function createAdminApp(overrides: {
  credentials?: CredentialRecord[]
  sessions?: Array<SessionRecord & { provider: "openai" | "anthropic"; sessionId: string }>
  usage?: UsageResponse
  alerts?: AlertRecord[]
  audit?: AuditRecord[]
  codexStatusProvider?: { getStatus(input: { credentialId: string; credentialName: string }): Promise<AdminCredentialUsageRecord["upstreamStatus"]> }
}) {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return overrides.credentials ?? []
      },
    },
    sessionReadRepository: {
      async listAdminSessions() {
        return overrides.sessions ?? []
      },
    },
    usageRepository: {
      async recordUsage() {
        return
      },
      async aggregateUsage() {
        return overrides.usage ?? createUsageResponse("total")
      },
    },
    alertRepository: {
      async listAlerts() {
        return overrides.alerts ?? []
      },
    },
    auditRepository: {
      async recordEvent() {
        return
      },
      async listEvents() {
        return overrides.audit ?? []
      },
    },
    codexStatusProvider: overrides.codexStatusProvider,
    now: () => new Date("2026-04-30T12:00:00.000Z"),
  })

  return createApp({ admin: service })
}

test("admin credentials endpoint returns repository-backed credentials", async () => {
  const expected = [createCredential("cred_openai_1")]
  const app = createAdminApp({ credentials: expected })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { credentials: expected })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin credentials endpoint includes Codex upstream limit status", async () => {
  const app = createAdminApp({
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
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    const codex = body.credentials.find((entry: CredentialRecord) => entry.id === "cred_codex_1")
    const openai = body.credentials.find((entry: CredentialRecord) => entry.id === "cred_openai_1")
    assert.equal(openai.upstreamStatus, undefined)
    assert.equal(codex.upstreamStatus.limits.fiveHour.usedPercent, 100)
    assert.equal(codex.upstreamStatus.limits.weekly.usedPercent, 33)
    assert.equal(codex.cachedTokens, 50)
    assert.equal(codex.totalTokens, 0)
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

test("admin sessions endpoint returns provider-scoped active leases", async () => {
  const expected = [
    createSessionRecord({ id: "lease_openai_1", provider: "openai", credentialId: "cred_openai_1" }),
    createSessionRecord({ id: "lease_anthropic_1", provider: "anthropic", credentialId: "cred_anthropic_1" }),
  ]
  const app = createAdminApp({ sessions: expected })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/sessions`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessions: expected })
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin usage endpoint aggregates by credential and user", async () => {
  const expected = createUsageResponse("user")
  const app = createAdminApp({ usage: expected })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=user`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin usage endpoint includes every credential with recorded usage and Codex limits status", async () => {
  const app = createAdminApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        cachedTokens: 50,
        totalTokens: 0,
      }),
    ],
    usage: createUsageResponse("credential"),
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-26T12:00:00.000Z",
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
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=credential`, {
      headers: AUTHORIZATION,
    })

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
        cachedTokens: 0,
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
        upstreamStatus: {
          available: true,
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-26T12:00:00.000Z",
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
        },
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

test("admin usage endpoint reuses decorated null Codex upstream status", async () => {
  let statusProbeCount = 0
  const app = createAdminApp({
    credentials: [
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    usage: createUsageResponse("credential"),
    codexStatusProvider: {
      async getStatus() {
        statusProbeCount += 1
        return null
      },
    },
  })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/usage?groupBy=credential`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    const codex = body.credentialUsage.find((entry: AdminCredentialUsageRecord) => entry.id === "cred_codex_1")
    assert.equal(codex.upstreamStatus, null)
    assert.equal(statusProbeCount, 1)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("admin audit endpoint returns persisted events instead of fixtures", async () => {
  const expected = [createAuditEvent("audit_repo_1")]
  const app = createAdminApp({ audit: expected })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/audit`, {
      headers: AUTHORIZATION,
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { events: expected })
  } finally {
    server.close()
    await once(server, "close")
  }
})
