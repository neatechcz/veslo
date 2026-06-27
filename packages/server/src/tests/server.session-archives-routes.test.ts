import { describe, expect, test } from "bun:test";

import { registerSessionArchiveRoutes } from "../routes/session-archives.js";
import { matchRoute, type Route } from "../routing.js";

describe("Session archive routes", () => {
  test("registers the session archive contract", () => {
    const routes: Route[] = [];
    registerSessionArchiveRoutes(routes, {
      resolveArchiveOwnerKey: () => "account-1",
      sessionArchives: {
        list: async () => [],
        put: async () => [],
        delete: async () => [],
      },
    });

    expect(routes).toHaveLength(3);

    const expectedRoutes = [
      ["GET", "/session-archives"],
      ["PUT", "/session-archives/session-a"],
      ["DELETE", "/session-archives/session-a"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/session-archives")).toBeNull();
  });
});
