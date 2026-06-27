import { describe, expect, test } from "bun:test";

import { registerSchedulerRoutes } from "../routes/scheduler.js";
import { matchRoute, type Route } from "../routing.js";

describe("Scheduler workspace routes", () => {
  test("registers the workspace scheduler jobs contract", () => {
    const routes: Route[] = [];
    registerSchedulerRoutes(routes);

    expect(routes).toHaveLength(2);

    const expectedRoutes = [
      ["GET", "/workspace/demo/scheduler/jobs"],
      ["DELETE", "/workspace/demo/scheduler/jobs/nightly-build"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/automations/scheduler/jobs")).toBeNull();
  });
});
