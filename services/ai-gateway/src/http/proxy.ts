import { Router } from "express";

import type { TokenBroker } from "../credentials/token-broker.js";
import type { LeaseBroker } from "../leases/lease-broker.js";
import type { ProviderTransport } from "../providers/transport.js";

export type ProxyDependencies = {
  leaseBroker: LeaseBroker;
  tokenBroker: TokenBroker;
  transport: ProviderTransport;
};

function getHeaderAsString(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  return null;
}

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router();

  router.post("/v1/chat/completions", async (req, res) => {
    try {
      const sessionId = getHeaderAsString(req.header("x-veslo-session-id"));
      if (!sessionId) {
        res.status(400).json({ error: "missing_session_id" });
        return;
      }

      const lease = await deps.leaseBroker.getOrCreateActiveLease(sessionId);
      const upstreamAuth = await deps.tokenBroker.getUpstreamAuth({
        bindingId: lease.activeBindingId,
      });

      const upstreamResponse = await deps.transport.chatCompletions({
        authValue: upstreamAuth.value,
        body: req.body,
      });

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
    } catch (error) {
      console.error("proxy_request_failed", error);
      res.status(502).json({ error: "proxy_request_failed" });
    }
  });

  return router;
}
