import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillImportRoutes } from "../routes/skill-imports.js";

describe("Skill import routes", () => {
  test("registers the import candidate contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillImportRoutes>[1];

    registerSkillImportRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skills/import-candidates", "client"],
      ["POST", "/skills/import-candidates/import", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "DELETE", "/skills/import-candidates")).toBeNull();
  });
});
