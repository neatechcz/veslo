import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { buildAlertRecord } from "../src/alerts/mysql-repository.js";
import { createDefaultAdminService, type AdminSessionSnapshot } from "../src/http/admin.js";
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

function createDenClient(session = createSession()) {
  return {
    async startBrowserAuth() {
      throw new Error("unused");
    },
    async exchangeBrowserAuth() {
      throw new Error("unused");
    },
    async getSession() {
      return session;
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
      return;
    },
  };
}

test("/admin/api/alerts returns repository-backed alerts instead of fixtures", async () => {
  const expected = [
    {
      id: "alert_repo_1",
      title: "Provider rate limits increasing",
      severity: "high" as const,
      source: "provider-rate-limit",
      status: "active" as const,
      credentialId: "cred_openai_1",
      affectedSessions: 3,
      firstSeenAt: "2026-04-03T10:00:00.000Z",
      lastSeenAt: "2026-04-03T10:00:00.000Z",
      owner: null,
      runbook: "Inspect quota pressure and rotate session load across healthy credentials.",
    },
  ];

  const service = createDefaultAdminService(
    "http://den.example.test",
    {
      denClient: createDenClient(),
      alertRepository: {
        async listAlerts() {
          return expected;
        },
      },
    } as never,
  );
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/alerts`, {
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { alerts: expected });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("buildAlertRecord classifies auth, rate-limit, and unusual-activity signals", () => {
  const authAlert = buildAlertRecord({
    eventId: "health_invalid_grant",
    credentialId: "cred_openai_1",
    reason: "invalid_grant",
    toState: "unhealthy",
    occurredAt: "2026-04-03T09:00:00.000Z",
    affectedSessions: 4,
  });
  const rateLimitAlert = buildAlertRecord({
    eventId: "health_rate_limit",
    credentialId: "cred_openai_2",
    reason: "rate_limit_exceeded",
    toState: "degraded",
    occurredAt: "2026-04-03T09:05:00.000Z",
    affectedSessions: 2,
  });
  const unusualActivityAlert = buildAlertRecord({
    eventId: "health_spike",
    credentialId: "cred_openai_3",
    reason: "upstream_5xx_spike",
    toState: "degraded",
    occurredAt: "2026-04-03T09:10:00.000Z",
    affectedSessions: 6,
  });

  assert.deepEqual(authAlert, {
    id: "alert_health_invalid_grant",
    title: "invalid_grant returned by upstream OAuth",
    severity: "high",
    source: "provider-auth",
    status: "active",
    credentialId: "cred_openai_1",
    affectedSessions: 4,
    firstSeenAt: "2026-04-03T09:00:00.000Z",
    lastSeenAt: "2026-04-03T09:00:00.000Z",
    owner: null,
    runbook: "Rotate the underlying grant and inspect recent refresh failures for the credential.",
  });
  assert.deepEqual(rateLimitAlert, {
    id: "alert_health_rate_limit",
    title: "Provider rate limits increasing",
    severity: "high",
    source: "provider-rate-limit",
    status: "active",
    credentialId: "cred_openai_2",
    affectedSessions: 2,
    firstSeenAt: "2026-04-03T09:05:00.000Z",
    lastSeenAt: "2026-04-03T09:05:00.000Z",
    owner: null,
    runbook: "Inspect quota pressure and rotate session load across healthy credentials.",
  });
  assert.deepEqual(unusualActivityAlert, {
    id: "alert_health_spike",
    title: "Unusual upstream error activity detected",
    severity: "critical",
    source: "gateway-operations",
    status: "active",
    credentialId: "cred_openai_3",
    affectedSessions: 6,
    firstSeenAt: "2026-04-03T09:10:00.000Z",
    lastSeenAt: "2026-04-03T09:10:00.000Z",
    owner: null,
    runbook: "Inspect recent upstream failures and failover churn for the affected credential pool.",
  });
});
