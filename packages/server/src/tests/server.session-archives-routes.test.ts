import { describe, expect, test } from "bun:test";

import { ApiError } from "../errors.js";
import { registerSessionArchiveRoutes } from "../routes/session-archives.js";
import { matchRoute, type RequestContext, type Route } from "../routing.js";

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

  test("requires collaborator scope for archive reads and mutations", async () => {
    const routes: Route[] = [];
    registerSessionArchiveRoutes(routes, {
      resolveArchiveOwnerKey: () => "account-1",
      sessionArchives: {
        list: async () => [],
        put: async () => [],
        delete: async () => [],
      },
    });

    for (const [method, path] of [
      ["GET", "/session-archives"],
      ["PUT", "/session-archives/session-a"],
      ["DELETE", "/session-archives/session-a"],
    ] as const) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      let caught: unknown;
      try {
        await route!.handler({
          request: new Request(`https://veslo.example${path}`, { method }),
          url: new URL(`https://veslo.example${path}`),
          params: route!.params,
          config: { readOnly: false },
          actor: { type: "remote", scope: "viewer" },
        } as RequestContext);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({ status: 403, code: "forbidden" });
    }
  });
});
