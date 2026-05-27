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
      // ignore cleanup errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

async function startFixture(registryBaseUrl?: string) {
  const workspaceRoot = await tempDir("veslo-skill-registry-search-");
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
    denApiBase: registryBaseUrl,
    skillRegistryBaseUrl: registryBaseUrl,
    skillRegistryToken: "registry-token",
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return server;
}

test("GET /v1/skills/search proxies registry search through server validation", async () => {
  const registryCalls: Array<{ url: string; auth: string | null; org: string | null; user: string | null }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
      });
      return Response.json({
        query: "agent workflows",
        skills: [
          {
            id: "skill_research",
            slug: "research",
            name: "research",
            visibility: "organization",
            reviewStatus: "approved",
            createdAt: "2026-05-26T10:00:00.000Z",
            updatedAt: "2026-05-26T10:01:00.000Z",
            latestVersion: {
              id: "version_1",
              version: "1.0.0",
              packageSha256: "a".repeat(64),
              createdAt: "2026-05-26T10:00:00.000Z",
            },
          },
        ],
        nextCursor: null,
      });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/v1/skills/search?q=agent+workflows&workspaceId=ws_1&ownerScope=org&reviewStatus=approved&includeDeleted=true&language=cs&cursor=next%2Fcursor&limit=25`,
    {
      headers: {
        Authorization: "Bearer client-token",
        "x-veslo-den-org-id": "org_1",
        "x-veslo-den-user-id": "user_1",
      },
    },
  );

  expect(response.status).toBe(200);
  const payload = await response.json() as { query: string; skills: unknown[] };
  expect(payload.query).toBe("agent workflows");
  expect(payload.skills).toEqual([
    {
      id: "skill_research",
      slug: "research",
      name: "research",
      visibility: "organization",
      reviewStatus: "approved",
      createdAt: "2026-05-26T10:00:00.000Z",
      updatedAt: "2026-05-26T10:01:00.000Z",
      latestVersion: {
        id: "version_1",
        version: "1.0.0",
        packageSha256: "a".repeat(64),
        createdAt: "2026-05-26T10:00:00.000Z",
      },
    },
  ]);
  expect(registryCalls).toEqual([
    {
      url: "/v1/skills/search?q=agent+workflows&cursor=next%2Fcursor&limit=25&workspaceId=ws_1&ownerScope=org&reviewStatus=approved&includeDeleted=true&language=cs",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
    },
  ]);
});

test("GET /v1/skills/search returns an empty result when registry is not configured", async () => {
  const server = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/v1/skills/search?q=agent`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ query: "agent", skills: [], nextCursor: null, registryConfigured: false });
});

test("GET /v1/skill-registry-events proxies ordered registry events", async () => {
  const registryCalls: Array<{ url: string; auth: string | null; org: string | null }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
      });
      return Response.json({
        events: [
          {
            id: "evt_1",
            action: "skill.version.created",
            orgId: "org_1",
            workspaceId: "ws_1",
            skillId: "skill_1",
            versionId: "version_1",
            installationId: "installation_1",
            actorUserId: "user_1",
            payload: { name: "research" },
            createdAt: "2026-05-27T10:00:00.000Z",
          },
        ],
        nextCursor: "cursor_2",
        revision: "revision_2",
      });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-registry-events?orgId=org_1&workspaceId=ws_1&cursor=cursor_1&limit=50`,
    {
      headers: {
        Authorization: "Bearer client-token",
        "x-veslo-den-org-id": "org_1",
      },
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    events: [
      {
        id: "evt_1",
        action: "skill.version.created",
        orgId: "org_1",
        workspaceId: "ws_1",
        skillId: "skill_1",
        versionId: "version_1",
        installationId: "installation_1",
        actorUserId: "user_1",
        payload: { name: "research" },
        createdAt: "2026-05-27T10:00:00.000Z",
      },
    ],
    nextCursor: "cursor_2",
    revision: "revision_2",
  });
  expect(registryCalls).toEqual([
    {
      url: "/v1/skill-registry-events?cursor=cursor_1&limit=50&orgId=org_1&workspaceId=ws_1",
      auth: "Bearer registry-token",
      org: "org_1",
    },
  ]);
});

test("GET /v1/skill-registry-events returns empty events when registry is not configured", async () => {
  const server = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/v1/skill-registry-events?limit=25`, {
    headers: { Authorization: "Bearer client-token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    events: [],
    nextCursor: null,
    revision: null,
    registryConfigured: false,
  });
});
