import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalService } from "../approvals.js";
import { ReloadEventStore } from "../events.js";
import { addMcp, listMcp, refreshMcpRuntimeToken, removeMcp } from "../mcp.js";
import { registerMcpRoutes } from "../routes/mcp.js";
import { matchRoute, type Route } from "../routing.js";
import type { ServerConfig } from "../types.js";

describe("MCP routes", () => {
  test("registers the hub and workspace MCP contract", () => {
    const routes: Route[] = [];
    registerMcpRoutes(routes, {
      fetchOpencodeJson: async () => ({}),
    });

    expect(routes).toHaveLength(7);

    const expectedRoutes = [
      ["GET", "/hub/mcp"],
      ["GET", "/workspace/demo/mcp"],
      ["POST", "/workspace/demo/mcp/hub/google-gmail"],
      ["POST", "/workspace/demo/mcp/google-gmail/runtime-token/refresh"],
      ["POST", "/workspace/demo/mcp"],
      ["DELETE", "/workspace/demo/mcp/google-gmail"],
      ["DELETE", "/workspace/demo/mcp/google-gmail/auth"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/extensions/mcp")).toBeNull();
  });

  test("auth and runtime-token routes require an explicit MCP route name", async () => {
    const source = await readFile(new URL("../routes/mcp.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /"\/workspace\/:id\/mcp\/:name\/runtime-token\/refresh"[\s\S]*const name = requireRouteParam\(ctx\.params, "name", "MCP name"\);[\s\S]*validateMcpName\(name\);/,
    );
    expect(source).toMatch(
      /"\/workspace\/:id\/mcp\/:name\/auth"[\s\S]*const name = requireRouteParam\(ctx\.params, "name", "MCP name"\);[\s\S]*validateMcpName\(name\);/,
    );
  });

  test("listMcp ignores future mcp.servers shape instead of listing a fake servers entry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-servers-shape-"));
    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({
          mcp: {
            servers: {
              future: {
                type: "remote",
                url: "https://future.example/mcp",
              },
            },
            current: {
              type: "remote",
              url: "https://current.example/mcp",
            },
          },
        }),
      );

      const items = await listMcp(workspaceRoot);
      const projectNames = items.filter((item) => item.source === "config.project").map((item) => item.name);

      expect(projectNames).toContain("current");
      expect(projectNames).not.toContain("servers");
      expect(items.find((item) => item.name === "current")?.config).toEqual({
        type: "remote",
        url: "https://current.example/mcp",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write paths preserve future mcp.servers while mutating top-level MCP entries", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-servers-preserve-"));
    const configPath = join(workspaceRoot, "opencode.jsonc");
    const futureServers = {
      future: {
        type: "remote",
        url: "https://future.example/mcp",
      },
    };
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mcp: {
            servers: futureServers,
            current: {
              type: "remote",
              url: "https://current.example/mcp",
            },
          },
        }),
      );

      await addMcp(workspaceRoot, "added", {
        type: "remote",
        url: "https://added.example/mcp",
      });
      let config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.added).toEqual({
        type: "remote",
        url: "https://added.example/mcp",
      });

      await refreshMcpRuntimeToken(workspaceRoot, "current", "runtime-token");
      config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.current).toEqual({
        type: "remote",
        url: "https://current.example/mcp",
        headers: {
          "X-Veslo-Connector-Token": "runtime-token",
        },
      });

      expect(await removeMcp(workspaceRoot, "added")).toBe(true);
      config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(config.mcp?.added).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write paths reject reserved servers name before mutating future mcp.servers", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-servers-reserved-"));
    const configPath = join(workspaceRoot, "opencode.jsonc");
    const futureServers = {
      future: {
        type: "remote",
        url: "https://future.example/mcp",
      },
    };
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mcp: {
            servers: futureServers,
          },
        }),
      );

      await expect(addMcp(workspaceRoot, "servers", {
        type: "remote",
        url: "https://overwrite.example/mcp",
      })).rejects.toThrow("MCP name is reserved");

      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(config.mcp?.servers).toEqual(futureServers);
      expect(await listMcp(workspaceRoot)).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("MCP auth logout disconnects Veslo-managed Den providers before OpenCode cleanup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-auth-disconnect-"));
    const denCalls: Array<{ pathname: string; method: string; authHeader: string | null }> = [];
    const denServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        denCalls.push({
          pathname: url.pathname,
          method: request.method,
          authHeader: request.headers.get("authorization"),
        });
        if (url.pathname === "/v1/orgs/org_1/integrations/google/google-gmail/connection") {
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({
          items: [
            {
              id: "google-gmail",
              name: "Google Gmail",
              config: {
                type: "remote",
                url: "https://api.veslo.work/v1/orgs/org_1/integrations/google/google-gmail/mcp",
                oauth: false,
                headers: {
                  "X-Veslo-Connector": "google-gmail",
                },
              },
              authorization: {
                type: "veslo-server-oauth",
                provider: "google",
                connectorId: "google-gmail",
                scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
                startPath: "/v1/orgs/org_1/integrations/google/google-gmail/oauth/start",
                runtimeTokenPath: "/v1/orgs/org_1/integrations/google/google-gmail/runtime-token",
                statusPath: "/v1/orgs/org_1/integrations/google/connections",
                disconnectPath: "/v1/orgs/org_1/integrations/google/google-gmail/connection",
              },
              source: { scope: "platform" },
              provider: { id: "google", group: "Google" },
            },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }) as { port: number; stop: (closeActiveConnections?: boolean) => void };

    try {
      const opencodeCalls: Array<{ path: string; method: string }> = [];
      const routes: Route[] = [];
      registerMcpRoutes(routes, {
        fetchOpencodeJson: async (_workspace, path, init) => {
          opencodeCalls.push({ path, method: init.method });
          return {};
        },
      });
      const route = matchRoute(routes, "DELETE", "/workspace/ws_1/mcp/google-gmail/auth");
      expect(route).not.toBeNull();

      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        token: "client-token",
        hostToken: "host-token",
        approval: { mode: "auto", timeoutMs: 1_000 },
        corsOrigins: ["*"],
        workspaces: [
          {
            id: "ws_1",
            name: "Workspace",
            path: workspaceRoot,
            workspaceType: "local",
          },
        ],
        authorizedRoots: [workspaceRoot],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
        debugLogs: {
          enabled: false,
          ingestUrl: null,
          ingestToken: null,
          batchMaxEvents: 200,
          batchMaxBytes: 256 * 1024,
          spoolMaxBytes: 100 * 1024 * 1024,
          flushIntervalMs: 5000,
        },
        denApiBase: `http://127.0.0.1:${denServer.port}`,
      };
      const request = new Request("http://127.0.0.1/workspace/ws_1/mcp/google-gmail/auth", {
        method: "DELETE",
        headers: {
          "x-veslo-den-api-base": `http://127.0.0.1:${denServer.port}`,
          "x-veslo-den-token": "den-token",
          "x-veslo-den-org-id": "org_1",
        },
      });

      const response = await route!.handler({
        request,
        url: new URL(request.url),
        params: route!.params,
        config,
        approvals: new ApprovalService(config.approval),
        reloadEvents: new ReloadEventStore(),
        tokens: {} as never,
        automationRunner: {} as never,
        actor: { type: "remote", scope: "collaborator" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(denCalls).toEqual([
        {
          pathname: "/v1/orgs/org_1/mcp/catalog",
          method: "GET",
          authHeader: "Bearer den-token",
        },
        {
          pathname: "/v1/orgs/org_1/integrations/google/google-gmail/connection",
          method: "DELETE",
          authHeader: "Bearer den-token",
        },
      ]);
      expect(opencodeCalls).toEqual([
        { path: "/mcp/google-gmail/disconnect", method: "POST" },
        { path: "/mcp/google-gmail/auth", method: "DELETE" },
      ]);
    } finally {
      denServer.stop(true);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("listMcp honors official tools false globs and legacy tools.deny as disabled markers", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-mcp-tools-disabled-"));
    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({
          tools: {
            "github*": false,
            deny: ["mcp.legacy.*"],
          },
          mcp: {
            github: {
              type: "remote",
              url: "https://github.example/mcp",
            },
            legacy: {
              type: "remote",
              url: "https://legacy.example/mcp",
            },
            active: {
              type: "remote",
              url: "https://active.example/mcp",
            },
          },
        }),
      );

      const byName = new Map((await listMcp(workspaceRoot)).map((item) => [item.name, item]));

      expect(byName.get("github")?.disabledByTools).toBe(true);
      expect(byName.get("legacy")?.disabledByTools).toBe(true);
      expect(byName.get("active")?.disabledByTools).toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
