import assert from "node:assert/strict"
import test from "node:test"

import { runCodexCapacityAlertMonitor } from "../src/managed-ai/alerts/codex-capacity-monitor.js"
import type { AlertRecord } from "../src/managed-ai/alerts/repository.js"
import type { AuditEventRecord, RecordAuditEventInput } from "../src/managed-ai/audit/repository.js"
import type { CodexCapacityOverview } from "../src/managed-ai/usage/codex-capacity.js"

function createCapacity(overrides: Partial<CodexCapacityOverview> = {}): CodexCapacityOverview {
  return {
    codexCredentials: {
      total: 2,
      measurable: 2,
      unknown: 0,
      unavailable: 0,
    },
    fiveHour: {
      usedPercent: 95,
      remainingPercent: 5,
      measurableCredentials: 2,
    },
    weekly: {
      usedPercent: 40,
      remainingPercent: 60,
      measurableCredentials: 2,
    },
    credentials: [
      {
        id: "cred_codex_1",
        name: "Codex Team One",
        state: "healthy",
        fiveHourRemainingPercent: 5,
        weeklyRemainingPercent: 60,
        statusAvailable: true,
        limitsAvailable: true,
      },
      {
        id: "cred_codex_2",
        name: "Codex Team Two",
        state: "healthy",
        fiveHourRemainingPercent: 6,
        weeklyRemainingPercent: 61,
        statusAvailable: true,
        limitsAvailable: true,
      },
    ],
    ...overrides,
  }
}

function createAuditEvent(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: "audit_existing",
    timestamp: "2026-06-06T11:59:00.000Z",
    actor: "system",
    action: "codex_capacity_alert.email.sent",
    entityType: "codex_capacity_alert",
    entityId: "alert_codex_capacity_five_hour_95",
    result: "ok",
    summary: "",
    changedFields: [],
    ...overrides,
  }
}

test("Codex capacity monitor emails every admin recipient for urgent and critical alerts", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const auditEvents: RecordAuditEventInput[] = []

  const result = await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity(),
    listAdminRecipients: async () => ["admin-one@example.test", "admin-two@example.test"],
    sendEmail: async (input) => {
      sent.push(input)
    },
    audit: {
      async listEvents() {
        return []
      },
      async recordEvent(input) {
        auditEvents.push(input)
      },
    },
    now: () => new Date("2026-06-06T12:00:00.000Z"),
  })

  assert.deepEqual(result, {
    evaluatedAlerts: 1,
    emailsSent: 2,
    recipients: 2,
  })
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
  ])
  assert.match(sent[0]?.text ?? "", /Codex Team One: 5h 5% remaining, weekly 60% remaining/)
  assert.deepEqual(auditEvents.map((event) => ({
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    result: event.result,
  })), [{
    action: "codex_capacity_alert.email.sent",
    entityType: "codex_capacity_alert",
    entityId: "alert_codex_capacity_five_hour_95",
    result: "ok",
  }])
})

test("Codex capacity monitor deduplicates already emailed alert ids", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []

  const result = await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity(),
    listAdminRecipients: async () => ["admin-one@example.test"],
    sendEmail: async (input) => {
      sent.push(input)
    },
    audit: {
      async listEvents() {
        return [createAuditEvent()]
      },
      async recordEvent() {
        assert.fail("deduped alert should not record a new send")
      },
    },
    now: () => new Date("2026-06-06T12:00:00.000Z"),
  })

  assert.deepEqual(result, {
    evaluatedAlerts: 1,
    emailsSent: 0,
    recipients: 1,
  })
  assert.deepEqual(sent, [])
})

test("Codex capacity monitor sends critical email when Codex limits are not visible", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []

  const result = await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity({
      codexCredentials: {
        total: 1,
        measurable: 0,
        unknown: 0,
        unavailable: 1,
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
      credentials: [
        {
          id: "cred_codex_invisible",
          name: "Codex Invisible",
          state: "healthy",
          fiveHourRemainingPercent: null,
          weeklyRemainingPercent: null,
          statusAvailable: false,
          limitsAvailable: false,
        },
      ],
    }),
    listAdminRecipients: async () => ["admin-one@example.test"],
    sendEmail: async (input) => {
      sent.push(input)
    },
    audit: {
      async listEvents() {
        return []
      },
      async recordEvent() {
        return
      },
    },
    now: () => new Date("2026-06-06T12:00:00.000Z"),
  })

  assert.deepEqual(result, {
    evaluatedAlerts: 1,
    emailsSent: 1,
    recipients: 1,
  })
  assert.equal(sent[0]?.subject, "[CRITICAL] Codex limit visibility unavailable")
  assert.match(sent[0]?.text ?? "", /server cannot see Codex limits/i)
  assert.match(sent[0]?.text ?? "", /Codex Invisible: 5h unknown, weekly unknown/)
})
