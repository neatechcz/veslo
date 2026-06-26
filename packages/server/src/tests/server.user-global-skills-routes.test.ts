import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerUserGlobalSkillRoutes } from "../routes/user-global-skills.js";

describe("User-global skill routes", () => {
  test("registers the user-global skill contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerUserGlobalSkillRoutes>[1];

    registerUserGlobalSkillRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string]> = [
      ["GET", "/skills/user-global-store"],
      ["GET", "/skills/user-global-store/helper"],
      ["POST", "/skills/user-global-store"],
      ["DELETE", "/skills/user-global-store/helper"],
      ["GET", "/skills/user-global/helper"],
      ["DELETE", "/skills/user-global/helper"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [method, path] of expectedRoutes) {
      expect(matchRoute(routes, method, path)).not.toBeNull();
    }

    expect(matchRoute(routes, "PATCH", "/skills/user-global-store/helper")).toBeNull();
  });
});
