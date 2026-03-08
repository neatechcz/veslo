import { randomUUID } from "crypto"
import { db } from "./db/index.js"
import { AuditEventTable } from "./db/schema.js"

export async function recordAuditEvent(input: {
  orgId: string
  actorUserId: string
  action: string
  workerId?: string | null
  payload?: unknown
}) {
  await db.insert(AuditEventTable).values({
    id: randomUUID(),
    org_id: input.orgId,
    worker_id: input.workerId ?? null,
    actor_user_id: input.actorUserId,
    action: input.action,
    payload: input.payload ?? null,
  })
}
