import { randomBytes, randomUUID } from "node:crypto"
import express from "express"
import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/index.js"
import { AuthUserTable, DesktopAuthHandoffTable } from "../db/schema.js"
import { env } from "../env.js"
import { asyncRoute } from "./errors.js"
import { pickActiveOrganization } from "./access.js"
import { findOrganizationById, resolveMembershipOrganizations, serializeOrganization } from "./org-auth.js"
import { requireSession, type SessionContext } from "./session.js"

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

type DesktopAuthOrganizationResolution =
  | {
      ok: true
      organization: DesktopAuthOrganizationSummary
    }
  | {
      ok: false
      status: number
      error: string
      organizations?: ReturnType<typeof serializeOrganization>[]
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

const createHandoffSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
})

const exchangeHandoffSchema = z.object({
  code: z.string().trim().min(1),
})

export type DesktopAuthSessionContext = SessionContext & {
  sessionToken: string | null
}

export type DesktopAuthHandlers = ReturnType<typeof createDesktopAuthHandlers>

export function createDesktopAuthHandlers(input: {
  apiBaseUrl: string
  now?: () => Date
  createId?: () => string
  createCode?: () => string
  getSessionContext: (req: express.Request, res: express.Response) => Promise<DesktopAuthSessionContext | null>
  resolveOrganization: (
    session: DesktopAuthSessionContext,
    requestedOrgId: string | null,
  ) => Promise<DesktopAuthOrganizationResolution>
  insertHandoff: (record: DesktopAuthHandoffRecord) => Promise<void>
  findHandoffByCode: (code: string) => Promise<DesktopAuthHandoffRecord | null>
  markHandoffConsumed: (id: string, consumedAt: Date) => Promise<boolean>
  loadUserSummary: (userId: string) => Promise<DesktopAuthUserSummary | null>
  loadOrganizationSummary: (orgId: string) => Promise<DesktopAuthOrganizationSummary | null>
}) {
  const now = input.now ?? (() => new Date())
  const createId = input.createId ?? randomUUID
  const createCode = input.createCode ?? createDesktopAuthCode

  const createHandoff = async (req: express.Request, res: express.Response) => {
    const parsed = createHandoffSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
      return
    }

    const session = await input.getSessionContext(req, res)
    if (!session) {
      return
    }

    if (!session.sessionToken) {
      res.status(500).json({ error: "session_token_unavailable" })
      return
    }

    const requestedOrgId = parsed.data.orgId?.trim() || null
    const resolution = await input.resolveOrganization(session, requestedOrgId)
    if (!resolution.ok) {
      res.status(resolution.status).json({
        error: resolution.error,
        ...(resolution.organizations ? { organizations: resolution.organizations } : {}),
      })
      return
    }

    const record = buildDesktopAuthHandoffRecord({
      userId: session.user.id,
      orgId: resolution.organization.id,
      sessionToken: session.sessionToken,
      now: now(),
      createId,
      createCode,
    })

    await input.insertHandoff(record)
    res.status(201).json({
      code: record.code,
      expiresAt: record.expires_at.toISOString(),
      organization: resolution.organization,
    })
  }

  const exchange = async (req: express.Request, res: express.Response) => {
    const parsed = exchangeHandoffSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
      return
    }

    const record = await input.findHandoffByCode(parsed.data.code)
    if (!record) {
      res.status(404).json({ error: "desktop_auth_code_not_found" })
      return
    }

    const status = resolveDesktopAuthHandoffStatus(record, now())
    if (!status.ok) {
      if (status.error === "expired") {
        res.status(410).json({ error: "desktop_auth_code_expired" })
        return
      }

      res.status(409).json({ error: "desktop_auth_code_consumed" })
      return
    }

    const [user, organization] = await Promise.all([
      input.loadUserSummary(record.user_id),
      input.loadOrganizationSummary(record.org_id),
    ])

    if (!user || !organization) {
      res.status(404).json({ error: "desktop_auth_context_not_found" })
      return
    }

    const consumedAt = now()
    const consumed = await input.markHandoffConsumed(record.id, consumedAt)
    if (!consumed) {
      res.status(409).json({ error: "desktop_auth_code_consumed" })
      return
    }

    res.json(buildDesktopAuthExchangePayload({
      apiBaseUrl: input.apiBaseUrl,
      token: record.session_token,
      user,
      organization,
    }))
  }

  return {
    createHandoff,
    exchange,
  }
}

async function resolveDesktopAuthOrganization(
  session: DesktopAuthSessionContext,
  requestedOrgId: string | null,
): Promise<DesktopAuthOrganizationResolution> {
  const organizations = await resolveMembershipOrganizations(session)
  const picked = pickActiveOrganization(organizations, requestedOrgId)

  if (!picked.ok) {
    return {
      ok: false,
      status: picked.status,
      error: picked.error,
      organizations: organizations.map((entry) => serializeOrganization(entry)),
    }
  }

  return {
    ok: true,
    organization: {
      id: picked.organization.id,
      name: picked.organization.name,
      slug: picked.organization.slug,
      ownerUserId: picked.organization.ownerUserId,
    },
  }
}

async function findDesktopAuthHandoffByCode(code: string) {
  const rows = await db
    .select()
    .from(DesktopAuthHandoffTable)
    .where(eq(DesktopAuthHandoffTable.code, code))
    .limit(1)

  return rows[0] ?? null
}

async function markDesktopAuthHandoffConsumed(id: string, consumedAt: Date) {
  const result = await db
    .update(DesktopAuthHandoffTable)
    .set({ consumed_at: consumedAt })
    .where(and(eq(DesktopAuthHandoffTable.id, id), isNull(DesktopAuthHandoffTable.consumed_at)))

  const rowsAffected = Number(
    (result as { rowsAffected?: number } | undefined)?.rowsAffected ??
      (((result as unknown as unknown[] | undefined)?.[0]) as { affectedRows?: number } | undefined)?.affectedRows ??
      0,
  )

  if (rowsAffected > 0) {
    return true
  }

  const fresh = await db
    .select({
      consumed_at: DesktopAuthHandoffTable.consumed_at,
    })
    .from(DesktopAuthHandoffTable)
    .where(eq(DesktopAuthHandoffTable.id, id))
    .limit(1)

  return Boolean(fresh[0]?.consumed_at)
}

async function loadDesktopAuthUserSummary(userId: string) {
  const rows = await db
    .select({
      id: AuthUserTable.id,
      email: AuthUserTable.email,
      name: AuthUserTable.name,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  if (!rows[0]) {
    return null
  }

  return {
    id: rows[0].id,
    email: rows[0].email,
    name: rows[0].name ?? null,
  }
}

async function loadDesktopAuthOrganizationSummary(orgId: string) {
  const organization = await findOrganizationById(orgId)
  if (!organization) {
    return null
  }

  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    ownerUserId: organization.ownerUserId,
  }
}

const productionHandlers = createDesktopAuthHandlers({
  apiBaseUrl: env.betterAuthUrl,
  getSessionContext: requireSession,
  resolveOrganization: resolveDesktopAuthOrganization,
  insertHandoff: async (record) => {
    await db.insert(DesktopAuthHandoffTable).values(record)
  },
  findHandoffByCode: findDesktopAuthHandoffByCode,
  markHandoffConsumed: markDesktopAuthHandoffConsumed,
  loadUserSummary: loadDesktopAuthUserSummary,
  loadOrganizationSummary: loadDesktopAuthOrganizationSummary,
})

export const desktopAuthRouter = express.Router()

desktopAuthRouter.post("/handoff", asyncRoute(productionHandlers.createHandoff))
desktopAuthRouter.post("/exchange", asyncRoute(productionHandlers.exchange))
