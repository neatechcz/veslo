import assert from "node:assert/strict"
import { getTableName } from "drizzle-orm"
import test from "node:test"

import { AuditEventTable } from "../src/db/schema.js"
import { MySqlAlertRepository } from "../src/managed-ai/alerts/mysql-repository.js"
import { MySqlAuditRepository } from "../src/managed-ai/audit/mysql-repository.js"
import {
  credentialHealthEventTable,
  ManagedAiTableNames,
  managedAiAuditEventTable,
} from "../src/managed-ai/schema.js"

test("managed-AI audit events use the AI Gateway-owned table, not core Den audit_event", () => {
  assert.equal(getTableName(AuditEventTable), "audit_event")
  assert.equal(ManagedAiTableNames.audit_event, "ai_gateway_audit_event")
  assert.equal(getTableName(managedAiAuditEventTable), "ai_gateway_audit_event")
  assert.notEqual(getTableName(AuditEventTable), getTableName(managedAiAuditEventTable))
})

test("managed-AI audit repositories never select or write the core Den audit table", async () => {
  const capture = createManagedAiDbCapture()
  const audit = new MySqlAuditRepository(capture.db)
  const alerts = new MySqlAlertRepository(capture.db)

  await audit.recordEvent({
    actorUserId: null,
    entityType: "capacity_alert",
    entityId: "alert_1",
    action: "email.sent",
    result: "ok",
    summary: "sent",
  })
  await audit.listEvents({ limit: 10 })
  await alerts.listAlerts()
  await alerts.acknowledgeAlert({ alertId: "alert_health_1", actorUserId: "user_1" })

  assert.ok(capture.reads.includes(managedAiAuditEventTable))
  assert.ok(capture.writes.every((table) => table === managedAiAuditEventTable))
  assert.ok(!capture.reads.includes(AuditEventTable))
  assert.ok(!capture.writes.includes(AuditEventTable))
})

function createManagedAiDbCapture() {
  const reads: unknown[] = []
  const writes: unknown[] = []
  const healthEvents = [
    {
      eventId: "health_1",
      credentialId: "credential_1",
      reason: "timeout",
      toState: "unhealthy",
      occurredAt: new Date("2026-07-28T00:00:00.000Z"),
    },
  ]

  const rowsFor = (table: unknown) =>
    table === credentialHealthEventTable ? healthEvents : []

  const queryFor = (table: unknown) => {
    const rows = rowsFor(table)
    const query = {
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      groupBy: () => query,
      limit: async () => rows,
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: typeof rows) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onfulfilled, onrejected),
    }
    return query
  }

  return {
    reads,
    writes,
    db: {
      select: () => ({
        from: (table: unknown) => {
          reads.push(table)
          return queryFor(table)
        },
      }),
      insert: (table: unknown) => {
        writes.push(table)
        return { values: async (_value: unknown) => undefined }
      },
    },
  }
}

test("a missing AI Gateway audit table fails closed with an actionable code", async () => {
  const missingTable = Object.assign(new Error("Table 'den.ai_gateway_audit_event' doesn't exist"), {
    code: "ER_NO_SUCH_TABLE",
    errno: 1146,
  })
  const repository = new MySqlAuditRepository({
    insert: () => ({
      values: async () => {
        throw missingTable
      },
    }),
  })

  // Den reads this table but does not own its migration, and it accepts a
  // separate MANAGED_AI_DATABASE_URL. A raw driver error here says nothing
  // about deployment order.
  await assert.rejects(
    repository.recordEvent({
      entityType: "credential",
      entityId: "cred-1",
      action: "created",
      result: "success",
    } as never),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "managed_ai_audit_schema_unavailable")
      assert.match((error as Error).message, /ai_gateway_audit_event/)
      assert.match((error as Error).message, /AI Gateway migrations/)
      return true
    },
  )
})

test("an unrelated database error is not disguised as a schema gap", async () => {
  const repository = new MySqlAuditRepository({
    insert: () => ({
      values: async () => {
        throw new Error("connection lost")
      },
    }),
  })

  await assert.rejects(
    repository.recordEvent({
      entityType: "credential",
      entityId: "cred-1",
      action: "created",
      result: "success",
    } as never),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, undefined)
      assert.match((error as Error).message, /connection lost/)
      return true
    },
  )
})

test("alert actions translate a missing managed-AI audit table", async () => {
  const missingTable = Object.assign(new Error("Table 'den.ai_gateway_audit_event' doesn't exist"), {
    code: "ER_NO_SUCH_TABLE",
    errno: 1146,
  })
  const capture = createManagedAiDbCapture()
  capture.db.insert = () => ({
    values: async () => {
      throw missingTable
    },
  })
  const repository = new MySqlAlertRepository(capture.db)

  await assert.rejects(
    repository.acknowledgeAlert({ alertId: "alert_health_1", actorUserId: "user_1" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "managed_ai_audit_schema_unavailable")
      return true
    },
  )
})
