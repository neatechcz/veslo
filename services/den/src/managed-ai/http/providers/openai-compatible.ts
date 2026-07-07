import { randomUUID } from "node:crypto"

import { Router, type Response } from "express"

import type { UserAiAccessPolicyRecord } from "../../access/repository.js"
import type { GatewaySession } from "../../auth/gateway-session.js"
import type { CredentialBinding } from "../../credentials/repository.js"
import { getPlatformCredentialOwnerUserId } from "../../credentials/platform-owner.js"
import type { StoredSecret } from "../../credentials/secret-store.js"
import type { ResolveLeaseInput, SessionLease } from "../../leases/repository.js"
import type { ProviderTransportResponse } from "../../providers/transport.js"
import { ProviderTransportError } from "../../providers/transport.js"
import { readOpenAiCompatibleUsage } from "../../usage/token-accounting.js"
import { applyAiAccessPolicy } from "./access-policy.js"
import type { ProxyDependencies } from "../proxy-dependencies.js"

export function createOpenAiCompatibleProxyRouter(
  deps: Pick<
    ProxyDependencies,
    "credentials" | "secrets" | "usageRepository" | "leaseBroker" | "openAiCompatibleTransport"
  >,
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
          routeProvider: "openai_compatible",
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

    const assignedSecret = assignedBinding ? await loadAssignedSecret(assignedBinding.id) : null
    if (assignedBinding && !assignedSecret) {
      res.status(503).json({ error: "assigned_credential_unavailable" })
      return
    }
    if (assignedSecret && assignedSecret.kind !== "openai_compatible_api_key") {
      res.status(503).json({ error: "invalid_custom_provider_config" })
      return
    }

    const scope: ResolveLeaseInput = {
      ownerUserId: gatewaySession.user.id,
      bindingOwnerUserId: assignedBinding?.ownerUserId ?? getPlatformCredentialOwnerUserId("openai_compatible"),
      requiredBindingId: assignedBinding?.id,
      provider: "openai_compatible",
      sessionId,
    }

    try {
      const upstreamResponse = await executeRequest(scope, policyResult.body, assignedSecret)
      applyUpstreamResponse(res, upstreamResponse)
    } catch (error) {
      if (error instanceof ProviderTransportError) {
        res.status(error.statusCode ?? 502).json({ error: "openai_compatible_upstream_error" })
        return
      }

      console.error("proxy_request_failed", error)
      res.status(502).json({ error: "proxy_request_failed" })
    }
  })

  return router

  async function executeRequest(
    scope: ResolveLeaseInput,
    body: unknown,
    secret: Extract<StoredSecret, { kind: "openai_compatible_api_key" }> | null,
  ): Promise<ProviderTransportResponse> {
    const lease = await deps.leaseBroker.getOrCreateActiveLease(scope)
    return executeLeaseRequest(lease, body, secret)
  }

  async function executeLeaseRequest(
    lease: SessionLease,
    body: unknown,
    secret: Extract<StoredSecret, { kind: "openai_compatible_api_key" }> | null,
  ): Promise<ProviderTransportResponse> {
    if (!secret) {
      throw new Error("openai_compatible_secret_unavailable")
    }

    const upstreamResponse = await deps.openAiCompatibleTransport.chatCompletions({
      apiKey: secret.apiKey,
      baseUrl: secret.baseUrl,
      body,
    })

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

      const requestId = getOpenAiCompatibleRequestId(input.upstreamResponse)
      const usage = readOpenAiCompatibleUsage(input.upstreamResponse.body)
      const model = getModel(input.upstreamResponse.body) ?? getModel(input.requestBody) ?? "unknown"

      await deps.usageRepository.recordUsage({
        requestId,
        ownerUserId: input.ownerUserId,
        orgId: null,
        provider: "openai_compatible",
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
    return binding?.provider === "openai_compatible" ? binding : null
  }

  async function loadAssignedSecret(bindingId: string): Promise<StoredSecret | null> {
    try {
      const credential = await deps.credentials.getCredentialRecordByBindingId?.(bindingId)
      if (!credential) {
        return null
      }

      return await deps.secrets.get(credential.secretRef)
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

function getOpenAiCompatibleRequestId(upstreamResponse: ProviderTransportResponse) {
  return (
    upstreamResponse.headers?.["x-upstream-request-id"] ??
    upstreamResponse.headers?.["x-request-id"] ??
    getString(getRecord(upstreamResponse.body), "id") ??
    `openai_compatible_req_${randomUUID()}`
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
