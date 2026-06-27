import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillRegistryRoutes } from "../routes/skill-registry.js";

describe("Skill registry routes", () => {
  test("registers the skill registry proxy contract", () => {
    const routes: Route[] = [];

    registerSkillRegistryRoutes(routes);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["POST", "/v1/skills", "host"],
      ["GET", "/v1/skills/skill-1/versions", "client"],
      ["POST", "/v1/skills/skill-1/versions", "host"],
      ["POST", "/v1/skills/skill-1/review-requests", "host"],
      ["POST", "/v1/skill-review-requests/review-1/approve", "host"],
      ["POST", "/v1/skill-review-requests/review-1/reject", "host"],
      ["POST", "/v1/skill-installations", "host"],
      ["PATCH", "/v1/skill-installations/install-1", "host"],
      ["DELETE", "/v1/skill-installations/install-1", "host"],
      ["POST", "/v1/skill-installations/install-1/restore", "host"],
      ["PATCH", "/v1/workspaces/workspace-1/skill-set", "host"],
      ["GET", "/v1/skill-rollout-policies", "client"],
      ["POST", "/v1/skill-rollout-policies", "host"],
      ["PATCH", "/v1/skill-rollout-policies/policy-1", "host"],
      ["DELETE", "/v1/skill-rollout-policies/policy-1", "host"],
      ["GET", "/v1/skills/search", "client"],
      ["GET", "/v1/skill-registry-events", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "GET", "/v1/skill-installations/install-1")).toBeNull();
  });
});
