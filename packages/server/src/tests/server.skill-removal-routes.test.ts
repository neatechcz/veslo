import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillRemovalRoutes } from "../routes/skill-removals.js";

describe("Skill removal routes", () => {
  test("registers the skill removal workflow contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillRemovalRoutes>[1];

    registerSkillRemovalRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skill-removals", "hostOrClient"],
      ["POST", "/skill-removals/removal-1/restore", "host"],
      ["POST", "/skills/batch-remove", "host"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "DELETE", "/skill-removals/removal-1")).toBeNull();
  });
});
