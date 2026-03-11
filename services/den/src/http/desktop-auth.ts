import crypto from "node:crypto"
import express from "express"
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm"
import { db } from "../db/index.js"
import { AuthSessionTable, DesktopAuthHandoffTable } from "../db/schema.js"
import { requireSession } from "./session.js"
import { resolveMembershipOrganizations, readRequestedOrganizationId, serializeOrganization } from "./org-auth.js"
import { pickActiveOrganization } from "./access.js"
import { createHandoffCode, consumeHandoffCode, type HandoffRecord } from "./desktop-auth-helpers.js"

export { createHandoffCode, consumeHandoffCode, type HandoffRecord } from "./desktop-auth-helpers.js"

export const desktopAuthRouter = express.Router()
const CONSUMED_HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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

desktopAuthRouter.post("/handoff", async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  await cleanupStaleHandoffs().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth] stale handoff cleanup warning: ${message}`)
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

  const record = createHandoffCode(session.user.id, picked.organization.id)

  await db.insert(DesktopAuthHandoffTable).values({
    id: record.id,
    code: record.code,
    user_id: record.userId,
    org_id: record.orgId,
    expires_at: record.expiresAt,
    consumed_at: null,
    created_at: record.createdAt,
  })

  res.json({ code: record.code })
})

desktopAuthRouter.post("/exchange", async (req, res) => {
  const { code } = req.body ?? {}
  if (typeof code !== "string" || code.length === 0) {
    res.status(400).json({ error: "missing_code" })
    return
  }

  await cleanupStaleHandoffs().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[desktop-auth] stale handoff cleanup warning: ${message}`)
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
    const sessionId = crypto.randomUUID()
    const sessionToken = crypto.randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    await tx.insert(AuthSessionTable).values({
      id: sessionId,
      userId: record.userId,
      token: sessionToken,
      expiresAt,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    })

    return {
      ok: true as const,
      token: sessionToken,
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
    token: exchangeResult.token,
    user: { id: exchangeResult.userId },
    org: org
      ? { id: org.id, name: org.name, slug: org.slug, role: org.role }
      : { id: exchangeResult.orgId },
  })
})
