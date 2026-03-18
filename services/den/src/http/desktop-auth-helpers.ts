import crypto from "node:crypto"

const HANDOFF_TTL_MS = 5 * 60_000
export const DESKTOP_AUTH_SESSION_TTL_MS = 10 * 60_000
export const DESKTOP_AUTH_ALLOWED_REDIRECT_PROTOCOLS = new Set(["veslo:", "http:", "https:"])

export type HandoffRecord = {
  id: string
  code: string
  sessionId: string | null
  userId: string
  orgId: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

type ConsumeSuccess = { ok: true; record: HandoffRecord }
type ConsumeFailure = { ok: false; error: "code_expired" | "code_already_consumed" }

export function createHandoffCode(userId: string, orgId: string, sessionId?: string | null): HandoffRecord {
  return {
    id: crypto.randomUUID(),
    code: crypto.randomBytes(32).toString("base64url"),
    sessionId: sessionId ?? null,
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

export function hashState(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex")
}

export function hashAuthCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex")
}

export function createPkceS256Challenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url")
}

export function isValidRedirectUri(rawRedirectUri: string): boolean {
  try {
    const parsed = new URL(rawRedirectUri)
    return DESKTOP_AUTH_ALLOWED_REDIRECT_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}
