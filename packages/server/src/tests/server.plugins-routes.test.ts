import { describe, expect, test } from "bun:test";

import { registerPluginRoutes } from "../routes/plugins.js";
import { matchRoute, type Route } from "../routing.js";

describe("Plugin workspace routes", () => {
  test("registers the workspace plugin contract", () => {
    const routes: Route[] = [];
    registerPluginRoutes(routes);

    expect(routes).toHaveLength(3);

    const expectedRoutes = [
      ["GET", "/workspace/demo/plugins"],
      ["POST", "/workspace/demo/plugins"],
      ["DELETE", "/workspace/demo/plugins/example-plugin"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/plugins")).toBeNull();
  });
});
