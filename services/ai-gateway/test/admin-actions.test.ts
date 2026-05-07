import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AlertRecord } from "../src/alerts/repository.js";
import type {
  AdminService,
  AdminSessionSnapshot,
  AdminUserRecord,
  AuditRecord,
  BrowserAuthExchangeInput,
  BrowserAuthStartInput,
  BrowserAuthStartPayload,
  CredentialRecord,
  SessionRecord,
  UsageResponse,
} from "../src/http/admin.js";
import { createDefaultAdminService, MySqlAdminCredentialActionRepository } from "../src/http/admin.js";
import { createApp } from "../src/index.js";

const AUTHORIZATION = { authorization: "Bearer admin-token" };

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
  };
}

function createCredential(
  id: string,
  state: CredentialRecord["state"],
  overrides: Partial<Pick<CredentialRecord, "provider" | "activeLeases">> = {},
): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: overrides.provider ?? "openai",
    type: "oauth",
    state,
    scope: "user_admin",
    activeLeases: overrides.activeLeases ?? 2,
    alertCount: 1,
    lastRefreshAt: "2026-04-03T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 321,
    nextRotationAt: null,
    linkedAlertIds: ["alert_health_1"],
  };
}

function createUnusedDenClient() {
  return {
    async startBrowserAuth() {
      throw new Error("unused");
    },
    async exchangeBrowserAuth() {
      throw new Error("unused");
    },
    async getSession() {
      return createSession();
    },
    async listUsers() {
      return [];
    },
    async createUser() {
      throw new Error("unused");
    },
    async getEligibleCodexCredentialForAutoAssign() {
      return null;
    },
    async updateUser() {
      throw new Error("unused");
    },
    async disableUser() {
      throw new Error("unused");
    },
    async enableUser() {
      throw new Error("unused");
    },
    async deleteUser() {
      return;
    },
  };
}

function createAlert(id: string, status: AlertRecord["status"]): AlertRecord {
  return {
    id,
    title: "Provider rate limits increasing",
    severity: "high",
    source: "provider-rate-limit",
    status,
    credentialId: "cred_openai_1",
    affectedSessions: 3,
    firstSeenAt: "2026-04-03T10:00:00.000Z",
    lastSeenAt: "2026-04-03T10:05:00.000Z",
    owner: status === "active" ? null : "admin@example.test",
    runbook: "Inspect quota pressure and rotate session load across healthy credentials.",
  };
}

function createUsageResponse(): UsageResponse {
  return {
    summary: {
      totalTokens: 0,
      totalRequests: 0,
    },
    groupBy: "total",
    filters: {
      credentials: [],
      users: [],
      orgs: [],
    },
    series: [],
    topCredentials: [],
    topUsers: [],
    topOrgs: [],
  };
}

function createAdminServiceSpy() {
  const calls = {
    credential: [] as Array<{ action: string; credentialId: string; token: string; actorUserId: string | null }>,
    alert: [] as Array<{ action: string; alertId: string; token: string; actorUserId: string | null }>,
  };
  const session = createSession();

  const service: AdminService = {
    async startBrowserAuth(_input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload> {
      throw new Error("unused");
    },
    async exchangeBrowserAuth(_input: BrowserAuthExchangeInput) {
      throw new Error("unused");
    },
    async getSession() {
      return session;
    },
    async listUsers(): Promise<AdminUserRecord[]> {
      return [];
    },
    async createUser() {
      throw new Error("unused");
    },
    async updateUser() {
      throw new Error("unused");
    },
    async disableUser() {
      throw new Error("unused");
    },
    async enableUser() {
      throw new Error("unused");
    },
    async deleteUser() {
      return;
    },
    async listCredentials() {
      return { credentials: [] };
    },
    async revokeCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "revoke", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "revoked") };
    },
    async drainCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "drain", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "draining") };
    },
    async rotateCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "rotate", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "draining") };
    },
    async deleteCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "delete", credentialId, token, actorUserId });
      return {
        credential: {
          ...createCredential(credentialId, "revoked", { activeLeases: 0 }),
          deletedAt: "2026-04-03T11:00:00.000Z",
        },
      };
    },
    async listSessions(): Promise<{ sessions: SessionRecord[] }> {
      return { sessions: [] };
    },
    async getUsage() {
      return createUsageResponse();
    },
    async listAlerts() {
      return { alerts: [] };
    },
    async acknowledgeAlert(token, alertId, actorUserId) {
      calls.alert.push({ action: "acknowledge", alertId, token, actorUserId });
      return { alert: createAlert(alertId, "acknowledged") };
    },
    async resolveAlert(token, alertId, actorUserId) {
      calls.alert.push({ action: "resolve", alertId, token, actorUserId });
      return { alert: createAlert(alertId, "resolved") };
    },
    async listAudit(): Promise<{ events: AuditRecord[] }> {
      return { events: [] };
    },
  };

  return { service, calls, session };
}

test("POST /admin/api/credentials actions forward admin actor identity and return credential payloads", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/admin/api/credentials/cred_openai_1`;
    const cases = [
      {
        action: "revoke",
        expected: { credential: createCredential("cred_openai_1", "revoked") },
      },
      {
        action: "drain",
        expected: { credential: createCredential("cred_openai_1", "draining") },
      },
      {
        action: "rotate",
        expected: { credential: createCredential("cred_openai_1", "draining") },
      },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/${entry.action}`, {
        method: "POST",
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), entry.expected);
    }

    assert.deepEqual(calls.credential, [
      { action: "revoke", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
      { action: "drain", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
      { action: "rotate", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("DELETE /admin/api/credentials/:credentialId forwards admin actor identity", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_revoked_1`, {
      method: "DELETE",
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      credential: {
        ...createCredential("cred_revoked_1", "revoked", { activeLeases: 0 }),
        deletedAt: "2026-04-03T11:00:00.000Z",
      },
    });
    assert.deepEqual(calls.credential, [
      { action: "delete", credentialId: "cred_revoked_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("createDefaultAdminService soft-deletes an unusable credential and tombstones its secret", async () => {
  const deletedCredential = {
    ...createCredential("cred_revoked_1", "revoked", { activeLeases: 0 }),
    alertCount: 0,
    linkedAlertIds: [],
    deletedAt: "2026-04-03T11:00:00.000Z",
  };
  const tombstones: unknown[] = [];
  const auditCalls: Array<{
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary?: string | null;
  }> = [];
  const deleteCalls: Array<{ credentialId: string; allowHealthyUnavailable: boolean }> = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials(input?: { includeDeleted?: boolean }) {
        assert.equal(input?.includeDeleted, true);
        return [deletedCredential];
      },
    },
    credentialActionRepository: {
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential(input: { credentialId: string; allowHealthyUnavailable?: boolean }) {
        deleteCalls.push({
          credentialId: input.credentialId,
          allowHealthyUnavailable: input.allowHealthyUnavailable === true,
        });
        return {
          deleted: true,
          secretRef: "secret_revoked_1",
          deletedAt: "2026-04-03T11:00:00.000Z",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("unused");
      },
      async replace(secretRef, secret) {
        tombstones.push({ secretRef, secret });
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push(input);
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
    now: () => new Date("2026-04-03T11:00:00.000Z"),
  });

  const payload = await service.deleteCredential("admin-token", "cred_revoked_1", "admin@example.test");

  assert.deepEqual(payload, { credential: deletedCredential });
  assert.deepEqual(deleteCalls, [{ credentialId: "cred_revoked_1", allowHealthyUnavailable: false }]);
  assert.deepEqual(tombstones, [
    {
      secretRef: "secret_revoked_1",
      secret: {
        kind: "deleted",
        deletedAt: "2026-04-03T11:00:00.000Z",
        reason: "admin_deleted",
      },
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      actorUserId: "admin@example.test",
      action: "credential.delete",
      entityType: "credential",
      entityId: "cred_revoked_1",
      result: "warning",
      summary: "Deleted credential cred_revoked_1.",
    },
  ]);
});

test("credential delete action allows revoked credentials with active leases", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const healthEvents: unknown[] = [];
  const db = {
    select(selection?: Record<string, unknown>) {
      if (!selection) {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [
                      {
                        id: "cred_revoked_1",
                        state: "revoked",
                        deleted_at: null,
                        secret_ref: "secret_revoked_1",
                      },
                    ];
                  },
                };
              },
            };
          },
        };
      }

      if ("activeLeases" in selection) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  async where() {
                    return [{ activeLeases: 3 }];
                  },
                };
              },
            };
          },
        };
      }

      if ("assignedUsers" in selection) {
        return {
          from() {
            return {
              async where() {
                return [{ assignedUsers: 0 }];
              },
            };
          },
        };
      }

      throw new Error("unexpected_select");
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            async where() {
              return;
            },
          };
        },
      };
    },
    insert() {
      return {
        async values(value: unknown) {
          healthEvents.push(value);
        },
      };
    },
  };
  const repository = new MySqlAdminCredentialActionRepository(db as never);

  const result = await repository.deleteCredential({ credentialId: "cred_revoked_1" });

  assert.equal(result.deleted, true);
  if (result.deleted) {
    assert.equal(result.secretRef, "secret_revoked_1");
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.state, "revoked");
  assert.ok(updates[0]?.deleted_at instanceof Date);
  assert.deepEqual(healthEvents, []);
});

test("POST /admin/api/alerts actions forward admin actor identity and return alert payloads", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/admin/api/alerts/alert_health_1`;
    const cases = [
      {
        action: "acknowledge",
        expected: { alert: createAlert("alert_health_1", "acknowledged") },
      },
      {
        action: "resolve",
        expected: { alert: createAlert("alert_health_1", "resolved") },
      },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/${entry.action}`, {
        method: "POST",
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), entry.expected);
    }

    assert.deepEqual(calls.alert, [
      { action: "acknowledge", alertId: "alert_health_1", token: "admin-token", actorUserId: session.user.email },
      { action: "resolve", alertId: "alert_health_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("createDefaultAdminService enriches credential payloads with unresolved linked alerts", async () => {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
        throw new Error("unused");
      },
      async listUsers() {
        throw new Error("unused");
      },
      async createUser() {
        throw new Error("unused");
      },
      async updateUser() {
        throw new Error("unused");
      },
      async disableUser() {
        throw new Error("unused");
      },
      async enableUser() {
        throw new Error("unused");
      },
      async deleteUser() {
        throw new Error("unused");
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          {
            ...createCredential("cred_openai_1", "healthy"),
            alertCount: 0,
            linkedAlertIds: [],
          },
        ];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [
          createAlert("alert_health_active", "active"),
          createAlert("alert_health_acknowledged", "acknowledged"),
          createAlert("alert_health_resolved", "resolved"),
          {
            ...createAlert("alert_other_credential", "active"),
            credentialId: "cred_other",
          },
        ];
      },
    },
  });

  const payload = await service.listCredentials("admin-token");

  assert.deepEqual(payload, {
    credentials: [
      {
        ...createCredential("cred_openai_1", "healthy"),
        alertCount: 2,
        linkedAlertIds: ["alert_health_active", "alert_health_acknowledged"],
      },
    ],
  });
});

test("createDefaultAdminService keeps user creation successful when audit persistence fails", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const auditCalls: Array<{
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary?: string | null;
  }> = [];
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    const service = createDefaultAdminService("http://den.example.test", {
      denClient: {
        async startBrowserAuth() {
          throw new Error("unused");
        },
        async exchangeBrowserAuth() {
          throw new Error("unused");
        },
        async getSession() {
          throw new Error("unused");
        },
        async listUsers() {
          throw new Error("unused");
        },
        async createUser() {
          return createdUser;
        },
        async updateUser() {
          throw new Error("unused");
        },
        async disableUser() {
          throw new Error("unused");
        },
        async enableUser() {
          throw new Error("unused");
        },
        async deleteUser() {
          throw new Error("unused");
        },
      },
      auditRepository: {
        async recordEvent(input) {
          auditCalls.push(input);
          throw new Error("audit_unavailable");
        },
      },
      credentialReadRepository: {
        async listAdminCredentials() {
          return [];
        },
      },
    });

    const result = await service.createUser("admin-token", {
      email: createdUser.email,
      name: createdUser.name,
      platformAdmin: createdUser.platformAdmin,
      orgId: null,
      orgRole: "member",
    });

    assert.deepEqual(result, createdUser);
    assert.deepEqual(auditCalls, [
      {
        actorUserId: "admin-ui",
        action: "user.create",
        entityType: "user",
        entityId: createdUser.id,
        result: "ok",
        summary: `Created user ${createdUser.email}.`,
      },
    ]);
    assert.equal(consoleErrors.length, 1);
    assert.match(String(consoleErrors[0]?.[0] ?? ""), /admin audit event failed/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test("default admin service selects the least-loaded healthy codex credential with OK upstream status", async () => {
  const statusChecks: string[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_openai_1", "healthy", {
            provider: "openai",
            activeLeases: 0,
          }),
          createCredential("cred_codex_revoked", "revoked", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_3", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
          createCredential("cred_codex_2", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
          createCredential("cred_codex_1", "healthy", {
            provider: "codex_oauth",
            activeLeases: 4,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        statusChecks.push(input.credentialId);
        return {
          available: input.credentialId !== "cred_codex_unavailable",
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
  });

  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected?.credentialId, "cred_codex_2");
  assert.deepEqual(statusChecks, [
    "cred_codex_unavailable",
    "cred_codex_3",
    "cred_codex_2",
    "cred_codex_1",
  ]);
});

test("default admin service returns null when no eligible codex credential exists", async () => {
  const statusChecks: string[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_openai_1", "healthy", {
            provider: "openai",
            activeLeases: 0,
          }),
          createCredential("cred_codex_revoked", "revoked", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_draining", "draining", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        statusChecks.push(input.credentialId);
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
  });

  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected, null);
  assert.deepEqual(statusChecks, ["cred_codex_unavailable"]);
});

test("default admin service returns Codex model catalog for codex credentials", async () => {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        assert.equal(credentialId, "cred_codex_1");
        return {
          provider: "codex_oauth",
          secretRef: "secret_codex_1",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("should_not_read_codex_secret_for_catalog");
      },
      async replace() {
        throw new Error("unused");
      },
    },
  });

  const payload = await service.listCredentialModels("admin-token", "cred_codex_1");

  assert.equal(payload.credentialId, "cred_codex_1");
  assert.equal(payload.defaultModel, "gpt-5.5");
  assert.ok(payload.models.includes("gpt-5.4"));
  assert.ok(payload.models.includes("gpt-5.5"));
});

test("createDefaultAdminService does not auto-assign codex ai access on user creation", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const upsertCalls: unknown[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      ...createUnusedDenClient(),
      async createUser() {
        return createdUser;
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_1", "healthy", {
            provider: "codex_oauth",
            activeLeases: 4,
          }),
          createCredential("cred_codex_2", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: input.credentialId === "cred_codex_2"
            ? "codex | OK | tokens used | 7,367"
            : "ERROR: Your access token could not be refreshed because your refresh token was already used.",
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess(input) {
        upsertCalls.push(input);
        return {
          id: "ai_access_user_created",
          ...input,
          createdAt: new Date("2026-04-27T12:00:00.000Z"),
          updatedAt: new Date("2026-04-27T12:00:00.000Z"),
        };
      },
    },
    auditRepository: {
      async recordEvent() {
        return;
      },
      async listEvents() {
        return [];
      },
    },
  });

  const result = await service.createUser("admin-token", {
    email: createdUser.email,
    name: createdUser.name,
    platformAdmin: createdUser.platformAdmin,
    orgId: null,
    orgRole: "member",
  });

  assert.deepEqual(result, createdUser);
  assert.deepEqual(upsertCalls, []);
});

test("createDefaultAdminService skips ai access when no eligible codex credential exists", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const upsertCalls: unknown[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      ...createUnusedDenClient(),
      async createUser() {
        return createdUser;
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus() {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess(input) {
        upsertCalls.push(input);
        throw new Error("unexpected_ai_access_upsert");
      },
    },
    auditRepository: {
      async recordEvent() {
        return;
      },
      async listEvents() {
        return [];
      },
    },
  });

  const result = await service.createUser("admin-token", {
    email: createdUser.email,
    name: createdUser.name,
    platformAdmin: createdUser.platformAdmin,
    orgId: null,
    orgRole: "member",
  });

  assert.deepEqual(result, createdUser);
  assert.deepEqual(upsertCalls, []);
});

test("default admin service rejects enabled codex_oauth access without credentialId", async () => {
  let upsertCalled = false;
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
        return createSession();
      },
      async listUsers() {
        return [];
      },
      async createUser() {
        throw new Error("unused");
      },
      async updateUser() {
        throw new Error("unused");
      },
      async disableUser() {
        throw new Error("unused");
      },
      async enableUser() {
        throw new Error("unused");
      },
      async deleteUser() {
        throw new Error("unused");
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess() {
        upsertCalled = true;
        throw new Error("unused");
      },
    } as any,
  });
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "invalid_ai_access_credential_id",
    });
    assert.equal(upsertCalled, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET admin read endpoints return JSON 502 payloads when read models fail", async () => {
  const { service } = createAdminServiceSpy();
  service.listCredentials = async () => {
    throw new Error("credential_store_down");
  };
  service.listSessions = async () => {
    throw new Error("session_store_down");
  };
  service.getUsage = async () => {
    throw new Error("usage_store_down");
  };
  service.listAlerts = async () => {
    throw new Error("alert_store_down");
  };
  service.listAudit = async () => {
    throw new Error("audit_store_down");
  };

  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const cases = [
      { path: "/admin/api/credentials", expected: { error: "credential_list_failed" } },
      { path: "/admin/api/sessions", expected: { error: "session_list_failed" } },
      { path: "/admin/api/usage", expected: { error: "usage_lookup_failed" } },
      { path: "/admin/api/alerts", expected: { error: "alert_list_failed" } },
      { path: "/admin/api/audit", expected: { error: "audit_list_failed" } },
    ];

    for (const entry of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${entry.path}`, {
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 502);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
      assert.deepEqual(await response.json(), entry.expected);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});
