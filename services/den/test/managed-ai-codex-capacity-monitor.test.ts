import assert from "node:assert/strict"
import test from "node:test"

import {
  createCodexCapacityAlertMonitorRunner,
  runCodexCapacityAlertMonitor,
} from "../src/managed-ai/alerts/codex-capacity-monitor.js"
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

function toAuditEvent(input: RecordAuditEventInput, index: number): AuditEventRecord {
  return createAuditEvent({
    id: `audit_${index}`,
    timestamp: "2026-06-06T12:00:00.000Z",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    result: input.result,
    summary: input.summary ?? "",
  })
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
    result: event.result,
  })), [
    {
      action: "codex_capacity_alert.email.sent",
      entityType: "codex_capacity_alert_email",
      result: "ok",
    },
    {
      action: "codex_capacity_alert.email.sent",
      entityType: "codex_capacity_alert_email",
      result: "ok",
    },
  ])
  assert.notEqual(auditEvents[0]?.entityId, auditEvents[1]?.entityId)
})

test("Codex capacity monitor deduplicates already emailed alert recipients", async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const auditEvents: RecordAuditEventInput[] = []

  await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity(),
    listAdminRecipients: async () => ["admin-one@example.test"],
    sendEmail: async () => {
      return
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

  const result = await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity(),
    listAdminRecipients: async () => ["admin-one@example.test"],
    sendEmail: async (input) => {
      sent.push(input)
    },
    audit: {
      async listEvents() {
        return auditEvents.map(toAuditEvent)
      },
      async recordEvent() {
        assert.fail("deduped recipient should not record a new send")
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

test("Codex capacity monitor retries only recipients that failed before send completion", async () => {
  const auditEvents: RecordAuditEventInput[] = []
  const firstAttempts: string[] = []

  await assert.rejects(
    runCodexCapacityAlertMonitor({
      loadCapacityOverview: async () => createCapacity(),
      listAdminRecipients: async () => ["admin-one@example.test", "admin-two@example.test"],
      sendEmail: async (input) => {
        firstAttempts.push(input.to)
        if (input.to === "admin-two@example.test") {
          throw new Error("smtp unavailable")
        }
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
    }),
    /smtp unavailable/,
  )

  assert.deepEqual(firstAttempts, ["admin-one@example.test", "admin-two@example.test"])

  const retryAttempts: string[] = []
  const result = await runCodexCapacityAlertMonitor({
    loadCapacityOverview: async () => createCapacity(),
    listAdminRecipients: async () => ["admin-one@example.test", "admin-two@example.test"],
    sendEmail: async (input) => {
      retryAttempts.push(input.to)
    },
    audit: {
      async listEvents() {
        return auditEvents.map(toAuditEvent)
      },
      async recordEvent(input) {
        auditEvents.push(input)
      },
    },
    now: () => new Date("2026-06-06T12:01:00.000Z"),
  })

  assert.deepEqual(retryAttempts, ["admin-two@example.test"])
  assert.deepEqual(result, {
    evaluatedAlerts: 1,
    emailsSent: 1,
    recipients: 2,
  })
})

test("Codex capacity monitor runner skips overlapping runs", async () => {
  let releaseLoad: (() => void) | null = null
  let loadCalls = 0
  const runner = createCodexCapacityAlertMonitorRunner({
    loadCapacityOverview: async () => {
      loadCalls += 1
      await new Promise<void>((resolve) => {
        releaseLoad = resolve
      })
      return createCapacity()
    },
    listAdminRecipients: async () => ["admin-one@example.test"],
    sendEmail: async () => {
      return
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

  const firstRun = runner()
  const secondRun = await runner()
  releaseLoad?.()
  await firstRun

  assert.equal(loadCalls, 1)
  assert.deepEqual(secondRun, {
    evaluatedAlerts: 0,
    emailsSent: 0,
    recipients: 0,
    skipped: true,
  })
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
