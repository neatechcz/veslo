import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { createAdminRouter } from "../src/http/admin.js"
import { createManagedAiAdminRouteDeps } from "../src/managed-ai/http/admin.js"
import { MySqlUsageRepository } from "../src/managed-ai/usage/mysql-repository.js"

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

function createCredential(id: string) {
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
    totalTokens: 144,
    nextRotationAt: null,
    linkedAlertIds: [],
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

function createReadModelApp() {
  const session = createSession()
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
            return [createCredential("cred_openai_1")]
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
            assert.equal(input.groupBy, "user")
            return createUsageResponse()
          },
        } as any,
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
    assert.deepEqual(await response.json(), createUsageResponse())
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("MySqlUsageRepository aggregates stored totals by org", async () => {
  let whereCalled = false
  const repository = new MySqlUsageRepository({
    select() {
      return {
        from() {
          return {
            async where() {
              whereCalled = true
              return [
                {
                  credential_record_id: "cred_openai_1",
                  owner_user_id: "user_admin",
                  org_id: "org_admin",
                  input_tokens: 1,
                  output_tokens: 2,
                  cached_tokens: 4,
                  total_tokens: 99,
                },
              ]
            },
          }
        },
      }
    },
  } as any)

  const response = await repository.aggregateUsage({
    groupBy: "org",
    credentialId: null,
    userId: null,
    orgId: null,
  })

  assert.equal(whereCalled, true)
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
