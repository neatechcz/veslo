import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerWorkspaceSkillRoutes } from "../routes/workspace-skills.js";

describe("Workspace skill routes", () => {
  test("registers the workspace skill runtime contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerWorkspaceSkillRoutes>[1];

    registerWorkspaceSkillRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/hub/skills", "client"],
      ["GET", "/workspace/ws_1/skills", "client"],
      ["POST", "/workspace/ws_1/skills/runtime-view", "client"],
      ["POST", "/workspace/ws_1/skills/resolve", "client"],
      ["POST", "/workspace/ws_1/skills/hub/example-skill", "client"],
      ["GET", "/workspace/ws_1/skills/example-skill", "client"],
      ["GET", "/workspace/ws_1/skills/example-skill/files", "client"],
      ["POST", "/workspace/ws_1/skills", "client"],
      ["DELETE", "/workspace/ws_1/skills/example-skill", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "PATCH", "/workspace/ws_1/skills/example-skill")).toBeNull();
  });
});
