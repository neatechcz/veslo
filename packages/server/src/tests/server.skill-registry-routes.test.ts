import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillRegistryRoutes } from "../routes/skill-registry.js";

describe("Skill registry routes", () => {
  test("registers the skill registry proxy contract", () => {
    const routes: Route[] = [];

    registerSkillRegistryRoutes(routes);

    const expectedRoutes: Array<[string, string]> = [
      ["POST", "/v1/skills"],
      ["GET", "/v1/skills/skill-1/versions"],
      ["POST", "/v1/skills/skill-1/versions"],
      ["POST", "/v1/skills/skill-1/review-requests"],
      ["POST", "/v1/skill-review-requests/review-1/approve"],
      ["POST", "/v1/skill-review-requests/review-1/reject"],
      ["POST", "/v1/skill-installations"],
      ["PATCH", "/v1/skill-installations/install-1"],
      ["DELETE", "/v1/skill-installations/install-1"],
      ["POST", "/v1/skill-installations/install-1/restore"],
      ["PATCH", "/v1/workspaces/workspace-1/skill-set"],
      ["GET", "/v1/skill-rollout-policies"],
      ["POST", "/v1/skill-rollout-policies"],
      ["PATCH", "/v1/skill-rollout-policies/policy-1"],
      ["DELETE", "/v1/skill-rollout-policies/policy-1"],
      ["GET", "/v1/skills/search"],
      ["GET", "/v1/skill-registry-events"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [method, path] of expectedRoutes) {
      expect(matchRoute(routes, method, path)).not.toBeNull();
    }

    expect(matchRoute(routes, "GET", "/v1/skill-installations/install-1")).toBeNull();
  });
});
