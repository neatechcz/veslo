import { addRoute, type Route } from "../routing.js";
import { jsonResponse, requireClientScope } from "../route-helpers.js";
import type { Actor } from "../types.js";

type AiGatewayProxyRequestInput = {
  request: Request;
  url: URL;
  actor?: Actor;
  gatewayPath: string;
  auth: "caller" | "gateway-token";
  preserveAiAccessToken?: boolean;
  requireSessionId?: boolean;
};

type AiGatewayReadinessRequestInput = {
  request: Request;
  url: URL;
};

export type AiGatewayRouteDependencies = {
  proxyAiGatewayRequest: (input: AiGatewayProxyRequestInput) => Promise<Response>;
  proxyAiGatewayReadinessRequest: (input: AiGatewayReadinessRequestInput) => Promise<Response>;
  clearAiGatewayRuntimeAuthorization: (actor?: Actor) => void;
};

type AiGatewayRouteContext = Parameters<Route["handler"]>[0];

function proxyRequestInput(
  ctx: AiGatewayRouteContext,
  input: Omit<AiGatewayProxyRequestInput, "request" | "url" | "actor">,
): AiGatewayProxyRequestInput {
  return {
    request: ctx.request,
    url: ctx.url,
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    ...input,
  };
}

export function registerAiGatewayRoutes(routes: Route[], dependencies: AiGatewayRouteDependencies): void {
  addRoute(routes, "GET", "/ai-gateway/me/ai-access", "client", async (ctx) => {
    return dependencies.proxyAiGatewayRequest(proxyRequestInput(ctx, {
      gatewayPath: "/api/me/ai-access",
      auth: "caller",
      preserveAiAccessToken: true,
    }));
  });

  addRoute(routes, "GET", "/ai-gateway/readiness", "client", async (ctx) => {
    return dependencies.proxyAiGatewayReadinessRequest({
      request: ctx.request,
      url: ctx.url,
    });
  });

  addRoute(routes, "POST", "/ai-gateway/me/runtime-authorization/clear", "client", async (ctx) => {
    dependencies.clearAiGatewayRuntimeAuthorization(ctx.actor);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/ai-gateway/providers/openai/v1/chat/completions", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return dependencies.proxyAiGatewayRequest(proxyRequestInput(ctx, {
      gatewayPath: "/providers/openai/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    }));
  });

  addRoute(routes, "POST", "/ai-gateway/providers/anthropic/v1/messages", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return dependencies.proxyAiGatewayRequest(proxyRequestInput(ctx, {
      gatewayPath: "/providers/anthropic/v1/messages",
      auth: "gateway-token",
      requireSessionId: true,
    }));
  });

  addRoute(routes, "POST", "/ai-gateway/providers/codex_oauth/v1/chat/completions", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return dependencies.proxyAiGatewayRequest(proxyRequestInput(ctx, {
      gatewayPath: "/providers/codex_oauth/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    }));
  });

  addRoute(routes, "POST", "/ai-gateway/providers/openai_compatible/v1/chat/completions", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    return dependencies.proxyAiGatewayRequest(proxyRequestInput(ctx, {
      gatewayPath: "/providers/openai_compatible/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    }));
  });
}
