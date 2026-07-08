import express from "express"

import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"
import { requireSession } from "./session.js"
import { createDbSoulStore } from "../soul/db-store.js"
import {
  InMemorySoulStore,
  SoulStoreError,
  type SoulRouteContext,
  type SoulScope,
  type SoulStore,
} from "../soul/store.js"

export type SoulUserContextResolver = (
  req: express.Request,
  res: express.Response,
) => Promise<SoulRouteContext | null>

export type SoulOrganizationContextResolver = (
  req: express.Request,
  res: express.Response,
) => Promise<SoulRouteContext | null>

export type SoulRouterOptions = {
  store?: SoulStore
  resolveUserContext?: SoulUserContextResolver
  resolveOrganizationContext?: SoulOrganizationContextResolver
}

export function createSoulRouter(options: SoulRouterOptions = {}) {
  const router = express.Router()
  const store = options.store ?? createDbSoulStore()
  const resolveUserContext = options.resolveUserContext ?? defaultResolveUserContext
  const resolveOrganizationContext = options.resolveOrganizationContext ?? defaultResolveOrganizationContext

  router.get("/soul/user", asyncRoute(async (req, res) => {
    const context = await resolveUserContext(req, res)
    if (!context) return

    res.json(await store.getDocument("user", context.userId))
  }))

  router.patch("/soul/user", asyncRoute(async (req, res) => {
    const context = await resolveUserContext(req, res)
    if (!context) return

    const body = parseSoulUpdateBody(req.body)
    const document = await store.updateDocument({
      scope: "user",
      ownerId: context.userId,
      content: body.content,
      changeSummary: body.changeSummary,
      baseVersionId: body.baseVersionId,
      heartbeatEnabled: body.heartbeatEnabled,
      actorUserId: context.userId,
    })
    res.json(document)
  }))

  router.get("/soul/organization", asyncRoute(async (req, res) => {
    const context = await resolveOrganizationContext(req, res)
    if (!context?.orgId) return

    res.json(await store.getDocument("organization", context.orgId))
  }))

  router.patch("/soul/organization", asyncRoute(async (req, res) => {
    const context = await resolveOrganizationContext(req, res)
    if (!context?.orgId) return
    if (!requireOrganizationSoulAdmin(context, res)) return

    const body = parseSoulUpdateBody(req.body)
    const document = await store.updateDocument({
      scope: "organization",
      ownerId: context.orgId,
      content: body.content,
      changeSummary: body.changeSummary,
      baseVersionId: body.baseVersionId,
      heartbeatEnabled: body.heartbeatEnabled,
      actorUserId: context.userId,
    })
    res.json(document)
  }))

  router.get("/soul/:scope/versions", asyncRoute(async (req, res) => {
    const resolved = await resolveScopedContext(req, res, resolveUserContext, resolveOrganizationContext)
    if (!resolved) return

    const limit = parseLimit(req.query.limit)
    const cursor = parseOptionalQueryString(req.query.cursor)
    res.json(await store.listVersions({
      scope: resolved.scope,
      ownerId: resolved.ownerId,
      cursor,
      limit,
    }))
  }))

  router.get("/soul/:scope/versions/:versionId", asyncRoute(async (req, res) => {
    const resolved = await resolveScopedContext(req, res, resolveUserContext, resolveOrganizationContext)
    if (!resolved) return

    const version = await store.getVersion(resolved.scope, resolved.ownerId, req.params.versionId)
    if (!version) {
      res.status(404).json({ error: "soul_not_found" })
      return
    }
    res.json(version)
  }))

  router.post("/soul/:scope/versions/:versionId/restore", asyncRoute(async (req, res) => {
    const resolved = await resolveScopedContext(req, res, resolveUserContext, resolveOrganizationContext)
    if (!resolved) return
    if (resolved.scope === "organization" && !requireOrganizationSoulAdmin(resolved.context, res)) return

    const changeSummary = parseChangeSummaryBody(req.body)
    const document = await store.restoreVersion({
      scope: resolved.scope,
      ownerId: resolved.ownerId,
      versionId: req.params.versionId,
      changeSummary,
      actorUserId: resolved.context.userId,
    })
    res.json(document)
  }))

  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(error instanceof SoulStoreError)) {
      next(error)
      return
    }
    res.status(error.status).json({ error: error.code })
  })

  return router
}

function createInMemorySoulRouter(options: Omit<SoulRouterOptions, "store"> = {}) {
  return createSoulRouter({ ...options, store: new InMemorySoulStore() })
}

async function defaultResolveUserContext(req: express.Request, res: express.Response): Promise<SoulRouteContext | null> {
  const session = await requireSession(req, res)
  if (!session) return null
  return { userId: session.user.id }
}

async function defaultResolveOrganizationContext(
  req: express.Request,
  res: express.Response,
): Promise<SoulRouteContext | null> {
  const context = await requireOrganizationAccess(req, res, { minimumRole: "member" })
  if (!context) return null
  return {
    userId: context.session.user.id,
    orgId: context.organization.id,
    orgRole: context.orgRole,
    isPlatformAdmin: context.isPlatformAdmin,
  }
}

async function resolveScopedContext(
  req: express.Request,
  res: express.Response,
  resolveUserContext: SoulUserContextResolver,
  resolveOrganizationContext: SoulOrganizationContextResolver,
): Promise<{ scope: SoulScope; ownerId: string; context: SoulRouteContext } | null> {
  const scope = parseScope(req.params.scope)
  if (!scope) {
    res.status(400).json({ error: "invalid_soul_scope" })
    return null
  }

  if (scope === "user") {
    const context = await resolveUserContext(req, res)
    return context ? { scope, ownerId: context.userId, context } : null
  }

  const context = await resolveOrganizationContext(req, res)
  if (!context?.orgId) return null
  return { scope, ownerId: context.orgId, context }
}

function requireOrganizationSoulAdmin(context: SoulRouteContext, res: express.Response): boolean {
  if (context.isPlatformAdmin || context.orgRole === "organization_admin" || context.orgRole === "owner") {
    return true
  }
  res.status(403).json({ error: "organization_soul_admin_required" })
  return false
}

function parseScope(value: string): SoulScope | null {
  if (value === "organization" || value === "user") return value
  return null
}

function parseSoulUpdateBody(body: unknown) {
  const record = isRecord(body) ? body : {}
  const content = requireNonEmptyString(record.content, "content")
  const changeSummary = requireNonEmptyString(record.changeSummary, "changeSummary")
  const baseVersionId = parseBaseVersionId(record.baseVersionId)
  const heartbeatEnabled = typeof record.heartbeatEnabled === "boolean" ? record.heartbeatEnabled : undefined

  return { content, changeSummary, baseVersionId, heartbeatEnabled }
}

function parseChangeSummaryBody(body: unknown) {
  const record = isRecord(body) ? body : {}
  return requireNonEmptyString(record.changeSummary, "changeSummary")
}

function parseBaseVersionId(value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value === "string") return value
  throw new SoulStoreError("invalid_request", "baseVersionId must be a string or null")
}

function parseLimit(value: unknown) {
  const raw = parseOptionalQueryString(value)
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SoulStoreError("invalid_request", "limit must be a positive integer")
  }
  return Math.min(parsed, 100)
}

function parseOptionalQueryString(value: unknown) {
  if (Array.isArray(value)) return parseOptionalQueryString(value[0])
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function requireNonEmptyString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SoulStoreError("invalid_request", `${field} is required`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
