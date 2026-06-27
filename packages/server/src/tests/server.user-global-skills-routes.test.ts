import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerUserGlobalSkillRoutes } from "../routes/user-global-skills.js";

describe("User-global skill routes", () => {
  test("registers the user-global skill contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerUserGlobalSkillRoutes>[1];

    registerUserGlobalSkillRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skills/user-global-store", "client"],
      ["GET", "/skills/user-global-store/helper", "client"],
      ["POST", "/skills/user-global-store", "client"],
      ["DELETE", "/skills/user-global-store/helper", "client"],
      ["GET", "/skills/user-global/helper", "none"],
      ["DELETE", "/skills/user-global/helper", "none"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "PATCH", "/skills/user-global-store/helper")).toBeNull();
  });
});
