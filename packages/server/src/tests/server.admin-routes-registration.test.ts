import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerAdminRoutes } from "../routes/admin.js";

describe("Admin routes", () => {
  test("registers token, identity, and approval endpoints", () => {
    const routes: Route[] = [];

    registerAdminRoutes(routes);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/tokens", "host"],
      ["POST", "/tokens", "host"],
      ["DELETE", "/tokens/token-1", "host"],
      ["GET", "/whoami", "client"],
      ["GET", "/approvals", "host"],
      ["POST", "/approvals/approval-1", "host"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "PATCH", "/tokens/token-1")).toBeNull();
  });
});
