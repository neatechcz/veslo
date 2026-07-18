import { describe, expect, test } from "bun:test";
import { matchRoute, type RequestContext, type Route } from "../routing.js";
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

  test("guarded engine reload returns reload_blocked_active_runs without reloading", async () => {
    const routes: Route[] = [];
    let reloadCalled = false;
    let guardedReloadCalled = false;
    registerWorkspaceManagementRoutes(routes, {
      reloadOpencodeEngine: async () => {
        reloadCalled = true;
      },
      reloadWorkspaceEngineIfIdle: async ({ workspaceId }: {
        workspaceId: string;
        reload: () => Promise<void>;
      }) => {
        guardedReloadCalled = true;
        expect(workspaceId).toBe("ws_1");
        return { kind: "blocked", reason: "active-runs" };
      },
    } as unknown as Parameters<typeof registerWorkspaceManagementRoutes>[1]);

    const route = matchRoute(routes, "POST", "/workspace/ws_1/engine/reload");
    expect(route).not.toBeNull();
    const request = new Request("http://127.0.0.1/workspace/ws_1/engine/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ifIdle: true }),
    });

    await expect(route!.handler({
      request,
      url: new URL(request.url),
      params: route!.params,
      config: {
        authorizedRoots: ["/repo"],
        workspaces: [{ id: "ws_1", path: "/repo", workspaceType: "local" }],
      },
      actor: { type: "remote", scope: "collaborator" },
    } as RequestContext)).rejects.toMatchObject({
      status: 409,
      code: "reload_blocked_active_runs",
      details: { workspaceId: "ws_1", reason: "active-runs" },
    });
    expect(guardedReloadCalled).toBe(true);
    expect(reloadCalled).toBe(false);
  });
});
