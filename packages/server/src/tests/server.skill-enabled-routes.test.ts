import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillEnabledRoutes } from "../routes/skill-enabled.js";

describe("Skill enabled routes", () => {
  test("registers the skill enabled-state contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillEnabledRoutes>[1];

    registerSkillEnabledRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skills/disabled", "client"],
      ["PATCH", "/skills/enabled-state", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }
    expect(matchRoute(routes, "POST", "/skills/enabled-state")).toBeNull();
  });
});
