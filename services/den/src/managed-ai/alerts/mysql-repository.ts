import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { auditEventTable, credentialBindingTable, credentialHealthEventTable, sessionLeaseTable } from "../schema.js"
import type { AlertActionInput, AlertRecord, AlertRepository, AlertSignalSummary } from "./repository.js"

export class MySqlAlertRepository implements AlertRepository {
  constructor(private readonly db: any) {}

  async listAlerts(): Promise<AlertRecord[]> {
    const healthEventRows = await this.db
      .select({
        eventId: credentialHealthEventTable.id,
        credentialId: credentialHealthEventTable.credential_record_id,
        reason: credentialHealthEventTable.reason,
        toState: credentialHealthEventTable.to_state,
        occurredAt: credentialHealthEventTable.created_at,
      })
      .from(credentialHealthEventTable)
      .orderBy(desc(credentialHealthEventTable.created_at))
      .limit(100)

    if (healthEventRows.length === 0) {
      return []
    }

    const [activeLeaseRows, auditRows] = await Promise.all([
      this.db
        .select({
          credentialRecordId: credentialBindingTable.credential_record_id,
          activeLeases: sql<number>`count(*)`,
        })
        .from(sessionLeaseTable)
        .innerJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
        .groupBy(credentialBindingTable.credential_record_id),
      this.db
        .select({
          alertId: auditEventTable.entity_id,
          actor: auditEventTable.actor_user_id,
          action: auditEventTable.action,
          createdAt: auditEventTable.created_at,
        })
        .from(auditEventTable)
        .where(
          and(
            eq(auditEventTable.entity_type, "alert"),
            inArray(
              auditEventTable.entity_id,
              healthEventRows.map((row: { eventId: string }) => `alert_${row.eventId}`),
            ),
          ),
        )
        .orderBy(desc(auditEventTable.created_at)),
    ])

    const activeLeasesByCredential = new Map<string, number>(
      activeLeaseRows.map((row: { credentialRecordId: string; activeLeases: number }) => [
        row.credentialRecordId,
        Number(row.activeLeases ?? 0),
      ]),
    )

    const latestAuditByAlertId = new Map<string, { action: string; actor: string | null }>()
    for (const row of auditRows) {
      if (!latestAuditByAlertId.has(row.alertId)) {
        latestAuditByAlertId.set(row.alertId, {
          action: row.action,
          actor: row.actor,
        })
      }
    }

    return healthEventRows.map((row: {
      eventId: string
      credentialId: string | null
      reason: string | null
      toState: string
      occurredAt: Date | string | null
    }) => {
      const alert = buildAlertRecord({
        eventId: row.eventId,
        credentialId: row.credentialId,
        reason: row.reason,
        toState: row.toState,
        occurredAt: toIsoString(row.occurredAt),
        affectedSessions: activeLeasesByCredential.get(row.credentialId ?? "") ?? 0,
      })
      const override = latestAuditByAlertId.get(alert.id)
      if (!override) {
        return alert
      }

      return {
        ...alert,
        status: override.action === "alert.resolve" ? "resolved" : "acknowledged",
        owner: override.actor,
      }
    })
  }

  async acknowledgeAlert(input: AlertActionInput): Promise<AlertRecord | null> {
    return this.recordAlertAction({
      alertId: input.alertId,
      actorUserId: input.actorUserId ?? null,
      action: "alert.acknowledge",
      result: "warning",
      summary: `Acknowledged alert ${input.alertId}.`,
    })
  }

  async resolveAlert(input: AlertActionInput): Promise<AlertRecord | null> {
    return this.recordAlertAction({
      alertId: input.alertId,
      actorUserId: input.actorUserId ?? null,
      action: "alert.resolve",
      result: "ok",
      summary: `Resolved alert ${input.alertId}.`,
    })
  }

  private async recordAlertAction(input: {
    alertId: string
    actorUserId: string | null
    action: string
    result: "ok" | "warning" | "error"
    summary: string
  }) {
    const existing = await this.listAlerts()
    if (!existing.some((alert) => alert.id === input.alertId)) {
      return null
    }

    await this.db.insert(auditEventTable).values({
      id: `audit_${randomUUID()}`,
      actor_user_id: input.actorUserId,
      entity_type: "alert",
      entity_id: input.alertId,
      action: input.action,
      result: input.result,
      summary: input.summary,
      created_at: new Date(),
    })

    const updated = await this.listAlerts()
    return updated.find((alert) => alert.id === input.alertId) ?? null
  }
}

export function buildAlertRecord(input: AlertSignalSummary): AlertRecord {
  const reason = (input.reason ?? "").toLowerCase()
  const status = input.toState === "healthy" ? "resolved" : "active"

  if (isAuthFailure(reason)) {
    return {
      id: `alert_${input.eventId}`,
      title: "invalid_grant returned by upstream OAuth",
      severity: "high",
      source: "provider-auth",
      status,
      credentialId: input.credentialId,
      affectedSessions: input.affectedSessions,
      firstSeenAt: input.occurredAt,
      lastSeenAt: input.occurredAt,
      owner: null,
      runbook: "Rotate the underlying grant and inspect recent refresh failures for the credential.",
    }
  }

  if (isRateLimitFailure(reason)) {
    return {
      id: `alert_${input.eventId}`,
      title: "Provider rate limits increasing",
      severity: "high",
      source: "provider-rate-limit",
      status,
      credentialId: input.credentialId,
      affectedSessions: input.affectedSessions,
      firstSeenAt: input.occurredAt,
      lastSeenAt: input.occurredAt,
      owner: null,
      runbook: "Inspect quota pressure and rotate session load across healthy credentials.",
    }
  }

  if (isUnusualActivity(reason)) {
    return {
      id: `alert_${input.eventId}`,
      title: "Unusual upstream error activity detected",
      severity: "critical",
      source: "gateway-operations",
      status,
      credentialId: input.credentialId,
      affectedSessions: input.affectedSessions,
      firstSeenAt: input.occurredAt,
      lastSeenAt: input.occurredAt,
      owner: null,
      runbook: "Inspect recent upstream failures and failover churn for the affected credential pool.",
    }
  }

  return {
    id: `alert_${input.eventId}`,
    title: `Credential health changed to ${input.toState}`,
    severity: input.toState === "unhealthy" ? "high" : "medium",
    source: "credential-health",
    status,
    credentialId: input.credentialId,
    affectedSessions: input.affectedSessions,
    firstSeenAt: input.occurredAt,
    lastSeenAt: input.occurredAt,
    owner: null,
    runbook: "Inspect recent credential health transitions and active session impact.",
  }
}

function isAuthFailure(reason: string) {
  return (
    reason.includes("invalid_grant") ||
    reason.includes("revoked_token") ||
    reason.includes("invalid_api_key") ||
    reason.includes("authentication_error") ||
    reason.includes("auth")
  )
}

function isRateLimitFailure(reason: string) {
  return reason.includes("rate_limit") || reason.includes("quota") || reason.includes("429")
}

function isUnusualActivity(reason: string) {
  return reason.includes("timeout") || reason.includes("overload") || reason.includes("upstream")
}

function toIsoString(value: Date | string | null) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "string") {
    return value
  }

  return new Date(0).toISOString()
}
