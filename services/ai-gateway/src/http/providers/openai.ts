import { Router, type Response } from "express";

import { classifyUpstreamFailure, getUpstreamFailureInput } from "../../leases/error-classifier.js";
import type { ResolveLeaseInput, SessionLease } from "../../leases/repository.js";
import type { ProviderTransportResponse } from "../../providers/transport.js";
import type { ProxyDependencies } from "../proxy.js";

export function createOpenAiProxyRouter(
  deps: Pick<ProxyDependencies, "leaseBroker" | "tokenBroker" | "openAiTransport">,
) {
  const router = Router();

  router.post("/v1/chat/completions", async (req, res) => {
    const sessionId = getHeaderAsString(req.header("x-veslo-session-id"));
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const scope: ResolveLeaseInput = {
      ownerUserId: getHeaderAsString(req.header("x-veslo-owner-user-id")) ?? "system_default",
      provider: "openai",
      sessionId,
    };

    try {
      const upstreamResponse = await executeWithRetry(scope, req.body);
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

    return deps.openAiTransport.chatCompletions({
      upstreamAuth,
      body,
    });
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
