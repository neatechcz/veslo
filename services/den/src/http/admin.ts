import express from "express"
import { OrgRole } from "../db/schema.js"
import type { DebugLogDetail, DebugLogListEntry } from "../debug-logs/types.js"
import type { ManagedAiProvider } from "../managed-ai/providers/ids.js"
import type { CodexUsageStatus } from "../managed-ai/usage/codex-status.js"

export type AdminSessionOrganization = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  role: (typeof OrgRole)[number]
}

export type AdminSessionSnapshot = {
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    name: string | null
  }
  platformAdmin: boolean
  activeOrgId: string | null
  organizations: AdminSessionOrganization[]
}

export type AdminUserMembership = {
  membershipId: string
  orgId: string
  orgName: string
  orgSlug: string
  role: (typeof OrgRole)[number]
}

export type AdminUserRecord = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  platformAdmin: boolean
  disabled?: boolean
  memberships: AdminUserMembership[]
}

export type AdminUserAiAccessRecord = {
  id: string
  userId: string
  enabled: boolean
  provider: ManagedAiProvider | null
  credentialId: string | null
  defaultModel: string | null
  allowedModels: string[]
  updatedAt: string
}

export type AdminCredentialOption = {
  id: string
  name: string
  provider: ManagedAiProvider
}

export type AdminCredentialRecord = {
  id: string
  name: string
  provider: string
  type: "api_key" | "oauth"
  state: "healthy" | "degraded" | "draining" | "unhealthy" | "revoked"
  scope: string
  activeLeases: number
  alertCount: number
  lastRefreshAt: string
  lastFailureAt: string | null
  cachedTokens: number
  totalTokens: number
  nextRotationAt: string | null
  linkedAlertIds: string[]
}

export type AdminSessionRecord = {
  id: string
  sessionId: string
  provider: ManagedAiProvider
  userLabel: string
  orgLabel: string
  projectLabel: string
  workerLabel: string
  credentialId: string
  state: "healthy" | "degraded" | "rebound"
  retries: number
  lastSeenAt: string
  lastFailoverAt: string | null
}

export type AdminUsageLabel = {
  id: string
  label: string
}

export type AdminUsageSeries = {
  key: string
  label: string
  totalTokens: number
  totalRequests: number
}

export type AdminCredentialEligibility = {
  state: "eligible" | "exhausted" | "unavailable" | "unhealthy" | "draining" | "revoked"
  reason: string | null
  resetAt: string | null
}

export type AdminCredentialUsageRecord = AdminUsageLabel & {
  name: string
  provider: string | null
  state: AdminCredentialRecord["state"] | null
  activeLeases: number
  cachedTokens: number
  totalTokens: number
  totalRequests: number
  lastUsedAt: string | null
  upstreamStatus: CodexUsageStatus | null
  eligibility?: AdminCredentialEligibility
}

export type AdminUsageResponse = {
  summary: {
    totalTokens: number
    totalRequests: number
  }
  groupBy: "total" | "credential" | "user" | "org"
  filters: {
    credentials: AdminUsageLabel[]
    users: AdminUsageLabel[]
    orgs: AdminUsageLabel[]
  }
  series: AdminUsageSeries[]
  topCredentials: Array<AdminUsageLabel & { totalTokens: number }>
  topUsers: Array<AdminUsageLabel & { totalTokens: number }>
  topOrgs: Array<AdminUsageLabel & { totalTokens: number }>
  credentialUsage: AdminCredentialUsageRecord[]
}

export type AdminAlertRecord = {
  id: string
  title: string
  severity: "critical" | "high" | "medium"
  source: string
  status: "active" | "acknowledged" | "resolved"
  credentialId: string | null
  affectedSessions: number
  firstSeenAt: string
  lastSeenAt: string
  owner: string | null
  runbook: string
}

export type AdminAuditRecord = {
  id: string
  timestamp: string
  actor: string
  action: string
  entityType: string
  entityId: string
  result: "ok" | "warning" | "error"
  summary: string
  changedFields: string[]
}

export type AdminRouteDeps = {
  getSessionSnapshot: (req: express.Request, res: express.Response) => Promise<AdminSessionSnapshot | null>
  listUsers?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord[] | null>
  createUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  updateUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  getUserAiAccess?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ aiAccess: AdminUserAiAccessRecord | null; availableCredentials?: AdminCredentialOption[] } | null>
  upsertUserAiAccess?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ aiAccess: AdminUserAiAccessRecord; availableCredentials?: AdminCredentialOption[] } | null>
  disableUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  enableUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  deleteUser?: (req: express.Request, res: express.Response) => Promise<{ ok: true } | null>
  listCredentials?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ credentials: AdminCredentialRecord[] } | null>
  createCredential?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ credential: AdminCredentialRecord } | null>
  revokeCredential?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ credential: AdminCredentialRecord } | null>
  drainCredential?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ credential: AdminCredentialRecord } | null>
  rotateCredential?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ credential: AdminCredentialRecord } | null>
  listSessions?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ sessions: AdminSessionRecord[] } | null>
  getUsage?: (req: express.Request, res: express.Response) => Promise<AdminUsageResponse | null>
  listAlerts?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ alerts: AdminAlertRecord[] } | null>
  acknowledgeAlert?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ alert: AdminAlertRecord } | null>
  resolveAlert?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ alert: AdminAlertRecord } | null>
  listAudit?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ events: AdminAuditRecord[] } | null>
  listDebugLogs?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ events: DebugLogListEntry[] } | null>
  getDebugLog?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ event: DebugLogDetail } | null>
  exportDebugLogs?: (
    req: express.Request,
    res: express.Response,
  ) => Promise<{ filename: string; body: string } | null>
}

export function serializeAdminSessionSnapshot(input: AdminSessionSnapshot) {
  return {
    user: input.user,
    platformAdmin: input.platformAdmin,
    activeOrgId: input.activeOrgId,
    organizations: input.organizations,
  }
}

export function serializeAdminUser(input: AdminUserRecord) {
  return {
    id: input.id,
    name: input.name,
    email: input.email,
    emailVerified: input.emailVerified,
    platformAdmin: input.platformAdmin,
    disabled: input.disabled === true,
    memberships: input.memberships,
  }
}

export function createAdminRouter(deps: AdminRouteDeps) {
  const router = express.Router()

  router.get("/session", async (req, res) => {
    const snapshot = await deps.getSessionSnapshot(req, res)
    if (!snapshot) {
      return
    }

    res.json(serializeAdminSessionSnapshot(snapshot))
  })

  router.get("/users", async (req, res) => {
    if (!deps.listUsers) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const users = await deps.listUsers(req, res)
    if (!users) {
      return
    }

    res.json({
      users: users.map((entry) => serializeAdminUser(entry)),
    })
  })

  router.post("/users", async (req, res) => {
    if (!deps.createUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const created = await deps.createUser(req, res)
    if (!created) {
      return
    }

    res.status(201).json({
      user: serializeAdminUser(created),
    })
  })

  router.patch("/users/:userId", async (req, res) => {
    if (!deps.updateUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.updateUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.get("/users/:userId/ai-access", async (req, res) => {
    if (!deps.getUserAiAccess) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.getUserAiAccess(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.put("/users/:userId/ai-access", async (req, res) => {
    if (!deps.upsertUserAiAccess) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.upsertUserAiAccess(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/users/:userId/disable", async (req, res) => {
    if (!deps.disableUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.disableUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.post("/users/:userId/enable", async (req, res) => {
    if (!deps.enableUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.enableUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.delete("/users/:userId", async (req, res) => {
    if (!deps.deleteUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const deleted = await deps.deleteUser(req, res)
    if (!deleted) {
      return
    }

    res.status(204).end()
  })

  router.get("/credentials", async (req, res) => {
    if (!deps.listCredentials) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.listCredentials(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/credentials", async (req, res) => {
    if (!deps.createCredential) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.createCredential(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/credentials/:credentialId/revoke", async (req, res) => {
    if (!deps.revokeCredential) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.revokeCredential(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/credentials/:credentialId/drain", async (req, res) => {
    if (!deps.drainCredential) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.drainCredential(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/credentials/:credentialId/rotate", async (req, res) => {
    if (!deps.rotateCredential) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.rotateCredential(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/sessions", async (req, res) => {
    if (!deps.listSessions) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.listSessions(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/usage", async (req, res) => {
    if (!deps.getUsage) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.getUsage(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/alerts", async (req, res) => {
    if (!deps.listAlerts) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.listAlerts(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/alerts/:alertId/acknowledge", async (req, res) => {
    if (!deps.acknowledgeAlert) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.acknowledgeAlert(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.post("/alerts/:alertId/resolve", async (req, res) => {
    if (!deps.resolveAlert) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.resolveAlert(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/audit", async (req, res) => {
    if (!deps.listAudit) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.listAudit(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/debug-logs", async (req, res) => {
    if (!deps.listDebugLogs) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.listDebugLogs(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  router.get("/debug-logs/export", async (req, res) => {
    if (!deps.exportDebugLogs) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.exportDebugLogs(req, res)
    if (!payload) {
      return
    }

    res
      .status(200)
      .setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`)
      .send(payload.body)
  })

  router.get("/debug-logs/:eventId", async (req, res) => {
    if (!deps.getDebugLog) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const payload = await deps.getDebugLog(req, res)
    if (!payload) {
      return
    }

    res.json(payload)
  })

  return router
}
