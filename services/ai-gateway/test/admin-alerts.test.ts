import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { buildAlertRecord } from "../src/alerts/mysql-repository.js";
import { createDefaultAdminService, type AdminSessionSnapshot, type CredentialRecord } from "../src/http/admin.js";
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

function createCredential(id: string, overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: "codex_oauth",
    type: "oauth",
    state: "healthy",
    scope: "user_admin",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-02T10:00:00.000Z",
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  };
}

function muteConsoleError(): () => void {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
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
      runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
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
      credentialReadRepository: {
        async listAdminCredentials() {
          return [];
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

test("/admin/api/alerts includes synthetic Codex capacity threshold alerts", async () => {
  const service = createDefaultAdminService(
    "http://den.example.test",
    {
      denClient: createDenClient(),
      alertRepository: {
        async listAlerts() {
          return [];
        },
      },
      credentialReadRepository: {
        async listAdminCredentials() {
          return [
            createCredential("cred_codex_1", { name: "Codex Team One" }),
            createCredential("cred_codex_2", { name: "Codex Team Two" }),
          ];
        },
      },
      codexStatusProvider: {
        async getStatus() {
          return {
            available: true,
            source: "codex_exec_rate_limits",
            label: "Codex limits available",
            detail: null,
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
          };
        },
      },
      now: () => new Date("2026-06-06T12:00:00.000Z"),
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
    const body = await response.json();
    assert.deepEqual(body.alerts.map((alert: { id: string; severity: string }) => ({
      id: alert.id,
      severity: alert.severity,
    })), [
      {
        id: "alert_codex_capacity_five_hour_95",
        severity: "critical",
      },
      {
        id: "alert_codex_capacity_weekly_80",
        severity: "medium",
      },
    ]);
    assert.match(body.alerts[0].runbook, /Codex Team One.*5h 5% remaining.*weekly 20% remaining/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("/admin/api/alerts returns repository alerts when Codex capacity probing fails", async () => {
  const restoreConsole = muteConsoleError();
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
      runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
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
      credentialReadRepository: {
        async listAdminCredentials() {
          return [createCredential("cred_codex_1", { name: "Codex Team One" })];
        },
      },
      codexStatusProvider: {
        async getStatus() {
          throw new Error("codex status unavailable");
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
    restoreConsole();
    server.close();
    await once(server, "close");
  }
});

test("/admin/api/alerts returns repository alerts when Codex capacity probing stalls", async () => {
  const restoreConsole = muteConsoleError();
  const previousTimeout = process.env.AI_GATEWAY_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS;
  process.env.AI_GATEWAY_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS = "20";
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
      runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
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
      credentialReadRepository: {
        async listAdminCredentials() {
          return [createCredential("cred_codex_1", { name: "Codex Team One" })];
        },
      },
      codexStatusProvider: {
        async getStatus() {
          return new Promise(() => undefined);
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
    if (previousTimeout === undefined) {
      delete process.env.AI_GATEWAY_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS;
    } else {
      process.env.AI_GATEWAY_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS = previousTimeout;
    }
    restoreConsole();
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
    runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
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
