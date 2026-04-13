import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "./server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore cleanup errors in tests
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startFixture(input: { denApiBase?: string } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-hub-mcp-route-"));
  tempDirs.push(workspaceRoot);

  const server = startServer({
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
    },
    denApiBase: input.denApiBase,
  });

  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server, workspaceRoot };
}

test("GET /hub/mcp returns 401 when den token header is missing", async () => {
  const { server } = await startFixture({ denApiBase: "https://den.example" });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/mcp`, {
    headers: {
      Authorization: "Bearer client-token",
    },
  });

  expect(response.status).toBe(401);
  const payload = await response.json() as { code: string };
  expect(payload.code).toBe("den_token_required");
});

test("GET /hub/mcp returns items from den org catalog", async () => {
  const denCalls: Array<{ pathname: string; authHeader: string | null }> = [];
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      denCalls.push({
        pathname: url.pathname,
        authHeader: request.headers.get("authorization"),
      });

      return new Response(JSON.stringify({
        items: [
          {
            id: "demo",
            name: "Demo MCP",
            description: "Org-scoped demo MCP.",
            config: {
              type: "remote",
              url: "https://mcp.example.test/demo",
              oauth: true,
            },
            source: {
              scope: "org",
              orgId: "org_1",
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/mcp`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    items: Array<{ id: string; name: string; config: { type: string; url?: string; oauth?: boolean } }>;
  };
  expect(payload.items).toEqual([
    {
      id: "demo",
      name: "Demo MCP",
      description: "Org-scoped demo MCP.",
      config: {
        type: "remote",
        url: "https://mcp.example.test/demo",
        oauth: true,
      },
      source: {
        scope: "org",
        orgId: "org_1",
      },
    },
  ]);
  expect(denCalls).toEqual([
    {
      pathname: "/v1/orgs/org_1/mcp/catalog",
      authHeader: "Bearer den-token",
    },
  ]);
});

test("GET /capabilities exposes hub mcp access without repo metadata", async () => {
  const { server } = await startFixture({ denApiBase: "https://den.example" });

  const response = await fetch(`http://127.0.0.1:${server.port}/capabilities`, {
    headers: {
      Authorization: "Bearer client-token",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    hub?: {
      mcp?: {
        read: boolean;
        install: boolean;
        repo?: unknown;
      };
    };
  };
  expect(payload.hub?.mcp).toEqual({
    read: true,
    install: true,
  });
  expect(payload.hub?.mcp?.repo).toBeUndefined();
});

test("POST /workspace/:id/mcp/hub/:name installs catalog MCP config", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "demo",
            name: "Demo MCP",
            description: "Org-scoped demo MCP.",
            config: {
              type: "remote",
              url: "https://mcp.example.test/demo",
              oauth: true,
            },
            source: {
              scope: "org",
              orgId: "org_1",
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server, workspaceRoot } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/demo`, {
    method: "POST",
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { ok: boolean; name: string; action: "added" | "updated" };
  expect(payload.ok).toBe(true);
  expect(payload.name).toBe("demo");
  expect(payload.action).toBe("added");

  const configRaw = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
  expect(configRaw).toContain("\"demo\"");
  expect(configRaw).toContain("https://mcp.example.test/demo");
});
