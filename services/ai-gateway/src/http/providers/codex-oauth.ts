import { randomUUID } from "node:crypto"

import { Router, type Response } from "express"

import type { UserAiAccessPolicyRecord } from "../../access/repository.js"
import type { GatewaySession } from "../../auth/gateway-session.js"
import type { CredentialBinding } from "../../credentials/repository.js"
import { getPlatformCredentialOwnerUserId } from "../../credentials/platform-owner.js"
import type { ResolveLeaseInput, SessionLease } from "../../leases/repository.js"
import type { PlatformModelRef } from "../../model-policy/repository.js"
import type { ProviderTransportResponse } from "../../providers/transport.js"
import { ProviderTransportError } from "../../providers/transport.js"
import { readOpenAiCompatibleUsage } from "../../usage/token-accounting.js"
import { applyPlatformModelPolicy } from "./access-policy.js"
import {
  recordProviderCredentialFailureAlert,
  recordProviderProxyFailureAlert,
} from "./proxy-failure-alert.js"
import { normalizeGatewaySessionId } from "./session-id.js"
import { asyncHandler } from "../async-handler.js"
import type { ProxyDependencies } from "../proxy-dependencies.js"

export function createCodexOAuthProxyRouter(
  deps: Pick<
    ProxyDependencies,
    | "credentials"
    | "alertRepository"
    | "secrets"
    | "usageRepository"
    | "leaseBroker"
    | "codexOAuthTransport"
    | "autoAssignedCodexCredentialRotation"
  >,
) {
  const router = Router()

  router.post("/v1/chat/completions", asyncHandler(async (req, res) => {
    const rawSessionId = getHeaderAsString(req.header("x-veslo-session-id"))
    if (!rawSessionId) {
      res.status(400).json({ error: "missing_session_id" })
      return
    }

    const gatewaySession = res.locals.gatewaySession as GatewaySession | undefined
    if (!gatewaySession?.user?.id) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const sessionId = normalizeGatewaySessionId(rawSessionId, gatewaySession.user.id, "codex_oauth")

    let gatewayAiAccess = res.locals.gatewayAiAccess as UserAiAccessPolicyRecord | undefined
    if (gatewayAiAccess && deps.autoAssignedCodexCredentialRotation) {
      try {
        gatewayAiAccess = await deps.autoAssignedCodexCredentialRotation.repairCodexAccess({
          aiAccess: gatewayAiAccess,
          reason: "codex_proxy_request",
        })
        res.locals.gatewayAiAccess = gatewayAiAccess
      } catch (error) {
        console.error("codex_auto_assignment_repair_failed", error)
      }
    }

    const activeModel = res.locals.gatewayActiveModel as PlatformModelRef
    const policyResult = applyPlatformModelPolicy({
      routeProvider: "codex_oauth",
      activeModel,
      body: req.body,
    })
    if (!policyResult.ok) {
      res.status(policyResult.status).json({ error: policyResult.error })
      return
    }

    const assignedBinding = gatewayAiAccess
      ? await resolveAssignedBinding(gatewayAiAccess)
      : null
    if (gatewayAiAccess && !assignedBinding) {
      await recordProviderCredentialFailureAlert({
        alertRepository: deps.alertRepository,
        credentialId: gatewayAiAccess.credentialId,
        provider: "codex_oauth",
        sessionId,
        reason: "assigned_credential_unavailable",
      })
      res.status(503).json({ error: "assigned_credential_unavailable" })
      return
    }

    const assignedAuthJson = assignedBinding
      ? await loadAssignedAuthJson(assignedBinding.id)
      : null
    if (assignedBinding && !assignedAuthJson) {
      await recordProviderCredentialFailureAlert({
        alertRepository: deps.alertRepository,
        credentialId: assignedBinding.credentialRecordId,
        provider: "codex_oauth",
        sessionId,
        reason: "assigned_credential_unavailable",
      })
      res.status(503).json({ error: "assigned_credential_unavailable" })
      return
    }

    const scope: ResolveLeaseInput = {
      ownerUserId: gatewaySession.user.id,
      bindingOwnerUserId: assignedBinding?.ownerUserId ?? getPlatformCredentialOwnerUserId("codex_oauth"),
      requiredBindingId: assignedBinding?.id,
      provider: "codex_oauth",
      sessionId,
    }

    try {
      const upstreamResponse = await executeRequest(scope, policyResult.body, assignedAuthJson)
      await applyUpstreamResponse(res, upstreamResponse)
    } catch (error) {
      await recordProviderProxyFailureAlert({
        alertRepository: deps.alertRepository,
        credentialId: assignedBinding?.credentialRecordId ?? null,
        provider: "codex_oauth",
        sessionId,
        error,
      })

      if (error instanceof ProviderTransportError) {
        if (error.body && typeof error.body === "object") {
          res.status(error.statusCode ?? 502).json(error.body as Record<string, unknown>)
          return
        }

        if (error.statusCode) {
          res.status(error.statusCode).json({ error: error.message })
          return
        }
      }

      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("no_eligible_codex_credentials")) {
        res.status(503).json({
          error: "no_eligible_codex_credentials",
          reason: message.includes("all_codex_credentials_exhausted")
            ? "all_codex_credentials_exhausted"
            : "no_eligible_binding",
          provider: "codex_oauth",
        })
        return
      }

      console.error("proxy_request_failed", error)
      res.status(502).json({ error: "proxy_request_failed" })
    }
  }))

  return router

  async function executeRequest(
    scope: ResolveLeaseInput,
    body: unknown,
    authJson: string | null,
  ): Promise<ProviderTransportResponse> {
    const lease = await deps.leaseBroker.getOrCreateActiveLease(scope)
    return executeLeaseRequest(lease, body, authJson)
  }

  async function executeLeaseRequest(
    lease: SessionLease,
    body: unknown,
    authJson: string | null,
  ): Promise<ProviderTransportResponse> {
    const upstreamResponse = await deps.codexOAuthTransport.chatCompletions({ body, authJson })

    if (upstreamResponse.usagePromise) {
      upstreamResponse.usagePromise
        .then(async (usage) => {
          if (!usage) return
          await recordUsage({
            ownerUserId: lease.ownerUserId,
            sessionId: lease.sessionId,
            bindingId: lease.activeBindingId,
            requestBody: body,
            upstreamResponse: { ...upstreamResponse, usage },
          })
        })
        .catch((error) => {
          console.error("proxy_usage_record_failed", error)
        })
    } else {
      await recordUsage({
        ownerUserId: lease.ownerUserId,
        sessionId: lease.sessionId,
        bindingId: lease.activeBindingId,
        requestBody: body,
        upstreamResponse,
      })
    }

    return upstreamResponse
  }

  async function recordUsage(input: {
    ownerUserId: string
    sessionId: string
    bindingId: string
    requestBody: unknown
    upstreamResponse: ProviderTransportResponse
  }) {
    try {
      const credential = await deps.credentials.getCredentialRecordByBindingId?.(input.bindingId)
      if (!credential) {
        return
      }

      const requestId = getCodexRequestId(input.upstreamResponse)
      const usage = input.upstreamResponse.usage ?? readOpenAiCompatibleUsage(input.upstreamResponse.body)
      const model = getModel(input.upstreamResponse.body) ?? getModel(input.requestBody) ?? "unknown"

      await deps.usageRepository.recordUsage({
        requestId,
        ownerUserId: input.ownerUserId,
        provider: "codex_oauth",
        sessionId: input.sessionId,
        credentialId: credential.id,
        bindingId: input.bindingId,
        model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cachedTokens ?? 0,
        totalTokens: usage?.totalTokens,
      })
    } catch (error) {
      console.error("proxy_usage_record_failed", error)
    }
  }

  async function resolveAssignedBinding(
    aiAccess: UserAiAccessPolicyRecord,
  ): Promise<CredentialBinding | null> {
    const credentialId = typeof aiAccess.credentialId === "string" ? aiAccess.credentialId.trim() : ""
    if (!credentialId) {
      return null
    }

    const lookup = deps.credentials.getBindingByCredentialId
    if (!lookup) {
      return null
    }

    const binding = await lookup.call(deps.credentials, credentialId)
    return binding?.provider === "codex_oauth" ? binding : null
  }

  async function loadAssignedAuthJson(bindingId: string): Promise<string | null> {
    try {
      const credential = await deps.credentials.getCredentialRecordByBindingId?.(bindingId)
      if (!credential) {
        return null
      }

      const secret = await deps.secrets.get(credential.secretRef)
      return secret.kind === "codex_auth_json" ? secret.authJson : null
    } catch {
      return null
    }
  }
}

function getHeaderAsString(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0]
  }

  return null
}

async function applyUpstreamResponse(res: Response, upstreamResponse: ProviderTransportResponse) {
  if (upstreamResponse.headers) {
    for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
      res.setHeader(headerName, headerValue)
    }
  }

  res.status(upstreamResponse.status)

  if (isWebReadableStream(upstreamResponse.body)) {
    await sendWebReadableStream(res, upstreamResponse.body)
    return
  }

  if (typeof upstreamResponse.body === "object") {
    res.json(upstreamResponse.body)
    return
  }

  res.send(upstreamResponse.body as never)
}

function isWebReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof value === "object" && typeof (value as { getReader?: unknown }).getReader === "function")
}

async function sendWebReadableStream(res: Response, body: ReadableStream<Uint8Array>) {
  res.flushHeaders()
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

function getCodexRequestId(upstreamResponse: ProviderTransportResponse) {
  return (
    upstreamResponse.headers?.["x-upstream-request-id"] ??
    upstreamResponse.headers?.["x-request-id"] ??
    getString(getRecord(upstreamResponse.body), "id") ??
    `codex_oauth_req_${randomUUID()}`
  )
}

function getModel(body: unknown): string | null {
  return getString(getRecord(body), "model")
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  return value as Record<string, unknown>
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}
