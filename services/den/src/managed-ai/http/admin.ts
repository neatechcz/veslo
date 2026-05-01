import crypto from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"

import type {
  AdminAlertRecord,
  AdminAuditRecord,
  AdminCredentialEligibility,
  AdminCredentialOption,
  AdminCredentialRecord,
  AdminRouteDeps,
  AdminSessionRecord,
  AdminSessionSnapshot,
  AdminUsageResponse,
  AdminUserAiAccessRecord,
} from "../../http/admin.js"
import type { AiAccessProvider, AiAccessRepository, UpsertUserAiAccessPolicyInput, UserAiAccessPolicyRecord } from "../access/repository.js"
import type { AlertRecord, AlertRepository } from "../alerts/repository.js"
import type { AuditRepository } from "../audit/repository.js"
import type { OpenAiOAuthClient } from "../credentials/openai-oauth.js"
import { getPlatformCredentialOwnerUserId } from "../credentials/platform-owner.js"
import type { CredentialRepository, CredentialRecord } from "../credentials/repository.js"
import type { SecretStore, StoredSecret } from "../credentials/secret-store.js"
import type { LeaseProvider, LeaseRepository } from "../leases/repository.js"
import {
  formatManagedAiProviderLabel,
  isManagedAiProvider,
} from "../providers/ids.js"
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js"
import {
  CachedCodexCredentialStatusProvider,
  type CodexCredentialStatusProvider,
  type CodexUsageStatus,
} from "../usage/codex-status.js"
import type { UsageAggregateResponse, UsageCredentialAggregate, UsageRepository } from "../usage/repository.js"

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

type CreateCredentialInput = {
  provider: LeaseProvider | null
  name?: string | null
  secret: string
}

type UpdateUserAiAccessInput = {
  enabled: boolean
  provider: AiAccessProvider | null
  credentialId: string | null
  defaultModel: string | null
  allowedModels: string[]
}

type ManagedAiAdminRouteOptions = {
  getAdminSession: (req: express.Request, res: express.Response) => Promise<AdminSessionSnapshot | null>
  aiAccess: AiAccessRepository
  alerts: AlertRepository
  audit: AuditRepository
  credentials: CredentialRepository
  leases: LeaseRepository
  secrets: SecretStore
  usage: UsageRepository
  codexStatusProvider?: CodexCredentialStatusProvider | null
  now?: () => Date
}

type ManagedAiAdminUiOptions = {
  getAdminSession: (req: express.Request, res: express.Response) => Promise<AdminSessionSnapshot | null>
  openAiOAuth: OpenAiOAuthClient
  alerts: AlertRepository
  audit: AuditRepository
  credentials: CredentialRepository
  secrets: SecretStore
}

type DecoratedAdminCredentialRecord = AdminCredentialRecord & {
  cachedTokens?: number
  upstreamStatus?: CodexUsageStatus | null
  eligibility?: AdminCredentialEligibility
}

type AdminUsageFilters = {
  credentialId: string | null
  userId: string | null
  orgId: string | null
}

export function createManagedAiAdminRouteDeps(
  deps: ManagedAiAdminRouteOptions,
): Pick<
  AdminRouteDeps,
  | "getUserAiAccess"
  | "upsertUserAiAccess"
  | "listCredentials"
  | "createCredential"
  | "revokeCredential"
  | "drainCredential"
  | "rotateCredential"
  | "listSessions"
  | "getUsage"
  | "listAlerts"
  | "acknowledgeAlert"
  | "resolveAlert"
  | "listAudit"
> {
  const now = deps.now ?? (() => new Date())
  const codexStatusProvider =
    deps.codexStatusProvider === null
      ? null
      : deps.codexStatusProvider ?? createDefaultCodexStatusProvider(deps.credentials, deps.secrets)

  async function recordAuditEvent(input: {
    actorUserId?: string | null
    entityType: string
    entityId: string
    action: string
    result: "ok" | "warning" | "error"
    summary: string
  }) {
    try {
      await deps.audit.recordEvent({
        actorUserId: input.actorUserId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        result: input.result,
        summary: input.summary,
      })
    } catch (error) {
      console.error("managed ai admin audit event failed", {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        error,
      })
    }
  }

  async function listCredentialsWithAlerts(): Promise<DecoratedAdminCredentialRecord[]> {
    const listAdminCredentials = deps.credentials.listAdminCredentials
    if (!listAdminCredentials) {
      throw new HttpError("credential_read_model_unavailable", 503)
    }

    const [credentials, alerts] = await Promise.all([
      listAdminCredentials.call(deps.credentials),
      deps.alerts.listAlerts(),
    ])

    const unresolvedAlertsByCredentialId = new Map<string, AlertRecord[]>()
    for (const alert of alerts) {
      if (!alert.credentialId || alert.status === "resolved") {
        continue
      }

      const existing = unresolvedAlertsByCredentialId.get(alert.credentialId) ?? []
      existing.push(alert)
      unresolvedAlertsByCredentialId.set(alert.credentialId, existing)
    }

    const withAlerts = credentials.map((credential) => {
      const linkedAlerts = unresolvedAlertsByCredentialId.get(credential.id) ?? []
      return {
        ...credential,
        alertCount: linkedAlerts.length,
        linkedAlertIds: linkedAlerts.map((alert) => alert.id),
      }
    })

    return withCodexUpstreamStatus(withAlerts)
  }

  async function withCodexUpstreamStatus(
    credentials: AdminCredentialRecord[],
  ): Promise<DecoratedAdminCredentialRecord[]> {
    return Promise.all(
      credentials.map(async (credential) => {
        if (credential.provider !== "codex_oauth") {
          return credential
        }

        const upstreamStatus = codexStatusProvider
          ? await codexStatusProvider.getStatus({
              credentialId: credential.id,
              credentialName: credential.name,
            })
          : null

        return {
          ...credential,
          cachedTokens: readCachedTokens(credential),
          upstreamStatus,
          eligibility: readCodexCredentialEligibility(credential, upstreamStatus, now()),
        }
      }),
    )
  }

  async function withCredentialUsage(usage: UsageAggregateResponse, filters: AdminUsageFilters): Promise<AdminUsageResponse> {
    const credentials = await listCredentialsWithAlerts()
    const historicalUsage = readCredentialUsage(usage)
    const historicalByCredentialId = new Map(historicalUsage.map((entry) => [entry.id, entry]))
    const credentialLabels = new Map(credentials.map((credential) => [credential.id, credential.name]))
    const usageCredentials = selectCredentialUsageCredentials(credentials, historicalByCredentialId, filters)
    const credentialUsage =
      usageCredentials.length > 0
        ? usageCredentials.map((credential) => {
            const historical = historicalByCredentialId.get(credential.id)
            return {
              id: credential.id,
              label: credential.name,
              name: credential.name,
              provider: credential.provider,
              state: credential.state,
              activeLeases: credential.activeLeases,
              cachedTokens: historical ? readCachedTokens(historical) : 0,
              totalTokens: historical?.totalTokens ?? 0,
              totalRequests: historical?.totalRequests ?? 0,
              lastUsedAt: readLastUsedAt(historical),
              upstreamStatus: credential.provider === "codex_oauth" ? credential.upstreamStatus ?? null : null,
              eligibility: credential.provider === "codex_oauth" ? credential.eligibility : undefined,
            }
          })
        : credentials.length === 0 ? historicalUsage.map((entry) => ({
            id: entry.id,
            label: entry.label,
            name: entry.label,
            provider: null,
            state: null,
            activeLeases: 0,
            cachedTokens: readCachedTokens(entry),
            totalTokens: entry.totalTokens,
            totalRequests: entry.totalRequests,
            lastUsedAt: readLastUsedAt(entry),
            upstreamStatus: null,
          })) : []

    return {
      ...usage,
      filters: {
        ...usage.filters,
        credentials: mergeCredentialFilters(credentials, usage.filters.credentials),
      },
      series:
        usage.groupBy === "credential"
          ? usage.series.map((entry) => ({
              ...entry,
              label: credentialLabels.get(entry.key) ?? entry.label,
            }))
          : usage.series,
      topCredentials: usage.topCredentials.map((entry) => ({
        ...entry,
        label: credentialLabels.get(entry.id) ?? entry.label,
      })),
      credentialUsage,
    }
  }

  async function listEligibleCodexCredentials(): Promise<AdminCredentialOption[] | undefined> {
    const listAdminCredentials = deps.credentials.listAdminCredentials
    if (!listAdminCredentials) {
      return undefined
    }

    const credentials = await listAdminCredentials.call(deps.credentials)
    const candidates = credentials.filter((entry) => entry.provider === "codex_oauth" && entry.state === "healthy")
    if (!codexStatusProvider) {
      return []
    }

    const eligible: AdminCredentialOption[] = []
    for (const credential of candidates) {
      const status = await codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      })
      if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
        continue
      }
      eligible.push({
        id: credential.id,
        name: credential.name,
      })
    }

    return eligible
  }

  async function listAvailableCodexCredentials(): Promise<AdminCredentialOption[] | undefined> {
    return listEligibleCodexCredentials()
  }

  async function assertEligibleCodexCredential(credentialId: string): Promise<void> {
    const credentials = await listEligibleCodexCredentials()
    if (credentials && !credentials.some((entry) => entry.id === credentialId)) {
      throw new HttpError("ineligible_ai_access_credential_id", 400)
    }
  }

  async function getCredentialOrThrow(credentialId: string) {
    const credential = (await listCredentialsWithAlerts()).find((entry) => entry.id === credentialId)
    if (!credential) {
      throw new HttpError("credential_not_found", 404)
    }
    return credential
  }

  async function requireAdminSession(req: express.Request, res: express.Response) {
    return deps.getAdminSession(req, res)
  }

  return {
    async getUserAiAccess(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const userId = readParam(req.params.userId)
      if (!userId) {
        res.status(400).json({ error: "invalid_user_id" })
        return null
      }

      try {
        return {
          aiAccess: toAdminUserAiAccessRecord(await deps.aiAccess.getUserAiAccess(userId)),
          availableCredentials: await listAvailableCodexCredentials(),
        }
      } catch (error) {
        return handleRouteError(res, error, "ai_access_lookup_failed")
      }
    },

    async upsertUserAiAccess(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const userId = readParam(req.params.userId)
      if (!userId) {
        res.status(400).json({ error: "invalid_user_id" })
        return null
      }

      try {
        const validated = validateUserAiAccessInput({
          ...(req.body ?? {}),
          userId,
        })
        if (validated.enabled && validated.provider === "codex_oauth" && validated.credentialId) {
          await assertEligibleCodexCredential(validated.credentialId)
        }

        const saved = await deps.aiAccess.upsertUserAiAccess(validated)
        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "user.ai_access.update",
          entityType: "user",
          entityId: userId,
          result: "ok",
          summary: `Updated AI access for user ${userId}.`,
        })
        return {
          aiAccess: toAdminUserAiAccessRecord(saved)!,
          availableCredentials: await listAvailableCodexCredentials(),
        }
      } catch (error) {
        return handleRouteError(res, error, "ai_access_update_failed")
      }
    },

    async listCredentials(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        return { credentials: await listCredentialsWithAlerts() }
      } catch (error) {
        return handleRouteError(res, error, "credential_list_failed")
      }
    },

    async createCredential(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        const validated = validateCreateCredentialInput(req.body ?? {})
        const createPlatformCredential = deps.credentials.createPlatformCredential
        if (!createPlatformCredential) {
          throw new HttpError("credential_write_unavailable", 503)
        }

        const stored = await deps.secrets.put(validated.storedSecret)
        const created = await createPlatformCredential.call(deps.credentials, {
          ownerUserId: getPlatformCredentialOwnerUserId(validated.provider),
          name: validated.name,
          provider: validated.provider,
          credentialType: validated.credentialType,
          secretRef: stored.secretRef,
        })

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.create",
          entityType: "credential",
          entityId: created.id,
          result: "ok",
          summary: `Created ${validated.provider} credential ${created.id}.`,
        })

        return {
          credential: await getCredentialOrThrow(created.id),
        }
      } catch (error) {
        return handleRouteError(res, error, "credential_create_failed")
      }
    },

    async revokeCredential(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const credentialId = readParam(req.params.credentialId)
      if (!credentialId) {
        res.status(400).json({ error: "invalid_credential_id" })
        return null
      }

      try {
        const action = deps.credentials.revokeCredential
        if (!action) {
          throw new HttpError("credential_actions_unavailable", 503)
        }

        const updated = await action.call(deps.credentials, credentialId)
        if (!updated) {
          throw new HttpError("credential_not_found", 404)
        }

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.revoke",
          entityType: "credential",
          entityId: credentialId,
          result: "warning",
          summary: `Revoked credential ${credentialId}.`,
        })
        return {
          credential: await getCredentialOrThrow(credentialId),
        }
      } catch (error) {
        return handleRouteError(res, error, "credential_revoke_failed")
      }
    },

    async drainCredential(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const credentialId = readParam(req.params.credentialId)
      if (!credentialId) {
        res.status(400).json({ error: "invalid_credential_id" })
        return null
      }

      try {
        const action = deps.credentials.drainCredential
        if (!action) {
          throw new HttpError("credential_actions_unavailable", 503)
        }

        const updated = await action.call(deps.credentials, credentialId)
        if (!updated) {
          throw new HttpError("credential_not_found", 404)
        }

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.drain",
          entityType: "credential",
          entityId: credentialId,
          result: "warning",
          summary: `Draining credential ${credentialId} for new assignments.`,
        })
        return {
          credential: await getCredentialOrThrow(credentialId),
        }
      } catch (error) {
        return handleRouteError(res, error, "credential_drain_failed")
      }
    },

    async rotateCredential(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const credentialId = readParam(req.params.credentialId)
      if (!credentialId) {
        res.status(400).json({ error: "invalid_credential_id" })
        return null
      }

      try {
        const action = deps.credentials.rotateCredential
        if (!action) {
          throw new HttpError("credential_actions_unavailable", 503)
        }

        const updated = await action.call(deps.credentials, credentialId)
        if (!updated) {
          throw new HttpError("credential_not_found", 404)
        }

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.rotate",
          entityType: "credential",
          entityId: credentialId,
          result: "ok",
          summary: `Rotated active sessions off credential ${credentialId}.`,
        })
        return {
          credential: await getCredentialOrThrow(credentialId),
        }
      } catch (error) {
        return handleRouteError(res, error, "credential_rotate_failed")
      }
    },

    async listSessions(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        const listAdminSessions = deps.leases.listAdminSessions
        if (!listAdminSessions) {
          throw new HttpError("session_read_model_unavailable", 503)
        }
        return {
          sessions: await listAdminSessions.call(deps.leases),
        }
      } catch (error) {
        return handleRouteError(res, error, "session_list_failed")
      }
    },

    async getUsage(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        const aggregateUsage = deps.usage.aggregateUsage
        if (!aggregateUsage) {
          throw new HttpError("usage_read_model_unavailable", 503)
        }

        const filters = {
          credentialId: readQueryString(req.query.credentialId),
          userId: readQueryString(req.query.userId),
          orgId: readQueryString(req.query.orgId),
        }
        const usage = await aggregateUsage.call(deps.usage, {
          groupBy: normalizeGroupBy(req.query.groupBy),
          ...filters,
        })
        return withCredentialUsage(usage, filters)
      } catch (error) {
        return handleRouteError(res, error, "usage_lookup_failed")
      }
    },

    async listAlerts(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        return {
          alerts: (await deps.alerts.listAlerts()) as AdminAlertRecord[],
        }
      } catch (error) {
        return handleRouteError(res, error, "alert_list_failed")
      }
    },

    async acknowledgeAlert(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const alertId = readParam(req.params.alertId)
      if (!alertId) {
        res.status(400).json({ error: "invalid_alert_id" })
        return null
      }

      try {
        const acknowledge = deps.alerts.acknowledgeAlert
        if (!acknowledge) {
          throw new HttpError("alert_actions_unavailable", 503)
        }

        const alert = await acknowledge.call(deps.alerts, {
          alertId,
          actorUserId: getAdminActorUserId(session),
        })
        if (!alert) {
          throw new HttpError("alert_not_found", 404)
        }
        return { alert: alert as AdminAlertRecord }
      } catch (error) {
        return handleRouteError(res, error, "alert_acknowledge_failed")
      }
    },

    async resolveAlert(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      const alertId = readParam(req.params.alertId)
      if (!alertId) {
        res.status(400).json({ error: "invalid_alert_id" })
        return null
      }

      try {
        const resolve = deps.alerts.resolveAlert
        if (!resolve) {
          throw new HttpError("alert_actions_unavailable", 503)
        }

        const alert = await resolve.call(deps.alerts, {
          alertId,
          actorUserId: getAdminActorUserId(session),
        })
        if (!alert) {
          throw new HttpError("alert_not_found", 404)
        }
        return { alert: alert as AdminAlertRecord }
      } catch (error) {
        return handleRouteError(res, error, "alert_resolve_failed")
      }
    },

    async listAudit(req, res) {
      const session = await requireAdminSession(req, res)
      if (!session) {
        return null
      }

      try {
        const listEvents = deps.audit.listEvents
        if (!listEvents) {
          throw new HttpError("audit_read_model_unavailable", 503)
        }
        return {
          events: (await listEvents.call(deps.audit, { limit: 100 })) as AdminAuditRecord[],
        }
      } catch (error) {
        return handleRouteError(res, error, "audit_list_failed")
      }
    },
  }
}

export function createManagedAiAdminUiRouter(deps: ManagedAiAdminUiOptions) {
  const router = express.Router()
  const currentFile = fileURLToPath(import.meta.url)
  const publicDir = path.resolve(path.dirname(currentFile), "../../../public-admin")
  const indexPath = path.join(publicDir, "index.html")

  router.post("/admin/api/credentials/openai/oauth/start", async (req, res) => {
    const session = await deps.getAdminSession(req, res)
    if (!session) {
      return
    }

    try {
      const state = createSignedOpenAiState(getAdminActorUserId(session))
      const payload = await deps.openAiOAuth.startAuthorization({ state })
      res.json({
        authorizeUrl: payload.authorizeUrl,
        state,
      })
    } catch (error) {
      handleRouteError(res, error, "openai_oauth_start_failed")
    }
  })

  router.post("/admin/api/credentials/openai/oauth/exchange", async (req, res) => {
    const session = await deps.getAdminSession(req, res)
    if (!session) {
      return
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : ""
    const state = typeof req.body?.state === "string" ? req.body.state.trim() : ""
    if (!code || !state) {
      res.status(400).json({ error: "invalid_openai_oauth_exchange" })
      return
    }

    try {
      const verifiedActor = verifySignedOpenAiState(state)
      const actorUserId = getAdminActorUserId(session)
      if (!verifiedActor || verifiedActor !== actorUserId) {
        throw new HttpError("invalid_openai_oauth_state", 400)
      }

      const tokens = await deps.openAiOAuth.exchangeCode({ code })
      const createPlatformCredential = deps.credentials.createPlatformCredential
      const listAdminCredentials = deps.credentials.listAdminCredentials
      if (!createPlatformCredential || !listAdminCredentials) {
        throw new HttpError("credential_write_unavailable", 503)
      }

      const stored = await deps.secrets.put({
        kind: "openai_oauth",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })
      const created = await createPlatformCredential.call(deps.credentials, {
        ownerUserId: getPlatformCredentialOwnerUserId("openai"),
        name: "Shared OpenAI OAuth",
        provider: "openai",
        credentialType: "oauth",
        secretRef: stored.secretRef,
      })

      await recordAuditEventBestEffort(deps.audit, {
        actorUserId,
        action: "credential.openai_oauth.connect",
        entityType: "credential",
        entityId: created.id,
        result: "ok",
        summary: `Connected shared OpenAI OAuth credential ${created.id}.`,
      })

      const credential = await getCredentialWithAlertsOrThrow({
        alerts: deps.alerts,
        credentials: deps.credentials,
        credentialId: created.id,
      })
      res.json({ credential })
    } catch (error) {
      handleRouteError(res, error, "openai_oauth_exchange_failed")
    }
  })

  router.use("/admin", express.static(publicDir, { index: false }))

  const sendAdminShell = (_req: express.Request, res: express.Response) => {
    if (existsSync(indexPath)) {
      res.sendFile(indexPath)
      return
    }

    res.type("html").send(`<!doctype html><html><body><h1>Veslo Admin</h1></body></html>`)
  }

  router.get("/admin", sendAdminShell)
  router.get("/admin/*", (req, res, next) => {
    if (req.path.startsWith("/admin/api/")) {
      next()
      return
    }
    sendAdminShell(req, res)
  })

  return router
}

function createDefaultCodexStatusProvider(
  credentials: CredentialRepository,
  secrets: SecretStore,
): CodexCredentialStatusProvider | null {
  const getCredentialRecordById = (credentials as { getCredentialRecordById?: unknown }).getCredentialRecordById
  if (typeof getCredentialRecordById !== "function") {
    return null
  }

  return new CachedCodexCredentialStatusProvider({
    loadCredentialAuthJson: async (credentialId) => {
      const credential = await getCredentialRecordById.call(credentials, credentialId) as CredentialRecord | null
      if (!credential) {
        return null
      }

      const secret = await secrets.get(credential.secretRef).catch(() => null)
      return secret?.kind === "codex_auth_json" ? secret.authJson : null
    },
  })
}

function readCredentialUsage(usage: UsageAggregateResponse): UsageCredentialAggregate[] {
  if (Array.isArray(usage.credentialUsage) && usage.credentialUsage.length > 0) {
    return usage.credentialUsage
  }

  const requestsByCredentialId = new Map(
    usage.groupBy === "credential"
      ? usage.series.map((entry) => [entry.key, entry.totalRequests] as const)
      : [],
  )

  return usage.topCredentials.map((entry) => ({
    id: entry.id,
    label: entry.label,
    cachedTokens: 0,
    totalTokens: entry.totalTokens,
    totalRequests: requestsByCredentialId.get(entry.id) ?? 0,
  }))
}

function mergeCredentialFilters(
  credentials: DecoratedAdminCredentialRecord[],
  existingFilters: UsageAggregateResponse["filters"]["credentials"],
) {
  const filters = new Map<string, string>()
  for (const credential of credentials) {
    filters.set(credential.id, credential.name)
  }
  for (const filter of existingFilters) {
    if (!filters.has(filter.id)) {
      filters.set(filter.id, filter.label)
    }
  }
  return Array.from(filters.entries()).map(([id, label]) => ({ id, label }))
}

function selectCredentialUsageCredentials(
  credentials: DecoratedAdminCredentialRecord[],
  historicalByCredentialId: Map<string, UsageCredentialAggregate>,
  filters: AdminUsageFilters,
): DecoratedAdminCredentialRecord[] {
  if (filters.credentialId) {
    return credentials.filter((credential) => credential.id === filters.credentialId)
  }

  if (filters.userId || filters.orgId) {
    return credentials.filter((credential) => historicalByCredentialId.has(credential.id))
  }

  return credentials
}

function readCachedTokens(entry: unknown): number {
  const cachedTokens = (entry as { cachedTokens?: unknown } | null | undefined)?.cachedTokens
  return typeof cachedTokens === "number" && Number.isFinite(cachedTokens) ? cachedTokens : 0
}

function readLastUsedAt(entry: unknown): string | null {
  const lastUsedAt = (entry as { lastUsedAt?: unknown } | null | undefined)?.lastUsedAt
  return typeof lastUsedAt === "string" ? lastUsedAt : null
}

function normalizeCodexEligibilityReason(reason: string | null): string | null {
  if (!reason) {
    return null
  }

  const match = reason.match(/^(.+?)\s+Codex limit is exhausted\.$/)
  if (match?.[1]) {
    return `${match[1]} limit exhausted`
  }

  return reason
}

function credentialStateEligibility(credential: AdminCredentialRecord): AdminCredentialEligibility | null {
  if (credential.state === "draining") {
    return { state: "draining", reason: "Credential is draining.", resetAt: null }
  }

  if (credential.state === "revoked") {
    return { state: "revoked", reason: "Credential is revoked.", resetAt: null }
  }

  if (credential.state === "unhealthy" || credential.state === "degraded") {
    return { state: "unhealthy", reason: "Credential is not healthy.", resetAt: null }
  }

  return null
}

function readCodexCredentialEligibility(
  credential: AdminCredentialRecord,
  upstreamStatus: CodexUsageStatus | null,
  now: Date,
): AdminCredentialEligibility {
  const stateEligibility = credentialStateEligibility(credential)
  if (stateEligibility) {
    return stateEligibility
  }

  if (!upstreamStatus) {
    return { state: "unavailable", reason: "No upstream status.", resetAt: null }
  }

  const eligibility = evaluateCodexCredentialEligibility(upstreamStatus, now)
  return {
    state: eligibility.state,
    reason: normalizeCodexEligibilityReason(eligibility.reason),
    resetAt: "resetAt" in eligibility ? eligibility.resetAt : null,
  }
}

function handleRouteError<T>(res: express.Response, error: unknown, fallback: string): T | null {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message })
    return null
  }

  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    const message = typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : fallback
    res.status((error as { status: number }).status).json({ error: message })
    return null
  }

  console.error("managed ai admin route failed", { error, fallback })
  res.status(502).json({ error: fallback })
  return null
}

function readParam(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : ""
}

function readQueryString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function getAdminActorUserId(session: AdminSessionSnapshot) {
  return session.user.email ?? session.user.id ?? null
}

function validateCreateCredentialInput(input: CreateCredentialInput): {
  provider: LeaseProvider
  name: string
  credentialType: "api_key" | "oauth"
  storedSecret: StoredSecret
} {
  const provider = parseCredentialProvider(input.provider)
  const name = typeof input.name === "string" ? input.name.trim() : ""
  const secret = typeof input.secret === "string" ? input.secret.trim() : ""

  if (!provider) {
    throw new HttpError("invalid_provider", 400)
  }

  if (!secret) {
    throw new HttpError("invalid_credential_secret", 400)
  }

  return {
    provider,
    name: name || `${formatProviderLabel(provider)} credential`,
    credentialType: provider === "codex_oauth" ? "oauth" : "api_key",
    storedSecret: provider === "codex_oauth"
      ? {
          kind: "codex_auth_json",
          authJson: validateCodexAuthJson(secret),
        }
      : {
          kind: "api_key",
          apiKey: secret,
        },
  }
}

function validateUserAiAccessInput(input: UpdateUserAiAccessInput & { userId: string }): UpsertUserAiAccessPolicyInput {
  const enabled = input.enabled === true
  const provider = parseAiAccessProvider(input.provider)
  const credentialId =
    typeof input.credentialId === "string" && input.credentialId.trim()
      ? input.credentialId.trim()
      : null
  const defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : ""
  const allowedModels = normalizeAllowedModels(input.allowedModels)

  if (enabled && !provider) {
    throw new HttpError("invalid_ai_access_provider", 400)
  }

  if (enabled && provider === "codex_oauth" && !credentialId) {
    throw new HttpError("invalid_ai_access_credential_id", 400)
  }

  if (enabled && !defaultModel) {
    throw new HttpError("invalid_ai_access_default_model", 400)
  }

  if (allowedModels.length > 0 && defaultModel && !allowedModels.includes(defaultModel)) {
    throw new HttpError("invalid_ai_access_allowed_models", 400)
  }

  return {
    userId: input.userId,
    enabled,
    provider,
    credentialId,
    defaultModel: defaultModel || null,
    allowedModels,
  }
}

function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isManagedAiProvider(value) ? value : null
}

function parseAiAccessProvider(value: unknown): AiAccessProvider | null {
  return isManagedAiProvider(value) ? value : null
}

function normalizeAllowedModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const unique = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue
    }
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }
    unique.add(trimmed)
  }

  return Array.from(unique)
}

function validateCodexAuthJson(secret: string): string {
  let parsed: unknown

  try {
    parsed = JSON.parse(secret)
  } catch {
    throw new HttpError("invalid_credential_secret", 400)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("invalid_credential_secret", 400)
  }

  const authMode = typeof (parsed as { auth_mode?: unknown }).auth_mode === "string"
    ? (parsed as { auth_mode: string }).auth_mode.trim()
    : ""
  const tokens = (parsed as { tokens?: unknown }).tokens
  const tokenRecord = tokens && typeof tokens === "object" && !Array.isArray(tokens)
    ? (tokens as Record<string, unknown>)
    : null
  const requiredTokenFields = ["id_token", "access_token", "refresh_token", "account_id"]
  const hasRequiredTokens = tokenRecord
    ? requiredTokenFields.every((key) => typeof tokenRecord[key] === "string" && tokenRecord[key]?.trim())
    : false

  if (!authMode || !hasRequiredTokens) {
    throw new HttpError("invalid_credential_secret", 400)
  }

  return secret
}

function normalizeGroupBy(value: unknown): AdminUsageResponse["groupBy"] {
  return value === "credential" || value === "user" || value === "org" ? value : "total"
}

function formatProviderLabel(provider: string) {
  return formatManagedAiProviderLabel(provider)
}

function toAdminUserAiAccessRecord(record: UserAiAccessPolicyRecord | null): AdminUserAiAccessRecord | null {
  if (!record) {
    return null
  }

  return {
    id: record.id,
    userId: record.userId,
    enabled: record.enabled,
    provider: record.provider,
    credentialId: record.credentialId,
    defaultModel: record.defaultModel,
    allowedModels: record.allowedModels,
    updatedAt: record.updatedAt.toISOString(),
  }
}

async function getCredentialWithAlertsOrThrow(input: {
  alerts: AlertRepository
  credentials: CredentialRepository
  credentialId: string
}) {
  const listAdminCredentials = input.credentials.listAdminCredentials
  if (!listAdminCredentials) {
    throw new HttpError("credential_read_model_unavailable", 503)
  }

  const [credentials, alerts] = await Promise.all([
    listAdminCredentials.call(input.credentials),
    input.alerts.listAlerts(),
  ])
  const unresolvedAlertIds = new Map<string, string[]>()
  for (const alert of alerts) {
    if (!alert.credentialId || alert.status === "resolved") {
      continue
    }
    const next = unresolvedAlertIds.get(alert.credentialId) ?? []
    next.push(alert.id)
    unresolvedAlertIds.set(alert.credentialId, next)
  }

  const credential = credentials.find((entry) => entry.id === input.credentialId)
  if (!credential) {
    throw new HttpError("credential_not_found", 404)
  }

  const linkedAlertIds = unresolvedAlertIds.get(credential.id) ?? []
  return {
    ...credential,
    alertCount: linkedAlertIds.length,
    linkedAlertIds,
  }
}

async function recordAuditEventBestEffort(
  audit: AuditRepository,
  input: {
    actorUserId?: string | null
    entityType: string
    entityId: string
    action: string
    result: "ok" | "warning" | "error"
    summary: string
  },
) {
  try {
    await audit.recordEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      result: input.result,
      summary: input.summary,
    })
  } catch (error) {
    console.error("managed ai admin audit event failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      error,
    })
  }
}

function createSignedOpenAiState(actorUserId: string | null) {
  const value = typeof actorUserId === "string" && actorUserId.trim().length > 0 ? actorUserId.trim() : "unknown-admin"
  const payload = JSON.stringify({
    actorUserId: value,
    nonce: crypto.randomUUID(),
    issuedAt: Date.now(),
  })
  const encoded = Buffer.from(payload, "utf8").toString("base64url")
  const signature = crypto
    .createHmac("sha256", openAiStateSecret())
    .update(encoded)
    .digest("base64url")
  return `${encoded}.${signature}`
}

function verifySignedOpenAiState(state: string) {
  const [encoded, signature] = state.split(".")
  if (!encoded || !signature) {
    return null
  }

  const expected = crypto
    .createHmac("sha256", openAiStateSecret())
    .update(encoded)
    .digest("base64url")

  const signatureBuffer = new Uint8Array(Buffer.from(signature))
  const expectedBuffer = new Uint8Array(Buffer.from(expected))
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      actorUserId?: unknown
      issuedAt?: unknown
    }
    if (typeof parsed.actorUserId !== "string" || typeof parsed.issuedAt !== "number") {
      return null
    }
    if (Date.now() - parsed.issuedAt > 15 * 60 * 1000) {
      return null
    }
    return parsed.actorUserId
  } catch {
    return null
  }
}

function openAiStateSecret() {
  const secret = process.env.MANAGED_AI_SECRET_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || ""
  if (!secret) {
    throw new HttpError("managed_ai_secret_key_not_configured", 500)
  }
  return secret
}

function _toAdminCredentialRecord(record: CredentialRecord): AdminCredentialRecord {
  return {
    id: record.id,
    name: record.name?.trim() || `${formatProviderLabel(record.provider)} ${record.id}`,
    provider: record.provider,
    type: record.credentialType,
    state: record.state,
    scope: record.ownerUserId,
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: record.updatedAt.toISOString(),
    lastFailureAt: record.lastFailureAt instanceof Date ? record.lastFailureAt.toISOString() : null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  }
}
