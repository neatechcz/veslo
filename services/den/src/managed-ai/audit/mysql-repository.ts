import { randomUUID } from "node:crypto"

import { desc } from "drizzle-orm"

import { managedAiAuditEventTable } from "../schema.js"
import { withManagedAiAuditSchema } from "./schema-availability.js"
import type {
  AuditEventRecord,
  AuditRepository,
  ListAuditEventsInput,
  RecordAuditEventInput,
} from "./repository.js"

export class MySqlAuditRepository implements AuditRepository {
  constructor(private readonly db: any) {}

  async recordEvent(input: RecordAuditEventInput): Promise<void> {
    await withManagedAiAuditSchema(() =>
      this.db.insert(managedAiAuditEventTable).values({
        id: createAuditEventId(input),
        actor_user_id: input.actorUserId ?? null,
        entity_type: input.entityType,
        entity_id: input.entityId,
        action: input.action,
        result: input.result,
        summary: input.summary ?? null,
        created_at: new Date(),
      }),
    )
  }

  async listEvents(input: ListAuditEventsInput): Promise<AuditEventRecord[]> {
    const rows = await withManagedAiAuditSchema<
      (typeof managedAiAuditEventTable.$inferSelect)[]
    >(() =>
      this.db
        .select()
        .from(managedAiAuditEventTable)
        .orderBy(desc(managedAiAuditEventTable.created_at))
        .limit(input.limit),
    )

    return rows.map((row: typeof managedAiAuditEventTable.$inferSelect) => ({
      id: row.id,
      timestamp: toIsoString(row.created_at),
      actor: row.actor_user_id ?? "system",
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      result: normalizeResult(row.result),
      summary: row.summary ?? "",
      changedFields: [],
    }))
  }
}

export function createAuditEventId(_input: RecordAuditEventInput) {
  return `audit_${randomUUID()}`
}

function normalizeResult(value: string): AuditEventRecord["result"] {
  return value === "warning" || value === "error" ? value : "ok"
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
