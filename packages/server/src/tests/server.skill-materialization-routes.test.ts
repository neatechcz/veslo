import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillMaterializationRoutes } from "../routes/skill-materialization.js";

describe("Skill materialization routes", () => {
  test("registers the skill materialization workflow contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillMaterializationRoutes>[1];

    registerSkillMaterializationRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skills/materialization", "client"],
      ["POST", "/skills/materialization/sync-global", "host"],
      ["GET", "/workspace/ws_1/skills/materialization", "client"],
      ["POST", "/workspace/ws_1/skills/user-global-store/sync", "client"],
      ["POST", "/workspace/ws_1/skills/materialization/sync", "host"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "DELETE", "/skills/materialization")).toBeNull();
  });
});
