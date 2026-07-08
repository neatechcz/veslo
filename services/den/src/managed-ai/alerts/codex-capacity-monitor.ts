import { createHash } from "node:crypto"

import {
  buildCodexCapacityAlertEmail,
  buildCodexCapacityAlerts,
  shouldEmailCodexCapacityAlert,
} from "./codex-capacity-alerts.js"
import type { AlertRecord } from "./repository.js"
import type { AuditEventRecord, AuditRepository } from "../audit/repository.js"
import type { CodexCapacityOverview } from "../usage/codex-capacity.js"

const EMAIL_SENT_ACTION = "codex_capacity_alert.email.sent"
const EMAIL_FAILED_ACTION = "codex_capacity_alert.email.failed"
const EMAIL_SENT_ENTITY_TYPE = "codex_capacity_alert_email"
const LEGACY_EMAIL_SENT_ENTITY_TYPE = "codex_capacity_alert"
const EMAIL_DEDUPE_EVENT_LIMIT = 5000
const EMAIL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

type CodexCapacityAlertEmailInput = {
  to: string
  subject: string
  html: string
  text: string
}

export type CodexCapacityAlertMonitorDeps = {
  loadCapacityOverview: () => Promise<CodexCapacityOverview>
  listAdminRecipients: () => Promise<string[]>
  sendEmail: (input: CodexCapacityAlertEmailInput) => Promise<void>
  audit: Pick<AuditRepository, "recordEvent" | "listEvents">
  now?: () => Date
  state?: CodexCapacityAlertMonitorState
}

type CodexCapacityAlertMonitorState = {
  sentEmailKeys: Set<string>
}

export type CodexCapacityAlertMonitorResult = {
  evaluatedAlerts: number
  emailsSent: number
  recipients: number
  skipped?: boolean
}

export function createCodexCapacityAlertMonitorRunner(
  deps: CodexCapacityAlertMonitorDeps,
): () => Promise<CodexCapacityAlertMonitorResult> {
  let inFlight: Promise<CodexCapacityAlertMonitorResult> | null = null
  const state = deps.state ?? { sentEmailKeys: new Set<string>() }

  return () => {
    if (inFlight) {
      return Promise.resolve({
        evaluatedAlerts: 0,
        emailsSent: 0,
        recipients: 0,
        skipped: true,
      })
    }

    const run = runCodexCapacityAlertMonitor({
      ...deps,
      state,
    }).finally(() => {
      if (inFlight === run) {
        inFlight = null
      }
    })
    inFlight = run
    return run
  }
}

export async function runCodexCapacityAlertMonitor(
  deps: CodexCapacityAlertMonitorDeps,
): Promise<CodexCapacityAlertMonitorResult> {
  const now = deps.now?.() ?? new Date()
  const capacity = await deps.loadCapacityOverview()
  const alerts = buildCodexCapacityAlerts(capacity, now)
    .filter(shouldEmailCodexCapacityAlert)
  const recipients = uniqueEmails(await deps.listAdminRecipients())

  if (alerts.length === 0 || recipients.length === 0) {
    return {
      evaluatedAlerts: alerts.length,
      emailsSent: 0,
      recipients: recipients.length,
    }
  }

  const sentEmailKeys = await listAlreadySentEmailKeys(deps.audit, now)
  for (const key of deps.state?.sentEmailKeys ?? []) {
    sentEmailKeys.add(key)
  }

  let emailsSent = 0
  const failures: Error[] = []
  for (const alert of alerts) {
    const email = buildCodexCapacityAlertEmail(alert, capacity)
    for (const recipient of recipients) {
      const emailKey = buildEmailDeduplicationKey(alert.id, recipient)
      if (sentEmailKeys.has(emailKey) || sentEmailKeys.has(alert.id)) {
        continue
      }

      try {
        await deps.sendEmail({
          to: recipient,
          ...email,
        })
        emailsSent += 1
        sentEmailKeys.add(emailKey)
        deps.state?.sentEmailKeys.add(emailKey)
        await recordAlertRecipientEmailSent(deps.audit, alert, recipient, emailKey)
      } catch (error) {
        failures.push(toError(error))
        await recordAlertRecipientEmailFailedBestEffort(deps.audit, alert, recipient, emailKey, error)
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to send ${failures.length} Codex capacity alert email${failures.length === 1 ? "" : "s"}: ${failures.map((error) => error.message).join("; ")}`)
  }

  return {
    evaluatedAlerts: alerts.length,
    emailsSent,
    recipients: recipients.length,
  }
}

async function listAlreadySentEmailKeys(
  audit: Pick<AuditRepository, "listEvents">,
  now: Date,
): Promise<Set<string>> {
  if (!audit.listEvents) {
    return new Set()
  }

  const events = await audit.listEvents({ limit: EMAIL_DEDUPE_EVENT_LIMIT })
  const minimumTimestampMs = now.getTime() - EMAIL_DEDUPE_WINDOW_MS
  return new Set(
    events
      .filter(isCodexCapacityEmailSentEvent)
      .filter((event) => isRecentEvent(event, minimumTimestampMs))
      .map((event) => event.entityId),
  )
}

async function recordAlertRecipientEmailSent(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  emailKey: string,
) {
  try {
    await audit.recordEvent({
      actorUserId: "system",
      entityType: EMAIL_SENT_ENTITY_TYPE,
      entityId: emailKey,
      action: EMAIL_SENT_ACTION,
      result: "ok",
      summary: `Sent ${alert.title} email to ${recipient}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(`[den] managed-ai Codex capacity alert audit write failed: ${message}`)
  }
}

async function recordAlertRecipientEmailFailedBestEffort(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  emailKey: string,
  error: unknown,
) {
  try {
    await audit.recordEvent({
      actorUserId: "system",
      entityType: EMAIL_SENT_ENTITY_TYPE,
      entityId: emailKey,
      action: EMAIL_FAILED_ACTION,
      result: "error",
      summary: `Failed to send ${alert.title} email to ${recipient}: ${toError(error).message}`,
    })
  } catch {
    return
  }
}

function isCodexCapacityEmailSentEvent(event: AuditEventRecord): boolean {
  return event.action === EMAIL_SENT_ACTION &&
    (event.entityType === EMAIL_SENT_ENTITY_TYPE || event.entityType === LEGACY_EMAIL_SENT_ENTITY_TYPE)
}

function isRecentEvent(event: AuditEventRecord, minimumTimestampMs: number): boolean {
  const timestampMs = Date.parse(event.timestamp)
  return Number.isFinite(timestampMs) && timestampMs >= minimumTimestampMs
}

function uniqueEmails(input: string[]): string[] {
  return Array.from(new Set(
    input
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ))
}

function buildEmailDeduplicationKey(alertId: string, recipient: string): string {
  const recipientHash = createHash("sha256")
    .update(recipient.trim().toLowerCase())
    .digest("hex")
    .slice(0, 20)
  return `${alertId}:${recipientHash}`
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
