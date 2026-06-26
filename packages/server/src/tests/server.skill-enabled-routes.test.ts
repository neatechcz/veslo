import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillEnabledRoutes } from "../routes/skill-enabled.js";

describe("Skill enabled routes", () => {
  test("registers the skill enabled-state contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillEnabledRoutes>[1];

    registerSkillEnabledRoutes(routes, dependencies);

    expect(routes).toHaveLength(2);
    expect(matchRoute(routes, "GET", "/skills/disabled")).not.toBeNull();
    expect(matchRoute(routes, "PATCH", "/skills/enabled-state")).not.toBeNull();
    expect(matchRoute(routes, "POST", "/skills/enabled-state")).toBeNull();
  });
});
