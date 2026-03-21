import crypto from "node:crypto"
import express from "express"
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm"
import { db } from "../db/index.js"
import {
  AuthSessionTable,
  DesktopAuthHandoffTable,
  DesktopAuthTransactionTable,
} from "../db/schema.js"
import { env } from "../env.js"
import { asyncRoute } from "./errors.js"
import { requireSession } from "./session.js"
import { insertDesktopAuthHandoffRecord } from "./desktop-auth-handoff-recovery.js"
import {
  resolveMembershipOrganizations,
  readRequestedOrganizationId,
  serializeOrganization,
} from "./org-auth.js"
import { pickActiveOrganization } from "./access.js"
import {
  createHandoffCode,
  createPkceS256Challenge,
  hashAuthCode,
  hashState,
  isValidRedirectUri,
  DESKTOP_AUTH_SESSION_TTL_MS,
  type HandoffRecord,
} from "./desktop-auth-helpers.js"

export const desktopAuthV2Router = express.Router()
const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PKCE_CHALLENGE_METHOD = "S256"
const CONSUMED_HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{20,255}$/
const STATE_PATTERN = /^[A-Za-z0-9._~-]{12,512}$/
const baseUrl = env.betterAuthUrl.replace(/\/+$/, "")

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

function isAllowedDesktopRedirectUri(rawRedirectUri: string): boolean {
  if (!isValidRedirectUri(rawRedirectUri)) {
    return false
  }

  try {
    const parsed = new URL(rawRedirectUri)
    if (parsed.protocol === "veslo:") {
      return true
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false
    }

    const hostname = parsed.hostname.toLowerCase()
    const isLoopback = hostname === "127.0.0.1" || hostname === "localhost"
    if (!isLoopback) {
      return false
    }

    return parsed.port.length > 0
  } catch {
    return false
  }
}

function buildDesktopAuthorizeUrl(transactionId: string, intent: "signin" | "signup", state: string): string {
  const params = new URLSearchParams({
    desktopOnboarding: "1",
    tid: transactionId,
    intent,
    state,
  })
  return `${baseUrl}/?${params.toString()}`
}

function buildRedirectUrl(redirectUri: string, code: string, state: string, transactionId: string): string {
  try {
    const redirect = new URL(redirectUri)
    redirect.searchParams.set("code", code)
    redirect.searchParams.set("state", state)
    redirect.searchParams.set("transactionId", transactionId)
    return redirect.toString()
  } catch {
    const joiner = redirectUri.includes("?") ? "&" : "?"
    const params = new URLSearchParams()
    params.set("code", code)
    params.set("state", state)
    params.set("transactionId", transactionId)
    return `${redirectUri}${joiner}${params.toString()}`
  }
}

function buildTransactionId(): string {
  return `dat_${crypto.randomUUID().replaceAll("-", "")}`
}

function readAuthorizeTransport(req: express.Request): "json" | "redirect" {
  const requestedTransport = req.header("x-veslo-desktop-auth-transport")
  if (typeof requestedTransport === "string" && requestedTransport.trim().toLowerCase() === "json") {
    return "json"
  }

  return "redirect"
}

function sendAuthorizeSuccess(req: express.Request, res: express.Response, redirectUrl: string) {
  if (readAuthorizeTransport(req) === "json") {
    res.status(200).json({ redirectUrl })
    return
  }

  res.redirect(302, redirectUrl)
}

function mapTransactionStatus(
  status: "started" | "browser_authed" | "exchanged" | "expired" | "cancelled",
): "pending" | "authorized" | "exchanged" | "expired" | "cancelled" {
  if (status === "started") return "pending"
  if (status === "browser_authed") return "authorized"
  return status
}

async function cleanupStaleV2Transactions() {
  const now = new Date()
  await db
    .update(DesktopAuthTransactionTable)
    .set({ status: "expired" })
    .where(
      and(
        lt(DesktopAuthTransactionTable.expires_at, now),
        or(
          eq(DesktopAuthTransactionTable.status, "started"),
          eq(DesktopAuthTransactionTable.status, "browser_authed"),
        ),
      ),
    )
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

async function runCleanup() {
  await cleanupStaleV2Transactions()
  await cleanupStaleHandoffs()
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
  const redirectUri = readTrimmedString(rawBody.redirectUri)
  if (!redirectUri || !isAllowedDesktopRedirectUri(redirectUri)) {
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

function parseAuthorizeBody(rawBody: unknown):
  | { ok: true; transactionId: string; state: string }
  | { ok: false; status: number; error: string } {
  if (!isRecord(rawBody)) {
    return { ok: false, status: 400, error: "invalid_body" }
  }

  const transactionId = readTrimmedString(rawBody.transactionId)
  if (!transactionId) {
    return { ok: false, status: 400, error: "missing_transaction_id" }
  }

  const state = readTrimmedString(rawBody.state)
  if (!state || !STATE_PATTERN.test(state)) {
    return { ok: false, status: 400, error: "invalid_state" }
  }

  return { ok: true, transactionId, state }
}

function parseExchangeBody(rawBody: unknown):
  | {
      ok: true
      code: string
      codeVerifier: string
      transactionId: string | null
      state: string | null
    }
  | { ok: false; status: number; error: string } {
  if (!isRecord(rawBody)) {
    return { ok: false, status: 400, error: "invalid_body" }
  }

  const code = readTrimmedString(rawBody.code)
  if (!code) {
    return { ok: false, status: 400, error: "missing_code" }
  }

  const codeVerifier = readTrimmedString(rawBody.codeVerifier)
  if (!codeVerifier) {
    return { ok: false, status: 400, error: "missing_code_verifier" }
  }

  const transactionId = readTrimmedString(rawBody.transactionId)
  const state = readTrimmedString(rawBody.state)
  if (state && !STATE_PATTERN.test(state)) {
    return { ok: false, status: 400, error: "invalid_state" }
  }

  return { ok: true, code, codeVerifier, transactionId, state }
}

desktopAuthV2Router.post("/start", asyncRoute(async (req, res) => {
  const parsed = parseStartBody(req.body)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  await runCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth-v2] cleanup warning: ${message}`)
  })

  const transactionId = buildTransactionId()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_SESSION_TTL_MS)

  await db.insert(DesktopAuthTransactionTable).values({
    id: crypto.randomUUID(),
    transaction_id: transactionId,
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
    authorization_code_hash: null,
    manual_code_hash: null,
    code_issued_at: null,
    exchanged_at: null,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  })

  res.status(201).json({
    transactionId,
    authorizeUrl: buildDesktopAuthorizeUrl(transactionId, parsed.intent, parsed.state),
    expiresAt: expiresAt.toISOString(),
  })
}))

desktopAuthV2Router.post("/authorize", asyncRoute(async (req, res) => {
  const parsed = parseAuthorizeBody(req.body)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  await runCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth-v2] cleanup warning: ${message}`)
  })

  const session = await requireSession(req, res)
  if (!session) return

  if (env.desktopAuthRequireEmailVerified && !session.user.emailVerified) {
    res.status(403).json({ error: "email_verification_required" })
    return
  }

  const rows = await db
    .select()
    .from(DesktopAuthTransactionTable)
    .where(eq(DesktopAuthTransactionTable.transaction_id, parsed.transactionId))
    .limit(1)

  const transaction = rows[0]
  if (!transaction) {
    res.status(404).json({ error: "transaction_not_found" })
    return
  }

  if (transaction.status !== "started") {
    res.status(409).json({ error: "transaction_not_ready" })
    return
  }

  if (transaction.expires_at <= new Date()) {
    await db
      .update(DesktopAuthTransactionTable)
      .set({ status: "expired" })
      .where(eq(DesktopAuthTransactionTable.transaction_id, parsed.transactionId))
    res.status(410).json({ error: "transaction_not_ready" })
    return
  }

  const stateHash = hashState(parsed.state)
  if (stateHash !== transaction.state_hash) {
    res.status(401).json({ error: "invalid_state" })
    return
  }

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

  const handoffRecord = createHandoffCode(session.user.id, picked.organization.id, parsed.transactionId)
  const now = new Date()
  const transactionUpdateResult = await db
    .update(DesktopAuthTransactionTable)
    .set({
      status: "browser_authed",
      user_id: session.user.id,
      org_id: picked.organization.id,
      browser_ip: req.ip ?? null,
      browser_user_agent: req.get("user-agent") ?? null,
      authorization_code_hash: hashAuthCode(handoffRecord.code),
      manual_code_hash: hashAuthCode(handoffRecord.code),
      code_issued_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(DesktopAuthTransactionTable.transaction_id, parsed.transactionId),
        eq(DesktopAuthTransactionTable.status, "started"),
        gt(DesktopAuthTransactionTable.expires_at, now),
      ),
    )

  if (getAffectedRows(transactionUpdateResult) !== 1) {
    res.status(409).json({ error: "transaction_not_ready" })
    return
  }

  await insertDesktopAuthHandoffRecord({
    ...handoffRecord,
    sessionId: parsed.transactionId,
  })

  const redirectUrl = buildRedirectUrl(
    transaction.redirect_uri,
    handoffRecord.code,
    parsed.state,
    parsed.transactionId,
  )

  sendAuthorizeSuccess(req, res, redirectUrl)
}))

desktopAuthV2Router.get("/status", asyncRoute(async (req, res) => {
  const transactionId = readTrimmedString(req.query.transactionId)
  if (!transactionId) {
    res.status(400).json({ error: "missing_transaction_id" })
    return
  }

  const rows = await db
    .select()
    .from(DesktopAuthTransactionTable)
    .where(eq(DesktopAuthTransactionTable.transaction_id, transactionId))
    .limit(1)

  const transaction = rows[0]
  if (!transaction) {
    res.status(404).json({ error: "transaction_not_found" })
    return
  }

  const now = new Date()
  if (
    transaction.expires_at <= now &&
    (transaction.status === "started" || transaction.status === "browser_authed")
  ) {
    await db
      .update(DesktopAuthTransactionTable)
      .set({ status: "expired", updated_at: now })
      .where(eq(DesktopAuthTransactionTable.transaction_id, transactionId))

    res.status(200).json({
      status: "expired",
      transactionId,
      expiresAt: transaction.expires_at.toISOString(),
    })
    return
  }

  const mappedStatus = mapTransactionStatus(transaction.status)
  if (transaction.status !== "browser_authed") {
    res.status(200).json({
      status: mappedStatus,
      transactionId,
      expiresAt: transaction.expires_at.toISOString(),
    })
    return
  }

  const handoffRows = await db
    .select()
    .from(DesktopAuthHandoffTable)
    .where(eq(DesktopAuthHandoffTable.session_id, transactionId))
    .orderBy(desc(DesktopAuthHandoffTable.created_at))
    .limit(1)

  const handoff = handoffRows[0]
  res.status(200).json({
    status: mappedStatus,
    transactionId,
    code: handoff?.code ?? null,
    expiresAt: transaction.expires_at.toISOString(),
  })
}))

desktopAuthV2Router.post("/exchange", asyncRoute(async (req, res) => {
  const parsed = parseExchangeBody(req.body)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  await runCleanup().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth-v2] cleanup warning: ${message}`)
  })

  const now = new Date()
  const exchangeResult = await db.transaction(async (tx) => {
    const handoffRows = await tx
      .select()
      .from(DesktopAuthHandoffTable)
      .where(eq(DesktopAuthHandoffTable.code, parsed.code))
      .limit(1)

    const handoffRow = handoffRows[0]
    if (!handoffRow) {
      return { ok: false as const, status: 404, error: "transaction_not_found" as const }
    }

    const handoffRecord: HandoffRecord = {
      id: handoffRow.id,
      code: handoffRow.code,
      sessionId: handoffRow.session_id,
      userId: handoffRow.user_id,
      orgId: handoffRow.org_id,
      expiresAt: handoffRow.expires_at,
      consumedAt: handoffRow.consumed_at,
      createdAt: handoffRow.created_at,
    }

    if (handoffRecord.consumedAt) {
      return { ok: false as const, status: 410, error: "code_already_consumed" as const }
    }
    if (handoffRecord.expiresAt <= now) {
      return { ok: false as const, status: 410, error: "transaction_not_ready" as const }
    }

    const resolvedTransactionId = parsed.transactionId ?? handoffRecord.sessionId
    if (!resolvedTransactionId) {
      return { ok: false as const, status: 404, error: "transaction_not_found" as const }
    }
    if (handoffRecord.sessionId !== resolvedTransactionId) {
      return { ok: false as const, status: 404, error: "transaction_not_found" as const }
    }

    const transactionRows = await tx
      .select()
      .from(DesktopAuthTransactionTable)
      .where(eq(DesktopAuthTransactionTable.transaction_id, resolvedTransactionId))
      .limit(1)

    const transaction = transactionRows[0]
    if (!transaction) {
      return { ok: false as const, status: 404, error: "transaction_not_found" as const }
    }

    if (transaction.status !== "browser_authed") {
      return { ok: false as const, status: 409, error: "transaction_not_ready" as const }
    }

    if (transaction.expires_at <= now) {
      await tx
        .update(DesktopAuthTransactionTable)
        .set({ status: "expired", updated_at: now })
        .where(eq(DesktopAuthTransactionTable.transaction_id, resolvedTransactionId))
      return { ok: false as const, status: 409, error: "transaction_not_ready" as const }
    }

    if (parsed.state && hashState(parsed.state) !== transaction.state_hash) {
      return { ok: false as const, status: 401, error: "invalid_state" as const }
    }

    if (transaction.code_challenge_method !== PKCE_CHALLENGE_METHOD) {
      return { ok: false as const, status: 401, error: "invalid_code_verifier" as const }
    }

    const computedChallenge = createPkceS256Challenge(parsed.codeVerifier)
    if (computedChallenge !== transaction.code_challenge) {
      return { ok: false as const, status: 401, error: "invalid_code_verifier" as const }
    }

    const receivedCodeHash = hashAuthCode(parsed.code)
    if (
      receivedCodeHash !== transaction.authorization_code_hash &&
      receivedCodeHash !== transaction.manual_code_hash
    ) {
      return { ok: false as const, status: 404, error: "transaction_not_found" as const }
    }

    const consumeResult = await tx
      .update(DesktopAuthHandoffTable)
      .set({ consumed_at: now })
      .where(
        and(
          eq(DesktopAuthHandoffTable.id, handoffRecord.id),
          isNull(DesktopAuthHandoffTable.consumed_at),
          gt(DesktopAuthHandoffTable.expires_at, now),
        ),
      )

    if (getAffectedRows(consumeResult) !== 1) {
      return { ok: false as const, status: 410, error: "code_already_consumed" as const }
    }

    const authSessionId = crypto.randomUUID()
    const sessionToken = crypto.randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS)

    await tx.insert(AuthSessionTable).values({
      id: authSessionId,
      userId: handoffRecord.userId,
      token: sessionToken,
      expiresAt,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    })

    const transactionUpdateResult = await tx
      .update(DesktopAuthTransactionTable)
      .set({
        status: "exchanged",
        exchanged_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(DesktopAuthTransactionTable.transaction_id, resolvedTransactionId),
          eq(DesktopAuthTransactionTable.status, "browser_authed"),
        ),
      )

    if (getAffectedRows(transactionUpdateResult) !== 1) {
      return { ok: false as const, status: 409, error: "transaction_not_ready" as const }
    }

    return {
      ok: true as const,
      token: sessionToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      userId: handoffRecord.userId,
      orgId: handoffRecord.orgId,
    }
  })

  if (!exchangeResult.ok) {
    res.status(exchangeResult.status).json({ error: exchangeResult.error })
    return
  }

  const organizations = await resolveMembershipOrganizations({
    user: { id: exchangeResult.userId, email: null, emailVerified: false, name: null },
  })
  const org = organizations.find((candidate) => candidate.id === exchangeResult.orgId)

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
}))
