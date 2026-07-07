import { describe, expect, test } from "bun:test";

import { registerAiGatewayRoutes } from "../routes/ai-gateway.js";
import { matchRoute, type Route } from "../routing.js";

describe("AI gateway routes", () => {
  test("registers the AI gateway proxy contract", () => {
    const routes: Route[] = [];
    const proxy = async () => new Response("{}");
    registerAiGatewayRoutes(routes, {
      clearAiGatewayRuntimeAuthorization: () => undefined,
      proxyAiGatewayReadinessRequest: proxy,
      proxyAiGatewayRequest: proxy,
    });

    expect(routes).toHaveLength(7);

    const expectedRoutes = [
      ["GET", "/ai-gateway/me/ai-access"],
      ["GET", "/ai-gateway/readiness"],
      ["POST", "/ai-gateway/me/runtime-authorization/clear"],
      ["POST", "/ai-gateway/providers/openai/v1/chat/completions"],
      ["POST", "/ai-gateway/providers/anthropic/v1/messages"],
      ["POST", "/ai-gateway/providers/codex_oauth/v1/chat/completions"],
      ["POST", "/ai-gateway/providers/openai_compatible/v1/chat/completions"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "POST", "/ai/providers/openai/v1/chat/completions")).toBeNull();
  });
});
