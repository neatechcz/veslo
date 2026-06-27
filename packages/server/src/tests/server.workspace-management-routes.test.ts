import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerWorkspaceManagementRoutes } from "../routes/workspace-management.js";

describe("Workspace management routes", () => {
  test("registers workspace list, config, system, events, and import/export endpoints", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerWorkspaceManagementRoutes>[1];

    registerWorkspaceManagementRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/workspaces", "client"],
      ["POST", "/workspaces/local", "host"],
      ["PATCH", "/workspaces/ws_1", "host"],
      ["POST", "/workspaces/ws_1/activate", "host"],
      ["DELETE", "/workspaces/ws_1", "host"],
      ["GET", "/workspace/ws_1/config", "client"],
      ["POST", "/workspace/ws_1/system/provision", "client"],
      ["GET", "/workspace/ws_1/audit", "client"],
      ["PATCH", "/workspace/ws_1/config", "client"],
      ["GET", "/workspace/ws_1/events", "client"],
      ["POST", "/workspace/ws_1/engine/reload", "client"],
      ["GET", "/workspace/ws_1/export", "client"],
      ["POST", "/workspace/ws_1/import", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "POST", "/workspaces/ws_1")).toBeNull();
  });
});
