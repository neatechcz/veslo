import { Router } from "express";

import { readBearerToken } from "../auth/user-session.js";
import type { GatewaySessionResolver } from "../auth/gateway-session.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { TokenBroker } from "../credentials/token-broker.js";
import type { LeaseBroker } from "../leases/lease-broker.js";
import type { AnthropicProviderTransport, OpenAiProviderTransport } from "../providers/transport.js";
import type { UsageRepository } from "../usage/repository.js";
import { createAnthropicProxyRouter } from "./providers/anthropic.js";
import { createOpenAiProxyRouter } from "./providers/openai.js";

export type ProxyDependencies = {
  gatewaySessions: GatewaySessionResolver;
  credentials: CredentialRepository;
  usageRepository: UsageRepository;
  leaseBroker: LeaseBroker;
  tokenBroker: TokenBroker;
  openAiTransport: OpenAiProviderTransport;
  anthropicTransport: AnthropicProviderTransport;
};

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router();
  router.use("/providers", async (req, res, next) => {
    const token = readBearerToken(req.header("authorization"));
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const session = await deps.gatewaySessions.resolveSession(token);
    if (!session) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    res.locals.gatewaySession = session;
    next();
  });

  router.use("/providers/openai", createOpenAiProxyRouter(deps));
  router.use("/providers/anthropic", createAnthropicProxyRouter(deps));

  return router;
}
