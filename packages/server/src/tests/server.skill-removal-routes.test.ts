import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillRemovalRoutes } from "../routes/skill-removals.js";

describe("Skill removal routes", () => {
  test("registers the skill removal workflow contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillRemovalRoutes>[1];

    registerSkillRemovalRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string]> = [
      ["GET", "/skill-removals"],
      ["POST", "/skill-removals/removal-1/restore"],
      ["POST", "/skills/batch-remove"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [method, path] of expectedRoutes) {
      expect(matchRoute(routes, method, path)).not.toBeNull();
    }

    expect(matchRoute(routes, "DELETE", "/skill-removals/removal-1")).toBeNull();
  });
});
