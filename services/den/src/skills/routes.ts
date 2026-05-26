import express from "express"

import { asyncRoute } from "../http/errors.js"
import {
  isPlatformAdmin,
  readRequestedOrganizationId,
  requireOrganizationAccess,
} from "../http/org-auth.js"
import { requireSession } from "../http/session.js"
import { requireOrgSkillAdmin, requirePlatformSkillAdmin, requireWorkspaceSkillAdmin } from "./approvals.js"
import { normalizeSkillRegistrySearchQuery } from "./search.js"
import {
  InMemorySkillRegistryStore,
  SkillRegistryStoreError,
  type SkillRegistryRouteContext,
  type SkillRegistryStore,
} from "./store.js"

export type SkillRegistryResolveContext = (
  req: express.Request,
  res: express.Response,
) => Promise<SkillRegistryRouteContext | null>

export type SkillRegistryRouterOptions = {
  store?: SkillRegistryStore
  resolveContext?: SkillRegistryResolveContext
}

export function createSkillRegistryRouter(options: SkillRegistryRouterOptions = {}) {
  const router = express.Router()
  const store = options.store ?? new InMemorySkillRegistryStore()
  const resolveContext = options.resolveContext ?? defaultResolveContext

  router.get("/skills", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const result = await store.listSkills(context, req.query)
    res.json(result)
  }))

  router.post("/skills", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    await enforceSkillMutationAccess(context, req.body)
    const skill = await store.createSkill(context, {
      scope: requireScope(req.body?.scope),
      orgId: optionalString(req.body?.orgId) ?? context.orgId ?? null,
      workspaceId: optionalString(req.body?.workspaceId),
      name: requireString(req.body?.name, "name"),
      displayName: optionalString(req.body?.displayName),
      description: optionalString(req.body?.description),
    })
    res.status(201).json({ skill })
  }))

  router.get("/skills/search", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const query = normalizeSkillRegistrySearchQuery(req.query.q ?? req.query.query)
    res.json(await store.searchSkills(context, { ...req.query, query }))
  }))

  router.get("/skill-registry-events", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    res.json(await store.listEvents(context, req.query))
  }))

  router.get("/skills/:skillId", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const skill = await store.getSkill(context, req.params.skillId)
    if (!skill) {
      res.status(404).json({ error: "skill_not_found" })
      return
    }
    res.json({ skill })
  }))

  router.post("/skills/:skillId/versions", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const skill = await store.getSkill(context, req.params.skillId)
    if (!skill) {
      res.status(404).json({ error: "skill_not_found" })
      return
    }
    enforceVisibilityMutationAccess(context, skill.visibility)
    const version = await store.createVersion(context, {
      skillId: req.params.skillId,
      archive: req.body?.package,
    })
    res.status(201).json({ version })
  }))

  router.get("/skills/:skillId/versions", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const result = await store.listVersions(context, req.params.skillId)
    res.json(result)
  }))

  router.get("/skill-versions/:versionId/package", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const result = await store.getPackage(context, req.params.versionId)
    if (!result) {
      res.status(404).json({ error: "version_not_found" })
      return
    }
    res.json(result)
  }))

  router.post("/skill-installations", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const scope = requireScope(req.body?.scope)
    enforceInstallationMutationAccess(
      context,
      scope,
      optionalString(req.body?.orgId) ?? context.orgId ?? null,
      optionalString(req.body?.ownerUserId),
    )
    const installation = await store.createInstallation(context, {
      scope,
      orgId: optionalString(req.body?.orgId) ?? context.orgId ?? null,
      ownerUserId: optionalString(req.body?.ownerUserId),
      workspaceId: optionalString(req.body?.workspaceId),
      skillId: requireString(req.body?.skillId, "skillId"),
      versionId: requireString(req.body?.versionId, "versionId"),
      updatePolicy: optionalUpdatePolicy(req.body?.updatePolicy),
      releaseChannel: optionalString(req.body?.releaseChannel),
    })
    res.status(201).json({ installation })
  }))

  router.patch("/skill-installations/:installationId", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const installation = await store.updateInstallation(context, req.params.installationId, {
      enabled: optionalBoolean(req.body?.enabled),
      versionId: optionalNullableString(req.body?.versionId),
      updatePolicy: optionalUpdatePolicy(req.body?.updatePolicy),
      releaseChannel: optionalNullableString(req.body?.releaseChannel),
    })
    if (!installation) {
      res.status(404).json({ error: "installation_not_found" })
      return
    }
    res.json({ installation })
  }))

  router.delete("/skill-installations/:installationId", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const installation = await store.deleteInstallation(context, req.params.installationId)
    if (!installation) {
      res.status(404).json({ error: "installation_not_found" })
      return
    }
    res.json({ installation })
  }))

  router.post("/skill-installations/:installationId/restore", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const installation = await store.restoreInstallation(context, req.params.installationId, {
      orgId: optionalNullableString(req.body?.orgId),
      ownerUserId: optionalNullableString(req.body?.ownerUserId),
      workspaceId: optionalNullableString(req.body?.workspaceId),
      versionId: optionalNullableString(req.body?.versionId),
    })
    if (!installation) {
      res.status(404).json({ error: "installation_not_found" })
      return
    }
    res.json({ installation })
  }))

  router.get("/workspaces/:workspaceId/skill-set", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const orgId = requireOrganizationContext(context)
    res.json(await store.getWorkspaceSkillSet({ ...context, orgId }, req.params.workspaceId))
  }))

  router.patch("/workspaces/:workspaceId/skill-set", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const orgId = requireString(req.body?.orgId ?? context.orgId, "orgId")
    requireWorkspaceSkillAdmin(context, orgId)
    const skills: unknown[] = Array.isArray(req.body?.skills) ? req.body.skills : []
    const result = await store.replaceWorkspaceSkillSet(context, {
      orgId,
      workspaceId: req.params.workspaceId,
      releaseChannel: optionalString(req.body?.releaseChannel),
      skills: skills.map((entry, index) => {
        const record = requireRecord(entry, `skills[${index}]`)
        return {
          installationId: requireString(record.installationId, `skills[${index}].installationId`),
          desiredVersionId: optionalNullableString(record.desiredVersionId),
          releaseChannel: optionalNullableString(record.releaseChannel),
        }
      }),
    })
    res.json(result)
  }))

  router.post("/skills/:skillId/review-requests", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const scope = requireApprovalScope(req.body?.scope)
    const orgId = optionalString(req.body?.orgId) ?? context.orgId ?? null
    enforceReviewRequestAccess(context, scope, orgId)
    const result = await store.createReviewRequest(context, {
      skillId: req.params.skillId,
      versionId: requireString(req.body?.versionId, "versionId"),
      scope,
      orgId,
      reason: optionalString(req.body?.reason),
      releaseChannel: optionalString(req.body?.releaseChannel),
    })
    res.status(201).json(result)
  }))

  router.post("/skill-review-requests/:requestId/approve", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const result = await store.approveReviewRequest(context, {
      requestId: req.params.requestId,
      reviewerNote: optionalString(req.body?.reviewerNote),
      releaseChannel: optionalString(req.body?.releaseChannel),
    })
    if (!result) {
      res.status(404).json({ error: "review_request_not_found" })
      return
    }
    res.json(result)
  }))

  router.post("/skill-review-requests/:requestId/reject", asyncRoute(async (req, res) => {
    const context = await resolveContext(req, res)
    if (!context) return

    const result = await store.rejectReviewRequest(context, {
      requestId: req.params.requestId,
      reviewerNote: optionalString(req.body?.reviewerNote),
    })
    if (!result) {
      res.status(404).json({ error: "review_request_not_found" })
      return
    }
    res.json(result)
  }))

  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof SkillRegistryStoreError) {
      res.status(error.status).json({ error: error.code })
      return
    }
    next(error)
  })

  return router
}

async function defaultResolveContext(req: express.Request, res: express.Response): Promise<SkillRegistryRouteContext | null> {
  const requestedOrgId = readRequestedOrganizationId(req)
  if (requestedOrgId) {
    const orgContext = await requireOrganizationAccess(req, res, {
      orgId: requestedOrgId,
      minimumRole: "member",
    })
    if (!orgContext) {
      return null
    }
    return {
      userId: orgContext.session.user.id,
      orgId: orgContext.organization.id,
      orgRole: orgContext.orgRole,
      isPlatformAdmin: orgContext.isPlatformAdmin,
    }
  }

  const session = await requireSession(req, res)
  if (!session) {
    return null
  }

  return {
    userId: session.user.id,
    orgId: null,
    orgRole: null,
    isPlatformAdmin: await isPlatformAdmin(session.user.id),
  }
}

async function enforceSkillMutationAccess(context: SkillRegistryRouteContext, body: Record<string, unknown>) {
  const scope = requireScope(body?.scope)
  if (scope === "system") {
    requirePlatformSkillAdmin(context)
    return
  }
  if (scope === "org") {
    requireOrgSkillAdmin(context, optionalString(body?.orgId) ?? context.orgId ?? null)
    return
  }
  if (scope === "workspace") {
    requireWorkspaceSkillAdmin(context, optionalString(body?.orgId) ?? context.orgId ?? null)
  }
}

function enforceVisibilityMutationAccess(context: SkillRegistryRouteContext, visibility: string) {
  if (visibility === "platform") {
    requirePlatformSkillAdmin(context)
    return
  }
  if (visibility === "organization") {
    requireOrgSkillAdmin(context, context.orgId ?? null)
    return
  }
  if (visibility === "workspace") {
    requireWorkspaceSkillAdmin(context, context.orgId ?? null)
  }
}

function enforceInstallationMutationAccess(
  context: SkillRegistryRouteContext,
  scope: string,
  orgId: string | null,
  ownerUserId?: string,
) {
  if (scope === "system") {
    requirePlatformSkillAdmin(context)
    return
  }
  if (scope === "user" && ownerUserId && ownerUserId !== context.userId && !context.isPlatformAdmin) {
    throw new SkillRegistryStoreError(403, "forbidden")
  }
  if (scope === "org") {
    requireOrgSkillAdmin(context, orgId)
    return
  }
  if (scope === "workspace") {
    requireWorkspaceSkillAdmin(context, orgId)
  }
}

function enforceReviewRequestAccess(context: SkillRegistryRouteContext, scope: string, orgId: string | null) {
  if (scope === "org") {
    if (!orgId) throw new SkillRegistryStoreError(400, "org_id_required")
    if (context.isPlatformAdmin) return
    if (context.orgId !== orgId) {
      throw new SkillRegistryStoreError(403, "organization_forbidden")
    }
  }
}

function requireOrganizationContext(context: SkillRegistryRouteContext) {
  if (context.orgId) return context.orgId
  throw new SkillRegistryStoreError(403, "organization_required")
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillRegistryStoreError(400, `${field}_required`)
  }
  return value.trim()
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillRegistryStoreError(400, `${field}_required`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function requireScope(value: unknown) {
  if (value === "user" || value === "org" || value === "workspace" || value === "system") {
    return value
  }
  throw new SkillRegistryStoreError(400, "scope_required")
}

function requireApprovalScope(value: unknown) {
  if (value === "org" || value === "system") {
    return value
  }
  throw new SkillRegistryStoreError(400, "approval_scope_required")
}

function optionalUpdatePolicy(value: unknown) {
  if (
    value === undefined ||
    value === "pinned" ||
    value === "latest_user" ||
    value === "latest_approved" ||
    value === "release_channel"
  ) {
    return value
  }
  throw new SkillRegistryStoreError(400, "update_policy_invalid")
}
