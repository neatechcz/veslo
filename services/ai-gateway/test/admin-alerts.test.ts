import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { buildAlertRecord } from "../src/alerts/mysql-repository.js";
import type { AlertRecord } from "../src/alerts/repository.js";
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
      reason: "rate_limit_exceeded",
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

test("default admin service sends Codex capacity alert emails through the monitor", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const auditEvents: Array<{
    action: string;
    entityType: string;
    entityId: string;
    result: string;
    summary?: string | null;
  }> = [];
  const service = createDefaultAdminService(
    "http://den.example.test",
    {
      denClient: createDenClient(),
      alertEmailRecipients: ["admin-one@example.test", "admin-two@example.test"],
      sendAlertEmail: async (input: { to: string; subject: string; text: string }) => {
        sent.push(input);
      },
      auditRepository: {
        async listEvents() {
          return [];
        },
        async recordEvent(input) {
          auditEvents.push(input);
        },
      },
      credentialReadRepository: {
        async listAdminCredentials() {
          return [createCredential("cred_codex_1", { name: "Codex Team One" })];
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
                usedPercent: 40,
                windowMinutes: 10080,
                resetAt: null,
              },
            },
          };
        },
      },
      now: () => new Date("2026-06-06T12:00:00.000Z"),
    } as never,
  ) as ReturnType<typeof createDefaultAdminService> & {
    runCodexCapacityAlertEmailMonitor(): Promise<{ evaluatedAlerts: number; emailsSent: number; recipients: number }>;
  };

  const result = await service.runCodexCapacityAlertEmailMonitor();

  assert.deepEqual(result, {
    evaluatedAlerts: 1,
    emailsSent: 2,
    recipients: 2,
  });
  assert.deepEqual(sent.map((entry) => ({
    to: entry.to,
    subject: entry.subject,
  })), [
    {
      to: "admin-one@example.test",
      subject: "[URGENT] Codex 5h limit capacity at 95%",
    },
    {
      to: "admin-two@example.test",
      subject: "[URGENT] Codex 5h limit capacity at 95%",
    },
  ]);
  assert.match(sent[0]?.text ?? "", /Codex Team One: 5h 5% remaining/);
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents.every((event) => event.action === "codex_capacity_alert.email.sent"), true);
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
    reason: "invalid_grant",
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
    reason: "rate_limit_exceeded",
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
    reason: "upstream_5xx_spike",
    status: "active",
    credentialId: "cred_openai_3",
    affectedSessions: 6,
    firstSeenAt: "2026-04-03T09:10:00.000Z",
    lastSeenAt: "2026-04-03T09:10:00.000Z",
    owner: null,
    runbook: "Inspect recent upstream failures and failover churn for the affected credential pool.",
  });
});

test("buildAlertRecord classifies provider proxy network failures as inference outage alerts", () => {
  const alert = buildAlertRecord({
    eventId: "health_proxy_network",
    credentialId: "cred_codex_1",
    reason: "provider_proxy_failure:codex_oauth:network_connect_timeout",
    toState: "degraded",
    occurredAt: "2026-06-16T16:05:00.000Z",
    affectedSessions: 8,
  });

  assert.deepEqual(alert, {
    id: "alert_health_proxy_network",
    title: "AI inference upstream is unreachable",
    severity: "critical",
    source: "gateway-operations",
    reason: "provider_proxy_failure:codex_oauth:network_connect_timeout",
    status: "active",
    credentialId: "cred_codex_1",
    affectedSessions: 8,
    firstSeenAt: "2026-06-16T16:05:00.000Z",
    lastSeenAt: "2026-06-16T16:05:00.000Z",
    owner: null,
    runbook: "Check container outbound networking, DNS, firewall/NAT rules, and upstream provider reachability.",
  });
});

test("buildAlertRecord preserves the health event reason for email throttling", () => {
  const alert = buildAlertRecord({
    eventId: "health_invalid_grant",
    credentialId: "cred_openai_1",
    reason: "invalid_grant",
    toState: "unhealthy",
    occurredAt: "2026-06-17T10:00:00.000Z",
    affectedSessions: 1,
  });

  assert.equal(alert.reason, "invalid_grant");
});

test("createDefaultAdminService runs credential alert email monitor for platform admins", async () => {
  const alert: AlertRecord = {
    id: "alert_health_invalid_grant",
    title: "invalid_grant returned by upstream OAuth",
    severity: "high",
    source: "provider-auth",
    reason: "invalid_grant",
    status: "active",
    credentialId: "cred_openai_1",
    affectedSessions: 1,
    firstSeenAt: "2026-06-17T10:00:00.000Z",
    lastSeenAt: "2026-06-17T10:00:00.000Z",
    owner: null,
    runbook: "Rotate the underlying grant.",
  };
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const auditEvents: Array<{
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary?: string | null;
  }> = [];
  const service = createDefaultAdminService(
    "http://den.example.test",
    {
      denClient: {
        ...createDenClient(),
        async listPlatformAdminRecipients() {
          return [{ userId: "admin_1", email: "admin@example.test", name: "Admin" }];
        },
      },
      alertRepository: {
        async listAlerts() {
          return [alert];
        },
      },
      auditRepository: {
        async listEvents() {
          return [];
        },
        async recordEvent(input) {
          auditEvents.push(input);
        },
      },
      alertEmailRecipients: [],
      sendAlertEmail: async (input) => sent.push(input),
      now: () => new Date("2026-06-17T10:02:00.000Z"),
    } as never,
  );

  assert.equal(typeof service.runCredentialAlertEmailMonitor, "function");
  const result = await service.runCredentialAlertEmailMonitor();

  assert.equal(result.emailsSent, 1);
  assert.equal(sent[0]?.to, "admin@example.test");
  assert.match(sent[0]?.subject ?? "", /invalid_grant returned by upstream OAuth/);
  assert.equal(auditEvents[0]?.action, "credential_alert.email.sent");
});
