import assert from "node:assert/strict";
import test from "node:test";

import {
  createCredentialAlertEmailMonitorRunner,
  runCredentialAlertEmailMonitor,
  shouldEmailCredentialAlert,
} from "../src/alerts/credential-alert-email-monitor.js";
import type { AlertRecord } from "../src/alerts/repository.js";
import type { AuditEventRecord, RecordAuditEventInput } from "../src/audit/repository.js";

function alert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: "alert_health_1",
    title: "Credential health changed to unhealthy",
    severity: "high",
    source: "credential-health",
    status: "active",
    credentialId: "cred_1",
    affectedSessions: 0,
    firstSeenAt: "2026-06-17T10:00:00.000Z",
    lastSeenAt: "2026-06-17T10:00:00.000Z",
    owner: null,
    runbook: "Inspect credential.",
    reason: "invalid_grant",
    ...overrides,
  } as AlertRecord;
}

function auditEvent(input: RecordAuditEventInput, index: number): AuditEventRecord {
  return {
    id: `audit_${index}`,
    timestamp: "2026-06-17T10:01:00.000Z",
    actor: input.actorUserId ?? "system",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    result: input.result,
    summary: input.summary ?? "",
    changedFields: [],
  };
}

test("credential alert monitor emails every platform admin for an active credential alert", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const auditEvents: RecordAuditEventInput[] = [];

  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [
      { userId: "admin_1", email: "admin-one@example.test", name: "Admin One" },
      { userId: "admin_2", email: "ADMIN-ONE@example.test", name: "Duplicate" },
      { userId: "admin_3", email: "admin-two@example.test", name: "Admin Two" },
    ],
    listFallbackRecipients: async () => ["fallback@example.test"],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent(input) {
        auditEvents.push(input);
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 2, recipients: 2 });
  assert.deepEqual(sent.map((entry) => entry.to), ["admin-one@example.test", "admin-two@example.test"]);
  assert.match(sent[0]?.subject ?? "", /Credential health changed to unhealthy/);
  assert.match(sent[0]?.text ?? "", /cred_1/);
  assert.ok(auditEvents.some((entry) => entry.action === "credential_alert.email.sent"));
  assert.ok(auditEvents.every((entry) => entry.entityId.length <= 64));
});

test("credential alert monitor skips resolved alerts", async () => {
  assert.equal(shouldEmailCredentialAlert(alert({ status: "resolved" })), false);
});

test("credential alert monitor skips non-fault credential state transitions", async () => {
  assert.equal(shouldEmailCredentialAlert(alert({ reason: "manual_drain", title: "Credential health changed to draining" })), false);
  assert.equal(shouldEmailCredentialAlert(alert({ reason: "codex_refresh_token_reused" })), true);
  assert.equal(shouldEmailCredentialAlert(alert({ source: "provider-auth", credentialId: null })), true);
});

test("credential alert monitor compacts repeated credential reason alerts within one run", async () => {
  const sent: Array<{ to: string }> = [];
  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [
      alert({ id: "alert_health_older", lastSeenAt: "2026-06-17T10:00:00.000Z" }),
      alert({ id: "alert_health_newer", lastSeenAt: "2026-06-17T10:05:00.000Z" }),
    ],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent() {
        return;
      },
    },
    now: () => new Date("2026-06-17T10:05:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 1, recipients: 1 });
  assert.equal(sent.length, 1);
});

test("credential alert monitor dedupes alert recipient and throttles same credential reason", async () => {
  const firstAuditEvents: RecordAuditEventInput[] = [];
  await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async () => undefined,
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent(input) {
        firstAuditEvents.push(input);
      },
    },
    now: () => new Date("2026-06-17T10:00:00.000Z"),
  });

  const sent: unknown[] = [];
  const result = await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert({ id: "alert_health_2", firstSeenAt: "2026-06-17T10:05:00.000Z" })],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return firstAuditEvents.map(auditEvent);
      },
      async recordEvent() {
        assert.fail("throttled alert should not write send audit");
      },
    },
    now: () => new Date("2026-06-17T10:05:00.000Z"),
  });

  assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 0, recipients: 1 });
  assert.deepEqual(sent, []);
});

test("credential alert monitor falls back to configured recipients when platform lookup fails", async () => {
  const sent: Array<{ to: string }> = [];
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await runCredentialAlertEmailMonitor({
      listAlerts: async () => [alert()],
      listPlatformAdminRecipients: async () => {
        throw new Error("den_down");
      },
      listFallbackRecipients: async () => ["fallback@example.test"],
      sendEmail: async (input) => sent.push(input),
      audit: {
        async listEvents() {
          return [];
        },
        async recordEvent() {
          return;
        },
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    });

    assert.deepEqual(result, { evaluatedAlerts: 1, emailsSent: 1, recipients: 1 });
    assert.deepEqual(sent.map((entry) => entry.to), ["fallback@example.test"]);
    assert.equal(errors[0]?.[0], "credential_alert_platform_admin_recipient_lookup_failed");
  } finally {
    console.error = originalConsoleError;
  }
});

test("credential alert monitor retries failed sends", async () => {
  const auditEvents: RecordAuditEventInput[] = [];
  await assert.rejects(
    runCredentialAlertEmailMonitor({
      listAlerts: async () => [alert()],
      listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
      listFallbackRecipients: async () => [],
      sendEmail: async () => {
        throw new Error("lettr_down");
      },
      audit: {
        async listEvents() {
          return [];
        },
        async recordEvent(input) {
          auditEvents.push(input);
        },
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    }),
    /lettr_down/,
  );

  const sent: unknown[] = [];
  await runCredentialAlertEmailMonitor({
    listAlerts: async () => [alert()],
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async (input) => sent.push(input),
    audit: {
      async listEvents() {
        return auditEvents.map(auditEvent);
      },
      async recordEvent() {
        return;
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  });

  assert.equal(sent.length, 1);
});

test("credential alert monitor runner skips overlapping runs", async () => {
  let releaseListAlerts: (() => void) | null = null;
  let listCalls = 0;
  const runner = createCredentialAlertEmailMonitorRunner({
    listAlerts: async () => {
      listCalls += 1;
      await new Promise<void>((resolve) => {
        releaseListAlerts = resolve;
      });
      return [alert()];
    },
    listPlatformAdminRecipients: async () => [{ userId: "admin_1", email: "admin@example.test", name: null }],
    listFallbackRecipients: async () => [],
    sendEmail: async () => undefined,
    audit: {
      async listEvents() {
        return [];
      },
      async recordEvent() {
        return;
      },
    },
    now: () => new Date("2026-06-17T10:01:00.000Z"),
  });

  const firstRun = runner();
  const secondRun = await runner();
  releaseListAlerts?.();
  await firstRun;

  assert.equal(listCalls, 1);
  assert.deepEqual(secondRun, {
    evaluatedAlerts: 0,
    emailsSent: 0,
    recipients: 0,
    skipped: true,
  });
});
