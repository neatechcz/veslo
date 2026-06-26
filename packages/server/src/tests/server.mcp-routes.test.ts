import { describe, expect, test } from "bun:test";

import { registerMcpRoutes } from "../routes/mcp.js";
import { matchRoute, type Route } from "../routing.js";

describe("MCP routes", () => {
  test("registers the hub and workspace MCP contract", () => {
    const routes: Route[] = [];
    registerMcpRoutes(routes, {
      fetchOpencodeJson: async () => ({}),
    });

    expect(routes).toHaveLength(7);

    const expectedRoutes = [
      ["GET", "/hub/mcp"],
      ["GET", "/workspace/demo/mcp"],
      ["POST", "/workspace/demo/mcp/hub/google-gmail"],
      ["POST", "/workspace/demo/mcp/google-gmail/runtime-token/refresh"],
      ["POST", "/workspace/demo/mcp"],
      ["DELETE", "/workspace/demo/mcp/google-gmail"],
      ["DELETE", "/workspace/demo/mcp/google-gmail/auth"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/mcp")).toBeNull();
  });
});
