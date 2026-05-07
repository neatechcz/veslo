import { mkdtemp, rm } from "node:fs/promises";
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-hub-skills-route-"));
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
  return server;
}

test("GET /hub/skills returns 401 when den token header is missing", async () => {
  const server = await startFixture({ denApiBase: "https://den.example" });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/skills`, {
    headers: {
      Authorization: "Bearer client-token",
    },
  });

  expect(response.status).toBe(401);
  const payload = await response.json() as { code: string };
  expect(payload.code).toBe("den_token_required");
});

test("GET /hub/skills returns 400 when den org id header is missing", async () => {
  const server = await startFixture({ denApiBase: "https://den.example" });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/skills`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
    },
  });

  expect(response.status).toBe(400);
  const payload = await response.json() as { code: string };
  expect(payload.code).toBe("den_org_required");
});

test("GET /hub/skills returns items from den org catalog", async () => {
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

      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const server = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/skills`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: unknown[] };
  expect(payload).toEqual({ items: [] });
  expect(denCalls).toEqual([
    {
      pathname: "/v1/orgs/org_1/skills/catalog",
      authHeader: "Bearer den-token",
    },
  ]);
});

test("GET /hub/skills returns empty org catalog when den base URL is not configured", async () => {
  const server = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/skills`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: unknown[] };
  expect(payload).toEqual({ items: [] });
});

test("GET /capabilities does not expose hub repo metadata", async () => {
  const server = await startFixture({ denApiBase: "https://den.example" });

  const response = await fetch(`http://127.0.0.1:${server.port}/capabilities`, {
    headers: {
      Authorization: "Bearer client-token",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    hub?: {
      skills?: {
        read: boolean;
        install: boolean;
        repo?: unknown;
      };
    };
  };
  expect(payload.hub?.skills?.repo).toBeUndefined();
});
