import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerHealthStatusRoutes } from "../routes/health.js";

describe("Health and status routes", () => {
  test("registers health, toy UI, status, and capability endpoints", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerHealthStatusRoutes>[1];

    registerHealthStatusRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/health", "none"],
      ["GET", "/w/ws_1/health", "none"],
      ["GET", "/ui", "none"],
      ["GET", "/w/ws_1/ui", "none"],
      ["GET", "/ui/assets/toy.css", "none"],
      ["GET", "/ui/assets/toy.js", "none"],
      ["GET", "/w/ws_1/status", "client"],
      ["GET", "/w/ws_1/capabilities", "client"],
      ["GET", "/w/ws_1/workspaces", "client"],
      ["GET", "/status", "client"],
      ["GET", "/capabilities", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "POST", "/status")).toBeNull();
  });
});
