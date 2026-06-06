import {
  buildCodexCapacityAlertEmail,
  buildCodexCapacityAlerts,
  shouldEmailCodexCapacityAlert,
} from "./codex-capacity-alerts.js"
import type { AlertRecord } from "./repository.js"
import type { AuditEventRecord, AuditRepository } from "../audit/repository.js"
import type { CodexCapacityOverview } from "../usage/codex-capacity.js"

const EMAIL_SENT_ACTION = "codex_capacity_alert.email.sent"
const EMAIL_SENT_ENTITY_TYPE = "codex_capacity_alert"

export type CodexCapacityAlertEmailInput = {
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
}

export type CodexCapacityAlertMonitorResult = {
  evaluatedAlerts: number
  emailsSent: number
  recipients: number
}

export async function runCodexCapacityAlertMonitor(
  deps: CodexCapacityAlertMonitorDeps,
): Promise<CodexCapacityAlertMonitorResult> {
  const capacity = await deps.loadCapacityOverview()
  const alerts = buildCodexCapacityAlerts(capacity, deps.now?.() ?? new Date())
    .filter(shouldEmailCodexCapacityAlert)
  const recipients = uniqueEmails(await deps.listAdminRecipients())

  if (alerts.length === 0 || recipients.length === 0) {
    return {
      evaluatedAlerts: alerts.length,
      emailsSent: 0,
      recipients: recipients.length,
    }
  }

  const sentAlertIds = await listAlreadySentAlertIds(deps.audit)
  let emailsSent = 0
  for (const alert of alerts) {
    if (sentAlertIds.has(alert.id)) {
      continue
    }
    const email = buildCodexCapacityAlertEmail(alert, capacity)
    for (const recipient of recipients) {
      await deps.sendEmail({
        to: recipient,
        ...email,
      })
      emailsSent += 1
    }
    await recordAlertEmailSent(deps.audit, alert, recipients.length)
  }

  return {
    evaluatedAlerts: alerts.length,
    emailsSent,
    recipients: recipients.length,
  }
}

async function listAlreadySentAlertIds(audit: Pick<AuditRepository, "listEvents">): Promise<Set<string>> {
  if (!audit.listEvents) {
    return new Set()
  }

  const events = await audit.listEvents({ limit: 500 })
  return new Set(
    events
      .filter(isCodexCapacityEmailSentEvent)
      .map((event) => event.entityId),
  )
}

async function recordAlertEmailSent(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipientCount: number,
) {
  await audit.recordEvent({
    actorUserId: "system",
    entityType: EMAIL_SENT_ENTITY_TYPE,
    entityId: alert.id,
    action: EMAIL_SENT_ACTION,
    result: "ok",
    summary: `Sent ${alert.title} email to ${recipientCount} platform admin${recipientCount === 1 ? "" : "s"}.`,
  })
}

function isCodexCapacityEmailSentEvent(event: AuditEventRecord): boolean {
  return event.action === EMAIL_SENT_ACTION && event.entityType === EMAIL_SENT_ENTITY_TYPE
}

function uniqueEmails(input: string[]): string[] {
  return Array.from(new Set(
    input
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ))
}
