import { randomUUID } from "node:crypto"

import { Router, type Response } from "express"

import type { UserAiAccessPolicyRecord } from "../../access/repository.js"
import type { GatewaySession } from "../../auth/gateway-session.js"
import type { CredentialBinding } from "../../credentials/repository.js"
import { getPlatformCredentialOwnerUserId } from "../../credentials/platform-owner.js"
import type { ResolveLeaseInput, SessionLease } from "../../leases/repository.js"
import type { ProviderTransportResponse } from "../../providers/transport.js"
import { ProviderTransportError } from "../../providers/transport.js"
import { applyAiAccessPolicy } from "./access-policy.js"
import type { ProxyDependencies } from "../proxy.js"

export function createCodexOAuthProxyRouter(
  deps: Pick<ProxyDependencies, "credentials" | "secrets" | "usageRepository" | "leaseBroker" | "codexOAuthTransport">,
) {
  const router = Router()

  router.post("/v1/chat/completions", async (req, res) => {
    const sessionId = getHeaderAsString(req.header("x-veslo-session-id"))
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" })
      return
    }

    const gatewaySession = res.locals.gatewaySession as GatewaySession | undefined
    if (!gatewaySession?.user?.id) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const gatewayAiAccess = res.locals.gatewayAiAccess as UserAiAccessPolicyRecord | undefined
    const policyResult = gatewayAiAccess
      ? applyAiAccessPolicy({
          routeProvider: "codex_oauth",
          aiAccess: gatewayAiAccess,
          body: req.body,
        })
      : { ok: true as const, body: req.body as Record<string, unknown> }
    if (!policyResult.ok) {
      res.status(policyResult.status).json({ error: policyResult.error })
      return
    }

    const assignedBinding = gatewayAiAccess
      ? await resolveAssignedBinding(gatewayAiAccess)
      : null
    if (gatewayAiAccess && !assignedBinding) {
      res.status(503).json({ error: "assigned_credential_unavailable" })
      return
    }

    const assignedAuthJson = assignedBinding
      ? await loadAssignedAuthJson(assignedBinding.id)
      : null
    if (assignedBinding && !assignedAuthJson) {
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
      applyUpstreamResponse(res, upstreamResponse)
    } catch (error) {
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

      console.error("proxy_request_failed", error)
      res.status(502).json({ error: "proxy_request_failed" })
    }
  })

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

    await recordUsage({
      ownerUserId: lease.ownerUserId,
      sessionId: lease.sessionId,
      bindingId: lease.activeBindingId,
      requestBody: body,
      upstreamResponse,
    })

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
      const model = getModel(input.upstreamResponse.body) ?? getModel(input.requestBody) ?? "unknown"

      await deps.usageRepository.recordUsage({
        requestId,
        ownerUserId: input.ownerUserId,
        provider: "codex_oauth",
        sessionId: input.sessionId,
        credentialId: credential.id,
        bindingId: input.bindingId,
        model,
        inputTokens: undefined,
        outputTokens: undefined,
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

function applyUpstreamResponse(res: Response, upstreamResponse: ProviderTransportResponse) {
  if (upstreamResponse.headers) {
    for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
      res.setHeader(headerName, headerValue)
    }
  }

  res.status(upstreamResponse.status)

  if (typeof upstreamResponse.body === "object") {
    res.json(upstreamResponse.body)
    return
  }

  res.send(upstreamResponse.body as never)
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
