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

test("GET /hub/mcp accepts platform Google MCP entries with server OAuth metadata", async () => {
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
              scopes: [
                "https://www.googleapis.com/auth/gmail.readonly",
                "https://www.googleapis.com/auth/gmail.compose",
              ],
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
  expect(payload.items[0].config.oauth).toBe(false);
  expect(payload.items[0].config.headers).toEqual({ "X-Veslo-Connector": "google-gmail" });
  expect(payload.items[0].authorization.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  expect(payload.items[0].authorization.runtimeTokenPath).toBe("/v1/orgs/org_1/integrations/google/google-gmail/runtime-token");
  expect(JSON.stringify(payload)).not.toContain("VESLO_GOOGLE_MCP_CLIENT_SECRET");
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

test("POST /workspace/:id/mcp/hub/:name preserves Veslo connector headers without Google OAuth secrets", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/orgs/org_1/integrations/google/google-gmail/runtime-token") {
        return new Response(JSON.stringify({
          token: "runtime-token-123",
          expiresAt: "2030-06-19T12:00:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
                scopes: [
                  "https://www.googleapis.com/auth/gmail.readonly",
                  "https://www.googleapis.com/auth/gmail.compose",
                ],
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
  expect(configRaw).toContain("https://api.veslo.work/v1/orgs/org_1/integrations/google/google-gmail/mcp");
  expect(configRaw).toContain("\"oauth\": false");
  expect(configRaw).toContain("\"X-Veslo-Connector\": \"google-gmail\"");
  expect(configRaw).toContain("\"X-Veslo-Connector-Token\": \"runtime-token-123\"");
  expect(configRaw).not.toContain("VESLO_GOOGLE_MCP_CLIENT_ID");
  expect(configRaw).not.toContain("VESLO_GOOGLE_MCP_CLIENT_SECRET");
  expect(configRaw).not.toContain("clientSecret");
});

test("POST /workspace/:id/mcp/hub/:name installs SharePoint MCP with runtime token headers only", async () => {
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

      if (url.pathname === "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token") {
        return new Response(JSON.stringify({
          token: "runtime-token-sharepoint-1",
          expiresAt: "2030-06-19T12:00:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
          items: [
            {
              id: "microsoft-sharepoint",
              name: "Microsoft SharePoint",
              config: {
                type: "remote",
                url: "https://api.veslo.work/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/mcp",
                oauth: false,
                headers: {
                  "X-Veslo-Connector": "microsoft-sharepoint",
                },
              },
              authorization: {
                type: "veslo-server-oauth",
                provider: "microsoft",
                connectorId: "microsoft-sharepoint",
                scopes: [
                  "openid",
                  "profile",
                  "offline_access",
                  "https://graph.microsoft.com/Files.Read.All",
                  "https://graph.microsoft.com/Sites.Read.All",
                ],
                startPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start",
                runtimeTokenPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token",
                statusPath: "/v1/orgs/org_1/integrations/microsoft/connections",
                disconnectPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/connection",
              },
              source: { scope: "platform" },
              provider: { id: "microsoft", group: "Microsoft" },
            },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    },
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server, workspaceRoot } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/microsoft-sharepoint`, {
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
  expect(configRaw).toContain("\"microsoft-sharepoint\"");
  expect(configRaw).toContain("https://api.veslo.work/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/mcp");
  expect(configRaw).toContain("\"oauth\": false");
  expect(configRaw).toContain("\"X-Veslo-Connector\": \"microsoft-sharepoint\"");
  expect(configRaw).toContain("\"X-Veslo-Connector-Token\": \"runtime-token-sharepoint-1\"");
  expect(configRaw).not.toContain("MICROSOFT_CLIENT_SECRET");
  expect(configRaw).not.toContain("MICROSOFT_ACCESS_TOKEN");
  expect(configRaw).not.toContain("MICROSOFT_REFRESH_TOKEN");
  expect(configRaw).not.toContain("VESLO_MICROSOFT_MCP_CLIENT_SECRET");
  expect(configRaw).not.toContain("access_token");
  expect(configRaw).not.toContain("refresh_token");
  expect(configRaw).not.toContain("accessToken");
  expect(configRaw).not.toContain("refreshToken");
  expect(configRaw).not.toContain("clientSecret");
  expect(configRaw).not.toContain("client_secret");
  expect(denCalls).toEqual([
    {
      pathname: "/v1/orgs/org_1/mcp/catalog",
      method: "GET",
      authHeader: "Bearer den-token",
    },
    {
      pathname: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token",
      method: "POST",
      authHeader: "Bearer den-token",
    },
  ]);
});

test("POST /workspace/:id/mcp/:name/runtime-token/refresh rotates Veslo connector token", async () => {
  let runtimeTokenCalls = 0;
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/orgs/org_1/integrations/google/google-gmail/runtime-token") {
        runtimeTokenCalls += 1;
        return new Response(JSON.stringify({
          token: `runtime-token-${runtimeTokenCalls}`,
          expiresAt: "2030-06-19T12:00:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server, workspaceRoot } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });
  const authHeaders = {
    Authorization: "Bearer client-token",
    "x-veslo-den-token": "den-token",
    "x-veslo-den-org-id": "org_1",
  };

  const installResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/google-gmail`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  expect(installResponse.status).toBe(200);

  const refreshResponse = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_1/mcp/google-gmail/runtime-token/refresh`,
    {
      method: "POST",
      headers: authHeaders,
    },
  );

  expect(refreshResponse.status).toBe(200);
  const payload = await refreshResponse.json() as { ok: boolean; name: string; action: string; expiresAt: string };
  expect(payload).toEqual({
    ok: true,
    name: "google-gmail",
    action: "updated",
    expiresAt: "2030-06-19T12:00:00.000Z",
  });
  expect(runtimeTokenCalls).toBe(2);

  const configRaw = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
  expect(configRaw).toContain("\"X-Veslo-Connector\": \"google-gmail\"");
  expect(configRaw).toContain("\"X-Veslo-Connector-Token\": \"runtime-token-2\"");
  expect(configRaw).not.toContain("runtime-token-1");
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
