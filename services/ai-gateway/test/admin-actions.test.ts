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
import { createDefaultAdminService } from "../src/http/admin.js";
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

function createCredential(id: string, state: CredentialRecord["state"]): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: "openai",
    type: "oauth",
    state,
    scope: "user_admin",
    activeLeases: 2,
    alertCount: 1,
    lastRefreshAt: "2026-04-03T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 321,
    nextRotationAt: null,
    linkedAlertIds: ["alert_health_1"],
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
