import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"

import {
  createDefaultAdminService,
  type AdminSessionSnapshot,
  type AuditRecord,
  type CredentialRecord,
  type SessionRecord,
  type UsageResponse,
} from "../src/http/admin.js"
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

function createCredential(id: string): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: "openai",
    type: "oauth",
    state: "healthy",
    scope: "user_admin",
    activeLeases: 2,
    alertCount: 0,
    lastRefreshAt: "2026-04-02T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 144,
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
  audit?: AuditRecord[]
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
    auditRepository: {
      async recordEvent() {
        return
      },
      async listEvents() {
        return overrides.audit ?? []
      },
    },
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
