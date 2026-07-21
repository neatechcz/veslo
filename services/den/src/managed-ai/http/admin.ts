import crypto from "node:crypto"
import express from "express"

import { deploymentServiceUrl } from "../../deployment-endpoints.js"
import { asyncRoute } from "../../http/errors.js"
import type {
  AdminAlertRecord,
  AdminAuditRecord,
  AdminCodexAuthUploadResponse,
  AdminCodexAuthUploadSessionResponse,
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
import { buildCodexCapacityAlerts } from "../alerts/codex-capacity-alerts.js"
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
import { buildCodexCapacityOverview } from "../usage/codex-capacity.js"
import {
  CachedCodexCredentialStatusProvider,
  type CodexCredentialStatusProvider,
  type CodexUsageStatus,
} from "../usage/codex-status.js"
import type { UsageAggregateResponse, UsageCredentialAggregate, UsageRepository } from "../usage/repository.js"

const DEFAULT_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS = 2500

function canonicalAiGatewayAdminUrl() {
  return `${deploymentServiceUrl("ai", process.env.VESLO_DEPLOYMENT_DOMAIN)}/admin`
}

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
  baseUrl?: string | null
}

type UpdateUserAiAccessInput = {
  enabled: boolean
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
  resolveEnabledUserAiAccess?: (userId: string) => Promise<UpsertUserAiAccessPolicyInput>
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

type CodexAuthUploadSessionRecord = {
  token: string
  credentialId: string
  credentialName: string
  secretRef: string
  actorUserId: string | null
  expiresAt: Date
}

type AdminUsageFilters = {
  credentialId: string | null
  userId: string | null
  orgId: string | null
}

const CODEX_AUTH_UPLOAD_SESSION_TTL_MS = 10 * 60 * 1000

export function createManagedAiAdminRouteDeps(
  deps: ManagedAiAdminRouteOptions,
): Pick<
  AdminRouteDeps,
  | "getUserAiAccess"
  | "upsertUserAiAccess"
  | "listCredentials"
  | "createCredential"
  | "renameCredential"
  | "createCodexAuthUploadSession"
  | "uploadCodexAuth"
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
  const codexAuthUploadSessions = new Map<string, CodexAuthUploadSessionRecord>()
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
      capacity: buildCodexCapacityOverview(
        credentials
          .filter((credential) => credential.provider === "codex_oauth")
          .map((credential) => ({
            id: credential.id,
            name: credential.name,
            state: credential.state,
            upstreamStatus: credential.upstreamStatus ?? null,
          })),
      ),
    }
  }

  async function listCodexCapacityAlerts(): Promise<AlertRecord[]> {
    const listAdminCredentials = deps.credentials.listAdminCredentials
    if (!listAdminCredentials) {
      return []
    }

    const credentials = await withCodexUpstreamStatus(await listAdminCredentials.call(deps.credentials))
    return buildCodexCapacityAlerts(
      buildCodexCapacityOverview(
        credentials
          .filter((credential) => credential.provider === "codex_oauth")
          .map((credential) => ({
            id: credential.id,
            name: credential.name,
            state: credential.state,
            upstreamStatus: credential.upstreamStatus ?? null,
          })),
      ),
      now(),
    )
  }

  async function listCodexCapacityAlertsBestEffort(): Promise<AlertRecord[]> {
    try {
      return await withTimeout(
        listCodexCapacityAlerts(),
        readCodexCapacityAlertReadTimeoutMs(),
        "codex_capacity_alerts_timeout",
      )
    } catch (error) {
      console.error("managed_ai_admin_codex_capacity_alerts_failed", error)
      return []
    }
  }

  async function listAvailableAssignmentCredentials(): Promise<AdminCredentialOption[] | undefined> {
    const listAdminCredentials = deps.credentials.listAdminCredentials
    if (!listAdminCredentials) {
      return undefined
    }

    const credentials = await listAdminCredentials.call(deps.credentials)
    const options: AdminCredentialOption[] = []
    for (const credential of credentials) {
      if (credential.state !== "healthy") {
        continue
      }
      if (credential.provider === "openai_compatible") {
        options.push({
          id: credential.id,
          name: credential.name,
          provider: "openai_compatible",
        })
        continue
      }
      if (credential.provider !== "codex_oauth" || !codexStatusProvider) {
        continue
      }
      const status = await codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      })
      if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
        continue
      }
      options.push({
        id: credential.id,
        name: credential.name,
        provider: "codex_oauth",
      })
    }

    return options
  }

  async function assertAssignableCredential(provider: AiAccessProvider | null, credentialId: string | null): Promise<void> {
    if (provider !== "codex_oauth" && provider !== "openai_compatible") {
      return
    }
    if (!credentialId) {
      throw new HttpError("invalid_ai_access_credential_id", 400)
    }

    const credentials = await listAvailableAssignmentCredentials()
    if (!credentials) {
      throw new HttpError("invalid_ai_access_credential_id", 400)
    }
    const assignable = credentials.some((entry) => entry.id === credentialId && entry.provider === provider)
    if (!assignable && provider === "codex_oauth") {
      throw new HttpError("ineligible_ai_access_credential_id", 400)
    }
    if (!assignable) {
      throw new HttpError("invalid_ai_access_credential_id", 400)
    }
  }

  async function getCredentialOrThrow(credentialId: string) {
    const credential = (await listCredentialsWithAlerts()).find((entry) => entry.id === credentialId)
    if (!credential) {
      throw new HttpError("credential_not_found", 404)
    }
    return credential
  }

  async function getCodexCredentialRecordOrThrow(credentialId: string) {
    const credential = await deps.credentials.getCredentialRecordById(credentialId)
    if (!credential) {
      throw new HttpError("credential_not_found", 404)
    }
    if (credential.provider !== "codex_oauth" || credential.credentialType !== "oauth") {
      throw new HttpError("invalid_codex_auth_credential", 400)
    }
    return credential
  }

  function pruneExpiredCodexAuthUploadSessions() {
    const timestamp = now().getTime()
    for (const [token, session] of codexAuthUploadSessions) {
      if (session.expiresAt.getTime() <= timestamp) {
        codexAuthUploadSessions.delete(token)
      }
    }
  }

  function getCodexAuthUploadSession(token: string) {
    pruneExpiredCodexAuthUploadSessions()
    return codexAuthUploadSessions.get(token) ?? null
  }

  function createCodexAuthUploadUrl(req: express.Request, token: string) {
    const protocol = readFirstHeader(req.headers["x-forwarded-proto"]) ?? req.protocol ?? "http"
    const host = readFirstHeader(req.headers["x-forwarded-host"]) ?? req.get("host")
    if (!host) {
      throw new HttpError("codex_auth_upload_origin_unavailable", 500)
    }

    return `${protocol}://${host}/admin/api/credentials/codex-auth-upload/${token}`
  }

  function createCodexAuthUploadCommand(input: {
    uploadUrl: string
    credentialId: string
    credentialName: string
  }) {
    return [
      "node",
      "scripts/admin/codex-auth-upload.mjs",
      "--upload-url",
      shellQuote(input.uploadUrl),
      "--credential-id",
      shellQuote(input.credentialId),
      "--credential-name",
      shellQuote(input.credentialName),
    ].join(" ")
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
        const availableCredentials = await listAvailableAssignmentCredentials()
        const aiAccess = await deps.aiAccess.getUserAiAccess(userId)

        return {
          aiAccess: toAdminUserAiAccessRecord(aiAccess),
          availableCredentials,
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
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body as Record<string, unknown>
          : {}
        if (Object.keys(body).some((key) => key !== "enabled")) {
          throw new HttpError("user_ai_access_routing_not_supported", 400)
        }
        if (typeof body.enabled !== "boolean") {
          throw new HttpError("user_ai_access_enabled_required", 400)
        }
        const validated: UpsertUserAiAccessPolicyInput = body.enabled
          ? await resolveEnabledUserAiAccess(userId)
          : {
              userId,
              enabled: false,
              provider: null,
              credentialId: null,
              assignmentOrigin: "admin_assigned",
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
          availableCredentials: [],
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

    async renameCredential(req, res) {
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
        const name = validateCredentialName(req.body?.name)
        const action = deps.credentials.renameCredential
        if (!action) {
          throw new HttpError("credential_actions_unavailable", 503)
        }

        const updated = await action.call(deps.credentials, { credentialId, name })
        if (!updated) {
          throw new HttpError("credential_not_found", 404)
        }

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.rename",
          entityType: "credential",
          entityId: credentialId,
          result: "ok",
          summary: `Renamed credential ${credentialId}.`,
        })

        return {
          credential: await getCredentialOrThrow(credentialId),
        }
      } catch (error) {
        return handleRouteError(res, error, "credential_rename_failed")
      }
    },

    async createCodexAuthUploadSession(req, res): Promise<AdminCodexAuthUploadSessionResponse | null> {
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
        const credential = await getCodexCredentialRecordOrThrow(credentialId)
        const token = crypto.randomBytes(24).toString("hex")
        const expiresAt = new Date(now().getTime() + CODEX_AUTH_UPLOAD_SESSION_TTL_MS)
        const credentialName = getCredentialRecordName(credential)
        const uploadUrl = createCodexAuthUploadUrl(req, token)

        pruneExpiredCodexAuthUploadSessions()
        codexAuthUploadSessions.set(token, {
          token,
          credentialId,
          credentialName,
          secretRef: credential.secretRef,
          actorUserId: getAdminActorUserId(session),
          expiresAt,
        })

        await recordAuditEvent({
          actorUserId: getAdminActorUserId(session),
          action: "credential.codex_auth_upload_session.create",
          entityType: "credential",
          entityId: credentialId,
          result: "ok",
          summary: `Created Codex auth upload session for credential ${credentialId}.`,
        })

        return {
          upload: {
            token,
            credentialId,
            credentialName,
            uploadUrl,
            expiresAt: expiresAt.toISOString(),
          },
          command: createCodexAuthUploadCommand({
            uploadUrl,
            credentialId,
            credentialName,
          }),
        }
      } catch (error) {
        return handleRouteError(res, error, "codex_auth_upload_session_create_failed")
      }
    },

    async uploadCodexAuth(req, res): Promise<AdminCodexAuthUploadResponse | null> {
      const token = readParam(req.params.token)
      if (!token) {
        res.status(400).json({ error: "invalid_codex_auth_upload_token" })
        return null
      }

      try {
        const uploadSession = getCodexAuthUploadSession(token)
        if (!uploadSession) {
          throw new HttpError("codex_auth_upload_session_not_found", 404)
        }

        const rawAuthJson = typeof req.body?.authJson === "string" ? req.body.authJson : ""
        const authJson = validateCodexAuthJson(rawAuthJson)
        const accountId = readCodexAuthAccountId(authJson)
        const credential = await getCodexCredentialRecordOrThrow(uploadSession.credentialId)

        await deps.secrets.replace(credential.secretRef || uploadSession.secretRef, {
          kind: "codex_auth_json",
          authJson,
        })
        await deps.credentials.markCredentialState({
          credentialRecordId: credential.id,
          state: "healthy",
          reason: "codex_auth_upload",
        })
        codexAuthUploadSessions.delete(token)

        await recordAuditEvent({
          actorUserId: uploadSession.actorUserId,
          action: "credential.codex_auth_upload",
          entityType: "credential",
          entityId: credential.id,
          result: "ok",
          summary: `Uploaded Codex auth for credential ${credential.id}.`,
        })

        return {
          ok: true,
          credentialId: credential.id,
          credentialName: getCredentialRecordName(credential),
          accountId,
        }
      } catch (error) {
        return handleRouteError(res, error, "codex_auth_upload_failed")
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
          summary: `Rotated active routes off credential ${credentialId}.`,
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
        const [capacityAlerts, repositoryAlerts] = await Promise.all([
          listCodexCapacityAlertsBestEffort(),
          deps.alerts.listAlerts(),
        ])
        return {
          alerts: [...capacityAlerts, ...repositoryAlerts] as AdminAlertRecord[],
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

  async function resolveEnabledUserAiAccess(userId: string) {
    if (!deps.resolveEnabledUserAiAccess) {
      throw new HttpError("user_ai_access_automatic_resolution_unavailable", 503)
    }
    const resolved = await deps.resolveEnabledUserAiAccess(userId)
    if (
      resolved.userId !== userId
      || resolved.enabled !== true
      || resolved.assignmentOrigin !== "admin_assigned"
    ) {
      throw new HttpError("user_ai_access_automatic_resolution_invalid", 502)
    }
    return resolved
  }
}

export function createManagedAiAdminUiRouter(deps: ManagedAiAdminUiOptions) {
  const router = express.Router()

  router.post("/admin/api/credentials/openai/oauth/start", asyncRoute(async (req, res) => {
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
  }))

  router.post("/admin/api/credentials/openai/oauth/exchange", asyncRoute(async (req, res) => {
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
  }))

  const redirectToCanonicalAdmin = (req: express.Request, res: express.Response) => {
    const suffix = req.path === "/admin" ? "" : req.path.slice("/admin".length)
    const queryIndex = req.originalUrl.indexOf("?")
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : ""
    res.redirect(302, `${canonicalAiGatewayAdminUrl()}${suffix}${query}`)
  }

  router.get("/admin", redirectToCanonicalAdmin)
  router.get("/admin/*", (req, res, next) => {
    if (req.path === "/admin/api" || req.path.startsWith("/admin/api/")) {
      next()
      return
    }
    redirectToCanonicalAdmin(req, res)
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
    lastUsedAt: null,
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

function readFirstHeader(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== "string") {
    return null
  }
  const [first] = raw.split(",")
  const trimmed = first?.trim()
  return trimmed || null
}

function readQueryString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function getAdminActorUserId(session: AdminSessionSnapshot) {
  return session.user.email ?? session.user.id ?? null
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function validateCredentialName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : ""
  if (!name || name.length > 120) {
    throw new HttpError("invalid_credential_name", 400)
  }
  return name
}

function getCredentialRecordName(record: CredentialRecord) {
  return record.name?.trim() || `${formatProviderLabel(record.provider)} ${record.id}`
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

  if (provider === "openai_compatible") {
    return {
      provider,
      name: name || `${formatProviderLabel(provider)} credential`,
      credentialType: "api_key",
      storedSecret: {
        kind: "openai_compatible_api_key",
        apiKey: secret,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
      },
    }
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

function normalizeOpenAiCompatibleBaseUrl(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  if (parsed.search || parsed.hash || parsed.username || parsed.password || raw.includes("?") || raw.includes("#")) {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  const hostname = parsed.hostname.toLowerCase()
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new HttpError("invalid_credential_base_url", 400)
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  return parsed.toString().replace(/\/+$/, "")
}

function parseCredentialProvider(value: unknown): LeaseProvider | null {
  return isManagedAiProvider(value) ? value : null
}

function parseAiAccessProvider(value: unknown): AiAccessProvider | null {
  return isManagedAiProvider(value) ? value : null
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

function readCodexAuthAccountId(authJson: string): string {
  try {
    const parsed = JSON.parse(authJson) as { tokens?: { account_id?: unknown } }
    const accountId = typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id.trim() : ""
    if (accountId) {
      return accountId
    }
  } catch {
    // validateCodexAuthJson already normalizes this error for callers.
  }

  throw new HttpError("invalid_credential_secret", 400)
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    unrefTimer(timeout)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}

function readCodexCapacityAlertReadTimeoutMs(): number {
  const raw = Number(process.env.MANAGED_AI_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CODEX_CAPACITY_ALERT_READ_TIMEOUT_MS
}

function unrefTimer(handle: unknown) {
  if (!handle || typeof handle !== "object") {
    return
  }
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === "function") {
    unref.call(handle)
  }
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
