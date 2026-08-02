import { describe, expect, test } from "bun:test";
import { matchRoute, type RequestContext, type Route } from "../routing.js";
import {
  registerWorkspaceManagementRoutes,
  type WorkspaceManagementRouteDependencies,
} from "../routes/workspace-management.js";

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
      ["POST", "/workspace/ws_1/runtime-operations/control-plane-rebind", "client"],
      ["POST", "/workspace/ws_1/runtime-operations/operation-1/begin", "client"],
      ["POST", "/workspace/ws_1/runtime-operations/operation-1/complete", "client"],
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

  test("control-plane rebind uses a server-created operation lease and exposes begin and completion", async () => {
    const routes: Route[] = [];
    const calls: string[] = [];
    const operation = {
      workspaceId: "ws_1",
      operationId: "server-operation",
      kind: "rebind_control_plane" as const,
      sourceClass: "automatic" as const,
      reasonCode: "sse_invalid_bearer",
      state: "granted" as const,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      terminalCode: null,
    };
    registerWorkspaceManagementRoutes(routes, {
      requestWorkspaceRuntimeOperation: async (
        input: Parameters<WorkspaceManagementRouteDependencies["requestWorkspaceRuntimeOperation"]>[0],
      ) => {
        calls.push(`request:${input.workspaceId}:${input.kind}:${input.reasonCode}`);
        expect(input.operationId).toEqual(expect.any(String));
        return { kind: "granted", operation };
      },
      beginWorkspaceRuntimeOperation: async (
        workspaceId: string,
        operationId: string,
      ) => {
        calls.push(`begin:${workspaceId}:${operationId}`);
        return { ...operation, state: "executing" as const };
      },
      completeWorkspaceRuntimeOperation: async (
        input: Parameters<WorkspaceManagementRouteDependencies["completeWorkspaceRuntimeOperation"]>[0],
      ) => {
        calls.push(`complete:${input.workspaceId}:${input.operationId}:${input.state}`);
        return { ...operation, state: input.state, terminalCode: input.terminalCode ?? null };
      },
    } as unknown as Parameters<typeof registerWorkspaceManagementRoutes>[1]);

    const config = {
      authorizedRoots: ["/repo"],
      workspaces: [{ id: "ws_1", path: "/repo", workspaceType: "local" }],
    };
    const contextFor = (request: Request, route: { params: Record<string, string> }): RequestContext => ({
      request,
      url: new URL(request.url),
      params: route.params,
      config,
      actor: { type: "remote", scope: "collaborator" },
    } as RequestContext);

    const requestRoute = matchRoute(routes, "POST", "/workspace/ws_1/runtime-operations/control-plane-rebind");
    expect(requestRoute).not.toBeNull();
    const request = new Request("http://127.0.0.1/workspace/ws_1/runtime-operations/control-plane-rebind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasonCode: "server_submit_transport" }),
    });
    expect(await (await requestRoute!.handler(contextFor(request, requestRoute!))).json()).toEqual({ ok: true, operation });

    const beginRoute = matchRoute(routes, "POST", "/workspace/ws_1/runtime-operations/server-operation/begin");
    const beginRequest = new Request("http://127.0.0.1/workspace/ws_1/runtime-operations/server-operation/begin", { method: "POST" });
    expect((await (await beginRoute!.handler(contextFor(beginRequest, beginRoute!))).json()).operation.state).toBe("executing");

    const completeRoute = matchRoute(routes, "POST", "/workspace/ws_1/runtime-operations/server-operation/complete");
    const completeRequest = new Request("http://127.0.0.1/workspace/ws_1/runtime-operations/server-operation/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "completed", terminalCode: "rebound" }),
    });
    expect((await (await completeRoute!.handler(contextFor(completeRequest, completeRoute!))).json()).operation).toEqual(
      expect.objectContaining({ state: "completed", terminalCode: "rebound" }),
    );
    expect(calls).toEqual([
      "request:ws_1:rebind_control_plane:server_submit_transport",
      "begin:ws_1:server-operation",
      "complete:ws_1:server-operation:completed",
    ]);
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
