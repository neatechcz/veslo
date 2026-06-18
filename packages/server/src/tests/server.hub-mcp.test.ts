import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "../server.js";

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
      flushIntervalMs: 5000,
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
    items: Array<{
      id: string;
      name: string;
      description?: string;
      config: { type: string; url?: string; oauth?: boolean };
      source?: { scope: string; orgId?: string };
    }>;
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

test("GET /hub/mcp accepts platform Google MCP entries with OAuth config", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "google-gmail",
            name: "Google Gmail",
            description: "Search Gmail.",
            config: {
              type: "remote",
              url: "https://gmailmcp.googleapis.com/mcp/v1",
              oauth: {
                clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
                clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
                scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
              },
            },
            source: { scope: "platform" },
            provider: { id: "google", group: "Google" },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
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
  const payload = await response.json() as { items: Array<any> };
  expect(payload.items[0].source.scope).toBe("platform");
  expect(payload.items[0].provider).toEqual({ id: "google", group: "Google" });
  expect(payload.items[0].config.oauth.scope).toContain("gmail.readonly");
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

test("POST /workspace/:id/mcp/hub/:name preserves Google OAuth object", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "google-gmail",
            name: "Google Gmail",
            config: {
              type: "remote",
              url: "https://gmailmcp.googleapis.com/mcp/v1",
              oauth: {
                clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
                clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
                scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
              },
            },
            source: { scope: "platform" },
            provider: { id: "google", group: "Google" },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server, workspaceRoot } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/google-gmail`, {
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
  const configRaw = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
  expect(configRaw).toContain("\"google-gmail\"");
  expect(configRaw).toContain("\"clientId\": \"{env:VESLO_GOOGLE_MCP_CLIENT_ID}\"");
  expect(configRaw).toContain("\"clientSecret\": \"{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}\"");
  expect(configRaw).toContain("gmail.readonly");
});

test("POST /workspace/:id/mcp/hub/:name preserves oauth false in config", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "no-auth-demo",
            name: "No Auth Demo",
            description: "Remote MCP without OAuth.",
            config: {
              type: "remote",
              url: "https://mcp.example.test/no-auth",
              oauth: false,
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

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/no-auth-demo`, {
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
  const configRaw = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
  expect(configRaw).toContain("\"no-auth-demo\"");
  expect(configRaw).toContain("https://mcp.example.test/no-auth");
  expect(configRaw).toContain("\"oauth\": false");
});
