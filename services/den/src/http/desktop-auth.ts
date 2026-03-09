import { randomBytes, randomUUID } from "node:crypto"

export const DESKTOP_AUTH_HANDOFF_TTL_MS = 5 * 60 * 1000

export type DesktopAuthHandoffRecord = {
  id: string
  code: string
  user_id: string
  org_id: string
  session_token: string
  expires_at: Date
  consumed_at: Date | null
  created_at: Date
}

export type DesktopAuthUserSummary = {
  id: string
  email: string
  name: string | null
}

export type DesktopAuthOrganizationSummary = {
  id: string
  name: string
  slug: string
  ownerUserId: string
}

export function createDesktopAuthCode() {
  return randomBytes(24).toString("base64url")
}

export function buildDesktopAuthHandoffRecord(input: {
  userId: string
  orgId: string
  sessionToken: string
  now?: Date
  createId?: () => string
  createCode?: () => string
}): DesktopAuthHandoffRecord {
  const now = input.now ?? new Date()
  const createId = input.createId ?? randomUUID
  const createCode = input.createCode ?? createDesktopAuthCode

  return {
    id: createId(),
    code: createCode(),
    user_id: input.userId,
    org_id: input.orgId,
    session_token: input.sessionToken,
    expires_at: new Date(now.getTime() + DESKTOP_AUTH_HANDOFF_TTL_MS),
    consumed_at: null,
    created_at: now,
  }
}

export function resolveDesktopAuthHandoffStatus(
  record: Pick<DesktopAuthHandoffRecord, "expires_at" | "consumed_at">,
  now = new Date(),
) {
  if (record.consumed_at) {
    return { ok: false as const, error: "consumed" as const }
  }

  if (record.expires_at.getTime() <= now.getTime()) {
    return { ok: false as const, error: "expired" as const }
  }

  return { ok: true as const }
}

export function buildDesktopAuthExchangePayload(input: {
  apiBaseUrl: string
  token: string
  user: DesktopAuthUserSummary
  organization: DesktopAuthOrganizationSummary
}) {
  return {
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
    user: input.user,
    organization: input.organization,
  }
}
