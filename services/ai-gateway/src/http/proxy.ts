import { Router } from "express";

import type { TokenBroker } from "../credentials/token-broker.js";
import type { LeaseBroker } from "../leases/lease-broker.js";
import type { AnthropicProviderTransport, OpenAiProviderTransport } from "../providers/transport.js";
import { createAnthropicProxyRouter } from "./providers/anthropic.js";
import { createOpenAiProxyRouter } from "./providers/openai.js";

export type ProxyDependencies = {
  leaseBroker: LeaseBroker;
  tokenBroker: TokenBroker;
  openAiTransport: OpenAiProviderTransport;
  anthropicTransport: AnthropicProviderTransport;
};

export function createProxyRouter(deps: ProxyDependencies) {
  const router = Router();
  router.use("/providers/openai", createOpenAiProxyRouter(deps));
  router.use("/providers/anthropic", createAnthropicProxyRouter(deps));

  return router;
}
