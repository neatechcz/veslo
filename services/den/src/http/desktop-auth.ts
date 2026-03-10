import crypto from "node:crypto"
import express from "express"
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { AuthSessionTable, DesktopAuthHandoffTable } from "../db/schema.js"
import { requireSession } from "./session.js"
import { resolveMembershipOrganizations, readRequestedOrganizationId, serializeOrganization } from "./org-auth.js"
import { pickActiveOrganization } from "./access.js"
import { createHandoffCode, consumeHandoffCode, type HandoffRecord } from "./desktop-auth-helpers.js"

export { createHandoffCode, consumeHandoffCode, type HandoffRecord } from "./desktop-auth-helpers.js"

export const desktopAuthRouter = express.Router()

desktopAuthRouter.post("/handoff", async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

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

  const rows = await db
    .select()
    .from(DesktopAuthHandoffTable)
    .where(eq(DesktopAuthHandoffTable.code, code))
    .limit(1)

  const row = rows[0]
  if (!row) {
    res.status(404).json({ error: "code_not_found" })
    return
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
    res.status(410).json({ error: result.error })
    return
  }

  await db
    .update(DesktopAuthHandoffTable)
    .set({ consumed_at: result.record.consumedAt })
    .where(eq(DesktopAuthHandoffTable.id, record.id))

  // Create a real Better Auth session so the token works with /v1/me
  const sessionId = crypto.randomUUID()
  const sessionToken = crypto.randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

  await db.insert(AuthSessionTable).values({
    id: sessionId,
    userId: record.userId,
    token: sessionToken,
    expiresAt,
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  })

  const organizations = await resolveMembershipOrganizations({
    user: { id: record.userId, email: null, name: null },
  })

  const org = organizations.find((o) => o.id === record.orgId)

  res.json({
    token: sessionToken,
    user: { id: record.userId },
    org: org
      ? { id: org.id, name: org.name, slug: org.slug, role: org.role }
      : { id: record.orgId },
  })
})
