import { randomUUID } from "node:crypto";

import { Router, type Response } from "express";

import type { UserAiAccessPolicyRecord } from "../../access/repository.js";
import type { GatewaySession } from "../../auth/gateway-session.js";
import { getPlatformCredentialOwnerUserId } from "../../credentials/platform-owner.js";
import { classifyUpstreamFailure, getUpstreamFailureInput } from "../../leases/error-classifier.js";
import type { ResolveLeaseInput, SessionLease } from "../../leases/repository.js";
import type { ProviderTransportResponse } from "../../providers/transport.js";
import { applyAiAccessPolicy } from "./access-policy.js";
import { normalizeGatewaySessionId } from "./session-id.js";
import type { ProxyDependencies } from "../proxy.js";

export function createOpenAiProxyRouter(
  deps: Pick<ProxyDependencies, "credentials" | "usageRepository" | "leaseBroker" | "tokenBroker" | "openAiTransport">,
) {
  const router = Router();

  router.post("/v1/chat/completions", async (req, res) => {
    const rawSessionId = getHeaderAsString(req.header("x-veslo-session-id"));
    if (!rawSessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const gatewaySession = res.locals.gatewaySession as GatewaySession | undefined;
    if (!gatewaySession?.user?.id) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const sessionId = normalizeGatewaySessionId(rawSessionId, gatewaySession.user.id, "openai");

    const gatewayAiAccess = res.locals.gatewayAiAccess as UserAiAccessPolicyRecord | undefined;
    const policyResult = gatewayAiAccess
      ? applyAiAccessPolicy({
          routeProvider: "openai",
          aiAccess: gatewayAiAccess,
          body: req.body,
        })
      : { ok: true as const, body: req.body as Record<string, unknown> };
    if (!policyResult.ok) {
      res.status(policyResult.status).json({ error: policyResult.error });
      return;
    }

    const scope: ResolveLeaseInput = {
      ownerUserId: gatewaySession.user.id,
      bindingOwnerUserId: getPlatformCredentialOwnerUserId("openai"),
      provider: "openai",
      sessionId,
    };

    try {
      const upstreamResponse = await executeWithRetry(scope, policyResult.body);
      applyUpstreamResponse(res, upstreamResponse);
    } catch (error) {
      console.error("proxy_request_failed", error);
      res.status(502).json({ error: "proxy_request_failed" });
    }
  });

  return router;

  async function executeWithRetry(
    scope: ResolveLeaseInput,
    body: unknown,
  ): Promise<ProviderTransportResponse> {
    const initialLease = await deps.leaseBroker.getOrCreateActiveLease(scope);

    try {
      return await executeLeaseRequest(initialLease, body);
    } catch (error) {
      const failure = getUpstreamFailureInput(error);
      if (classifyUpstreamFailure(failure) !== "permanent_credential") {
        throw error;
      }

      const reboundLease = await deps.leaseBroker.handleUpstreamFailure({
        ...scope,
        currentBindingId: initialLease.activeBindingId,
        failure,
      });

      if (reboundLease.activeBindingId === initialLease.activeBindingId) {
        throw error;
      }

      return executeLeaseRequest(reboundLease, body);
    }
  }

  async function executeLeaseRequest(
    lease: SessionLease,
    body: unknown,
  ): Promise<ProviderTransportResponse> {
    const upstreamAuth = await deps.tokenBroker.getUpstreamAuth({
      bindingId: lease.activeBindingId,
    });

    const upstreamResponse = await deps.openAiTransport.chatCompletions({
      upstreamAuth,
      body,
    });

    await recordUsage({
      ownerUserId: lease.ownerUserId,
      sessionId: lease.sessionId,
      bindingId: lease.activeBindingId,
      requestBody: body,
      upstreamResponse,
    });

    return upstreamResponse;
  }

  async function recordUsage(input: {
    ownerUserId: string;
    sessionId: string;
    bindingId: string;
    requestBody: unknown;
    upstreamResponse: ProviderTransportResponse;
  }) {
    try {
      const credential = await deps.credentials.getCredentialRecordByBindingId?.(input.bindingId);
      if (!credential) {
        return;
      }

      const requestId = getOpenAiRequestId(input.upstreamResponse);
      const usage = getOpenAiUsage(input.upstreamResponse.body);
      const model = getModel(input.upstreamResponse.body) ?? getModel(input.requestBody) ?? "unknown";

      await deps.usageRepository.recordUsage({
        requestId,
        ownerUserId: input.ownerUserId,
        provider: "openai",
        sessionId: input.sessionId,
        credentialId: credential.id,
        bindingId: input.bindingId,
        model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
    } catch (error) {
      console.error("proxy_usage_record_failed", error);
    }
  }
}

function getHeaderAsString(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  return null;
}

function applyUpstreamResponse(res: Response, upstreamResponse: ProviderTransportResponse) {
  if (upstreamResponse.headers) {
    for (const [headerName, headerValue] of Object.entries(upstreamResponse.headers)) {
      res.setHeader(headerName, headerValue);
    }
  }

  res.status(upstreamResponse.status);

  if (typeof upstreamResponse.body === "object") {
    res.json(upstreamResponse.body);
    return;
  }

  res.send(upstreamResponse.body as never);
}

function getOpenAiRequestId(upstreamResponse: ProviderTransportResponse) {
  return (
    upstreamResponse.headers?.["x-upstream-request-id"] ??
    upstreamResponse.headers?.["x-request-id"] ??
    getString(getRecord(upstreamResponse.body), "id") ??
    `openai_req_${randomUUID()}`
  );
}

function getOpenAiUsage(body: unknown): { inputTokens?: number; outputTokens?: number } | null {
  const usage = getRecord(body)?.usage;
  const usageRecord = getRecord(usage);
  if (!usageRecord) {
    return null;
  }

  return {
    inputTokens: getNumber(usageRecord, "prompt_tokens"),
    outputTokens: getNumber(usageRecord, "completion_tokens"),
  };
}

function getModel(body: unknown): string | null {
  return getString(getRecord(body), "model");
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
