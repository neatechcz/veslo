import { describe, expect, test } from "bun:test";

import { registerCommandRoutes } from "../routes/commands.js";
import { matchRoute, type Route } from "../routing.js";

describe("Command workspace routes", () => {
  test("registers the workspace command contract", () => {
    const routes: Route[] = [];
    registerCommandRoutes(routes, {
      requireHost: async () => ({ type: "host", scope: "owner" }),
    });

    expect(routes).toHaveLength(3);

    const expectedRoutes = [
      ["GET", "/workspace/demo/commands"],
      ["POST", "/workspace/demo/commands"],
      ["DELETE", "/workspace/demo/commands/deploy"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/commands")).toBeNull();
  });
});
