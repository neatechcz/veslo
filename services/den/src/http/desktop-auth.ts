import crypto from "node:crypto"
import express from "express"
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm"
import { db } from "../db/index.js"
import { AuthSessionTable, DesktopAuthHandoffTable, DesktopAuthSessionTable } from "../db/schema.js"
import { env } from "../env.js"
import { requireSession } from "./session.js"
import { resolveMembershipOrganizations, readRequestedOrganizationId, serializeOrganization } from "./org-auth.js"
import { pickActiveOrganization } from "./access.js"
import {
  createHandoffCode,
  consumeHandoffCode,
  createPkceS256Challenge,
  hashState,
  isValidRedirectUri,
  DESKTOP_AUTH_SESSION_TTL_MS,
  type HandoffRecord,
} from "./desktop-auth-helpers.js"

export { createHandoffCode, consumeHandoffCode, type HandoffRecord } from "./desktop-auth-helpers.js"

export const desktopAuthRouter = express.Router()
const CONSUMED_HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000
const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PKCE_CHALLENGE_METHOD = "S256"
const DEFAULT_DESKTOP_REDIRECT_URI = "veslo://auth-complete"
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{20,255}$/
const STATE_PATTERN = /^[A-Za-z0-9._~-]{12,512}$/
const baseUrl = env.betterAuthUrl.replace(/\/+$/, "")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseStartBody(rawBody: unknown):
  | {
      ok: true
      intent: "signin" | "signup"
      redirectUri: string
      state: string
      codeChallenge: string
    }
  | { ok: false; status: number; error: string } {
  if (!isRecord(rawBody)) {
    return { ok: false, status: 400, error: "invalid_body" }
  }

  const intent = rawBody.intent === "signup" ? "signup" : "signin"
  const redirectUri = readTrimmedString(rawBody.redirectUri) ?? DEFAULT_DESKTOP_REDIRECT_URI
  if (!isValidRedirectUri(redirectUri)) {
    return { ok: false, status: 400, error: "invalid_redirect_uri" }
  }

  const state = readTrimmedString(rawBody.state)
  if (!state || !STATE_PATTERN.test(state)) {
    return { ok: false, status: 400, error: "invalid_state" }
  }

  const codeChallengeMethod = readTrimmedString(rawBody.codeChallengeMethod)
  if (codeChallengeMethod !== PKCE_CHALLENGE_METHOD) {
    return { ok: false, status: 400, error: "invalid_code_challenge_method" }
  }

  const codeChallenge = readTrimmedString(rawBody.codeChallenge)
  if (!codeChallenge || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return { ok: false, status: 400, error: "invalid_code_challenge" }
  }

  return { ok: true, intent, redirectUri, state, codeChallenge }
}

function buildDesktopAuthorizeUrl(sessionId: string, intent: "signin" | "signup"): string {
  const params = new URLSearchParams({
    desktopOnboarding: "1",
    sid: sessionId,
    intent,
  })
  return `${baseUrl}/?${params.toString()}`
}

function buildRedirectUrl(redirectUri: string, code: string, sessionId: string | null): string {
  try {
    const redirect = new URL(redirectUri)
    redirect.searchParams.set("code", code)
    if (sessionId) {
      redirect.searchParams.set("sessionId", sessionId)
    }
    return redirect.toString()
  } catch {
    const joiner = redirectUri.includes("?") ? "&" : "?"
    const params = new URLSearchParams()
    params.set("code", code)
    if (sessionId) params.set("sessionId", sessionId)
    return `${redirectUri}${joiner}${params.toString()}`
  }
}

function getAffectedRows(value: unknown): number | null {
  if (Array.isArray(value) && value.length > 0) {
    return getAffectedRows(value[0])
  }

  if (!isRecord(value)) {
    return null
  }

  return typeof value.affectedRows === "number" ? value.affectedRows : null
}

async function cleanupStaleHandoffs() {
  const now = new Date()
  const consumedCutoff = new Date(now.getTime() - CONSUMED_HANDOFF_RETENTION_MS)
  await db
    .delete(DesktopAuthHandoffTable)
    .where(
      or(
        lt(DesktopAuthHandoffTable.expires_at, now),
        and(isNotNull(DesktopAuthHandoffTable.consumed_at), lt(DesktopAuthHandoffTable.consumed_at, consumedCutoff)),
      ),
    )
}

async function cleanupStaleDesktopSessions() {
  const now = new Date()
  await db
    .update(DesktopAuthSessionTable)
    .set({ status: "expired" })
    .where(
      and(
        lt(DesktopAuthSessionTable.expires_at, now),
        or(
          eq(DesktopAuthSessionTable.status, "started"),
          eq(DesktopAuthSessionTable.status, "browser_authed"),
        ),
      ),
    )
}

async function runDesktopAuthCleanup() {
  await cleanupStaleHandoffs()
  await cleanupStaleDesktopSessions()
}

desktopAuthRouter.post("/start", async (req, res) => {
  const parsed = parseStartBody(req.body)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  await runDesktopAuthCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth] cleanup warning: ${message}`)
  })

  const sessionId = crypto.randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_SESSION_TTL_MS)

  await db.insert(DesktopAuthSessionTable).values({
    id: sessionId,
    intent: parsed.intent,
    state_hash: hashState(parsed.state),
    code_challenge: parsed.codeChallenge,
    code_challenge_method: PKCE_CHALLENGE_METHOD,
    redirect_uri: parsed.redirectUri,
    status: "started",
    user_id: null,
    org_id: null,
    browser_ip: null,
    browser_user_agent: null,
    expires_at: expiresAt,
    exchanged_at: null,
    created_at: now,
  })

  res.status(201).json({
    sessionId,
    authorizeUrl: buildDesktopAuthorizeUrl(sessionId, parsed.intent),
    expiresAt: expiresAt.toISOString(),
  })
})

desktopAuthRouter.post("/handoff", async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  await runDesktopAuthCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth] cleanup warning: ${message}`)
  })

  const organizations = await resolveMembershipOrganizations(session)
  const requestedOrgId = readRequestedOrganizationId(req)
  const picked = pickActiveOrganization(organizations, requestedOrgId)

  if (!picked.ok) {
    res.status(picked.status).json({
      error: picked.error,
      organizations: organizations.map(serializeOrganization),
    })
    return
  }

  const requestedSessionId = readTrimmedString(isRecord(req.body) ? req.body.sessionId : null)
  let redirectUri = DEFAULT_DESKTOP_REDIRECT_URI

  if (requestedSessionId) {
    const rows = await db
      .select()
      .from(DesktopAuthSessionTable)
      .where(eq(DesktopAuthSessionTable.id, requestedSessionId))
      .limit(1)

    const desktopSession = rows[0]
    if (!desktopSession) {
      res.status(404).json({ error: "session_not_found" })
      return
    }

    if (desktopSession.expires_at <= new Date()) {
      res.status(410).json({ error: "session_expired" })
      return
    }

    if (desktopSession.status !== "started") {
      res.status(409).json({ error: "session_not_open" })
      return
    }

    const updateResult = await db
      .update(DesktopAuthSessionTable)
      .set({
        status: "browser_authed",
        user_id: session.user.id,
        org_id: picked.organization.id,
        browser_ip: req.ip ?? null,
        browser_user_agent: req.get("user-agent") ?? null,
      })
      .where(
        and(
          eq(DesktopAuthSessionTable.id, requestedSessionId),
          eq(DesktopAuthSessionTable.status, "started"),
          gt(DesktopAuthSessionTable.expires_at, new Date()),
        ),
      )

    const affectedRows = getAffectedRows(updateResult)
    if (affectedRows !== 1) {
      res.status(409).json({ error: "session_not_open" })
      return
    }

    redirectUri = desktopSession.redirect_uri
  }

  const record = createHandoffCode(session.user.id, picked.organization.id, requestedSessionId)

  await db.insert(DesktopAuthHandoffTable).values({
    id: record.id,
    code: record.code,
    session_id: record.sessionId,
    user_id: record.userId,
    org_id: record.orgId,
    expires_at: record.expiresAt,
    consumed_at: null,
    created_at: record.createdAt,
  })

  if (requestedSessionId) {
    res.json({
      code: record.code,
      sessionId: requestedSessionId,
      redirectUrl: buildRedirectUrl(redirectUri, record.code, requestedSessionId),
    })
    return
  }

  res.json({ code: record.code })
})

desktopAuthRouter.post("/exchange", async (req, res) => {
  const body = isRecord(req.body) ? req.body : {}
  const code = readTrimmedString(body.code)
  if (!code) {
    res.status(400).json({ error: "missing_code" })
    return
  }

  const proofSessionId = readTrimmedString(body.sessionId)
  const proofState = readTrimmedString(body.state)
  const proofCodeVerifier = readTrimmedString(body.codeVerifier)
  const exchangeProofProvided = Boolean(proofSessionId || proofState || proofCodeVerifier)
  const exchangeProofComplete = Boolean(proofSessionId && proofState && proofCodeVerifier)

  if (exchangeProofProvided && !exchangeProofComplete) {
    res.status(400).json({ error: "missing_exchange_proof" })
    return
  }

  await runDesktopAuthCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth] cleanup warning: ${message}`)
  })

  const now = new Date()
  const exchangeResult = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(DesktopAuthHandoffTable)
      .where(eq(DesktopAuthHandoffTable.code, code))
      .limit(1)

    const row = rows[0]
    if (!row) {
      return { ok: false as const, status: 404, error: "code_not_found" as const }
    }

    const record: HandoffRecord = {
      id: row.id,
      code: row.code,
      sessionId: row.session_id,
      userId: row.user_id,
      orgId: row.org_id,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    }

    const result = consumeHandoffCode(record)
    if (!result.ok) {
      return { ok: false as const, status: 410, error: result.error }
    }

    if (record.sessionId && !exchangeProofComplete) {
      return { ok: false as const, status: 400, error: "missing_exchange_proof" as const }
    }

    if (exchangeProofComplete) {
      const requiredSessionId = proofSessionId as string
      const requiredState = proofState as string
      const requiredCodeVerifier = proofCodeVerifier as string

      if (!record.sessionId) {
        return { ok: false as const, status: 400, error: "code_not_bound_to_session" as const }
      }
      if (record.sessionId !== requiredSessionId) {
        return { ok: false as const, status: 401, error: "session_mismatch" as const }
      }

      const desktopSessionRows = await tx
        .select()
        .from(DesktopAuthSessionTable)
        .where(eq(DesktopAuthSessionTable.id, requiredSessionId))
        .limit(1)

      const desktopSession = desktopSessionRows[0]
      if (!desktopSession) {
        return { ok: false as const, status: 404, error: "session_not_found" as const }
      }

      if (desktopSession.expires_at <= now) {
        return { ok: false as const, status: 410, error: "session_expired" as const }
      }

      if (desktopSession.status !== "browser_authed") {
        return { ok: false as const, status: 409, error: "session_not_ready" as const }
      }

      if (desktopSession.user_id !== record.userId || desktopSession.org_id !== record.orgId) {
        return { ok: false as const, status: 409, error: "session_subject_mismatch" as const }
      }

      const computedStateHash = hashState(requiredState)
      if (computedStateHash !== desktopSession.state_hash) {
        return { ok: false as const, status: 401, error: "invalid_state" as const }
      }

      if (desktopSession.code_challenge_method !== PKCE_CHALLENGE_METHOD) {
        return { ok: false as const, status: 400, error: "unsupported_code_challenge_method" as const }
      }

      const computedChallenge = createPkceS256Challenge(requiredCodeVerifier)
      if (computedChallenge !== desktopSession.code_challenge) {
        return { ok: false as const, status: 401, error: "invalid_code_verifier" as const }
      }
    }

    const updateResult = await tx
      .update(DesktopAuthHandoffTable)
      .set({ consumed_at: result.record.consumedAt })
      .where(and(
        eq(DesktopAuthHandoffTable.id, record.id),
        isNull(DesktopAuthHandoffTable.consumed_at),
        gt(DesktopAuthHandoffTable.expires_at, now),
      ))

    const affectedRows = getAffectedRows(updateResult)
    if (affectedRows !== 1) {
      return { ok: false as const, status: 410, error: "code_already_consumed" as const }
    }

    // Create a real Better Auth session so the token works with /v1/me
    const authSessionId = crypto.randomUUID()
    const sessionToken = crypto.randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS)

    await tx.insert(AuthSessionTable).values({
      id: authSessionId,
      userId: record.userId,
      token: sessionToken,
      expiresAt,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    })

    if (exchangeProofComplete) {
      const desktopSessionUpdateResult = await tx
        .update(DesktopAuthSessionTable)
        .set({
          status: "exchanged",
          exchanged_at: now,
        })
        .where(
          and(
            eq(DesktopAuthSessionTable.id, proofSessionId as string),
            eq(DesktopAuthSessionTable.status, "browser_authed"),
          ),
        )

      const desktopSessionAffectedRows = getAffectedRows(desktopSessionUpdateResult)
      if (desktopSessionAffectedRows !== 1) {
        return { ok: false as const, status: 409, error: "session_not_ready" as const }
      }
    }

    return {
      ok: true as const,
      token: sessionToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      userId: record.userId,
      orgId: record.orgId,
    }
  })

  if (!exchangeResult.ok) {
    res.status(exchangeResult.status).json({ error: exchangeResult.error })
    return
  }

  const organizations = await resolveMembershipOrganizations({
    user: { id: exchangeResult.userId, email: null, emailVerified: false, name: null },
  })

  const org = organizations.find((o) => o.id === exchangeResult.orgId)

  res.json({
    tokenType: "Bearer",
    token: exchangeResult.token,
    accessToken: exchangeResult.token,
    expiresIn: exchangeResult.expiresIn,
    user: { id: exchangeResult.userId },
    org: org
      ? { id: org.id, name: org.name, slug: org.slug, role: org.role }
      : { id: exchangeResult.orgId },
  })
})
