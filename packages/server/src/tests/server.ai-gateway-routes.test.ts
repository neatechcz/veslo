import { describe, expect, test } from "bun:test";

import { registerAiGatewayRoutes } from "../routes/ai-gateway.js";
import { matchRoute, type RequestContext, type Route } from "../routing.js";

const actor = { type: "remote", tokenHash: "actor-token", scope: "collaborator" } as const;

describe("AI gateway routes", () => {
  test("registers the AI gateway proxy contract", () => {
    const routes: Route[] = [];
    const proxy = async () => new Response("{}");
    registerAiGatewayRoutes(routes, {
      clearAiGatewayRuntimeAuthorization: () => undefined,
      proxyAiGatewayReadinessRequest: proxy,
      proxyAiGatewayRequest: proxy,
      resolveAiGatewayWorkspaceId: async (_ctx, workspaceId) => workspaceId,
    });

    expect(routes).toHaveLength(8);

    const expectedRoutes = [
      ["GET", "/ai-gateway/me/ai-access"],
      ["GET", "/workspace/:id/ai-gateway/me/ai-access"],
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

  test("provider proxy routes require collaborator scope", async () => {
    const routes: Route[] = [];
    let proxyCalled = false;
    const proxy = async () => {
      proxyCalled = true;
      return new Response("{}");
    };
    registerAiGatewayRoutes(routes, {
      clearAiGatewayRuntimeAuthorization: () => undefined,
      proxyAiGatewayReadinessRequest: proxy,
      proxyAiGatewayRequest: proxy,
      resolveAiGatewayWorkspaceId: async (_ctx, workspaceId) => workspaceId,
    });

    const route = matchRoute(routes, "POST", "/ai-gateway/providers/openai/v1/chat/completions");
    expect(route).not.toBeNull();

    await expect(route?.handler({
      request: new Request("http://127.0.0.1/ai-gateway/providers/openai/v1/chat/completions", { method: "POST" }),
      url: new URL("http://127.0.0.1/ai-gateway/providers/openai/v1/chat/completions"),
      params: {},
      actor: { type: "remote", scope: "viewer" },
    } as RequestContext)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      details: {
        required: "collaborator",
        scope: "viewer",
      },
    });
    expect(proxyCalled).toBe(false);
  });

  test("workspace access prime uses only the server-resolved route workspace identity", async () => {
    const routes: Route[] = [];
    const proxyInputs: Array<Record<string, unknown>> = [];
    registerAiGatewayRoutes(routes, {
      clearAiGatewayRuntimeAuthorization: () => undefined,
      proxyAiGatewayReadinessRequest: async () => new Response("{}"),
      proxyAiGatewayRequest: async (input) => {
        proxyInputs.push(input as unknown as Record<string, unknown>);
        return new Response("{}");
      },
      resolveAiGatewayWorkspaceId: async (_ctx, workspaceId) => {
        expect(workspaceId).toBe("forged-route-value");
        return "server-owned-workspace";
      },
    });

    const route = matchRoute(
      routes,
      "GET",
      "/workspace/forged-route-value/ai-gateway/me/ai-access",
    );
    await route?.handler({
      request: new Request("http://127.0.0.1/workspace/forged-route-value/ai-gateway/me/ai-access", {
        headers: { "x-veslo-workspace-id": "forged-header-workspace" },
      }),
      url: new URL("http://127.0.0.1/workspace/forged-route-value/ai-gateway/me/ai-access"),
      params: { id: "forged-route-value" },
      actor,
    } as unknown as RequestContext);

    expect(proxyInputs).toHaveLength(1);
    expect(proxyInputs[0]?.runtimeWorkspaceId).toBe("server-owned-workspace");
  });
});
