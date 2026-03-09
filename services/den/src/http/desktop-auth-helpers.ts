import crypto from "node:crypto"

const HANDOFF_TTL_MS = 5 * 60_000

export type HandoffRecord = {
  id: string
  code: string
  userId: string
  orgId: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

type ConsumeSuccess = { ok: true; record: HandoffRecord }
type ConsumeFailure = { ok: false; error: "code_expired" | "code_already_consumed" }

export function createHandoffCode(userId: string, orgId: string): HandoffRecord {
  return {
    id: crypto.randomUUID(),
    code: crypto.randomBytes(32).toString("base64url"),
    userId,
    orgId,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    consumedAt: null,
    createdAt: new Date(),
  }
}

export function consumeHandoffCode(record: HandoffRecord): ConsumeSuccess | ConsumeFailure {
  if (record.consumedAt !== null) {
    return { ok: false, error: "code_already_consumed" }
  }
  if (record.expiresAt <= new Date()) {
    return { ok: false, error: "code_expired" }
  }
  return {
    ok: true,
    record: { ...record, consumedAt: new Date() },
  }
}
