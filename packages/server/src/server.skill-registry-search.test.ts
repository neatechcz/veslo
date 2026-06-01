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

test("host registry mutations proxy create skill, version, and installation", async () => {
  const registryCalls: Array<{
    method: string;
    url: string;
    auth: string | null;
    org: string | null;
    user: string | null;
    body: unknown;
  }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await request.json();
      registryCalls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
        body,
      });

      if (request.method === "POST" && url.pathname === "/v1/skills") {
        return Response.json({
          skill: {
            id: "skill_demo",
            slug: "demo",
            name: "demo",
            visibility: "workspace",
            reviewStatus: "draft",
            createdAt: "2026-05-26T10:00:00.000Z",
            updatedAt: "2026-05-26T10:01:00.000Z",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/skills/skill_demo/versions") {
        return Response.json({
          version: {
            id: "version_1",
            version: "1.0.0",
            packageSha256: "a".repeat(64),
            createdAt: "2026-05-26T10:02:00.000Z",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/skill-installations") {
        return Response.json({
          installation: {
            installationId: "installation_1",
            skillId: "skill_demo",
            versionId: "version_1",
            enabled: true,
            source: "workspace",
            installedAt: "2026-05-26T10:03:00.000Z",
            workspaceId: "ws_1",
          },
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);
  const headers = {
    "Content-Type": "application/json",
    "X-Veslo-Host-Token": "host-token",
    "x-veslo-den-org-id": "org_1",
    "x-veslo-den-user-id": "user_1",
  };

  const skillResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skills`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: "workspace",
      name: "demo",
      displayName: "Demo",
      description: "Demo skill",
      workspaceId: "ws_1",
    }),
  });
  const versionResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skills/skill_demo/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ package: { schemaVersion: 1, entrypoint: "SKILL.md" } }),
  });
  const installationResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skill-installations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: "workspace",
      skillId: "skill_demo",
      versionId: "version_1",
      workspaceId: "ws_1",
      updatePolicy: "pinned",
    }),
  });

  expect(skillResponse.status).toBe(200);
  expect(versionResponse.status).toBe(200);
  expect(installationResponse.status).toBe(200);
  expect(await skillResponse.json()).toEqual({
    skill: {
      id: "skill_demo",
      slug: "demo",
      name: "demo",
      visibility: "workspace",
      reviewStatus: "draft",
      createdAt: "2026-05-26T10:00:00.000Z",
      updatedAt: "2026-05-26T10:01:00.000Z",
    },
  });
  expect(registryCalls).toEqual([
    {
      method: "POST",
      url: "/v1/skills",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: {
        scope: "workspace",
        name: "demo",
        displayName: "Demo",
        description: "Demo skill",
        workspaceId: "ws_1",
      },
    },
    {
      method: "POST",
      url: "/v1/skills/skill_demo/versions",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: { package: { schemaVersion: 1, entrypoint: "SKILL.md" } },
    },
    {
      method: "POST",
      url: "/v1/skill-installations",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: {
        scope: "workspace",
        skillId: "skill_demo",
        versionId: "version_1",
        workspaceId: "ws_1",
        updatePolicy: "pinned",
      },
    },
  ]);
});

test("registry mutations require host authorization", async () => {
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);

  const response = await fetch(`http://127.0.0.1:${server.port}/v1/skills`, {
    method: "POST",
    headers: {
      Authorization: "Bearer client-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scope: "workspace", name: "demo" }),
  });

  expect(response.status).toBe(401);
});

test("registry proxy exposes version history, installation changes, restore, and review requests", async () => {
  const registryCalls: Array<{
    method: string;
    url: string;
    auth: string | null;
    org: string | null;
    user: string | null;
    body: unknown;
  }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
        body: request.method === "GET" || request.method === "DELETE" ? null : await request.json(),
      });

      if (request.method === "GET" && url.pathname === "/v1/skills/skill_demo/versions") {
        return Response.json({
          versions: [
            {
              id: "version_2",
              version: "2.0.0",
              packageSha256: "b".repeat(64),
              createdAt: "2026-05-26T10:02:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }

      if (url.pathname === "/v1/skill-installations/installation_1") {
        return Response.json({
          installation: {
            installationId: "installation_1",
            skillId: "skill_demo",
            versionId: "version_2",
            enabled: request.method !== "PATCH",
            source: "workspace",
            installedAt: "2026-05-26T10:03:00.000Z",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/skill-installations/installation_1/restore") {
        return Response.json({
          installation: {
            installationId: "installation_1",
            skillId: "skill_demo",
            versionId: "version_2",
            enabled: true,
            source: "workspace",
            installedAt: "2026-05-26T10:03:00.000Z",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/skills/skill_demo/review-requests") {
        return Response.json({
          requestId: "review_1",
          skillId: "skill_demo",
          status: "pending_review",
          createdAt: "2026-05-26T10:04:00.000Z",
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);
  const hostHeaders = {
    "Content-Type": "application/json",
    "X-Veslo-Host-Token": "host-token",
    "x-veslo-den-token": "den-token",
    "x-veslo-den-org-id": "org_1",
    "x-veslo-den-user-id": "user_1",
  };

  const versionsResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skills/skill_demo/versions?cursor=next%2Fcursor&limit=10`,
    { headers: { Authorization: "Bearer client-token" } },
  );
  const updateResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-installations/installation_1`,
    {
      method: "PATCH",
      headers: hostHeaders,
      body: JSON.stringify({ enabled: false, versionId: "version_2", releaseChannel: null }),
    },
  );
  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-installations/installation_1`,
    { method: "DELETE", headers: hostHeaders },
  );
  const restoreResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-installations/installation_1/restore`,
    {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ workspaceId: "ws_1", versionId: "version_2" }),
    },
  );
  const reviewResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skills/skill_demo/review-requests`,
    {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ scope: "org", versionId: "version_2", orgId: "org_1", reason: "Ready" }),
    },
  );

  expect(versionsResponse.status).toBe(200);
  expect(updateResponse.status).toBe(200);
  expect(deleteResponse.status).toBe(200);
  expect(restoreResponse.status).toBe(200);
  expect(reviewResponse.status).toBe(200);
  expect(registryCalls).toEqual([
    {
      method: "GET",
      url: "/v1/skills/skill_demo/versions?cursor=next%2Fcursor&limit=10",
      auth: "Bearer registry-token",
      org: null,
      user: null,
      body: null,
    },
    {
      method: "PATCH",
      url: "/v1/skill-installations/installation_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: { enabled: false, versionId: "version_2", releaseChannel: null },
    },
    {
      method: "DELETE",
      url: "/v1/skill-installations/installation_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: null,
    },
    {
      method: "POST",
      url: "/v1/skill-installations/installation_1/restore",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: { workspaceId: "ws_1", versionId: "version_2" },
    },
    {
      method: "POST",
      url: "/v1/skills/skill_demo/review-requests",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: { scope: "org", versionId: "version_2", orgId: "org_1", reason: "Ready" },
    },
  ]);
});

test("registry proxy exposes workspace skill-set replacement and review decisions", async () => {
  const registryCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        body: await request.json(),
      });

      if (request.method === "PATCH" && url.pathname === "/v1/workspaces/ws_1/skill-set") {
        return Response.json({ workspaceId: "ws_1", skillSetId: "set_1", revision: "rev_2", skills: [] });
      }

      if (request.method === "POST" && url.pathname === "/v1/skill-review-requests/review_1/approve") {
        return Response.json({
          requestId: "review_1",
          skillId: "skill_demo",
          status: "approved",
          createdAt: "2026-05-26T10:04:00.000Z",
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/skill-review-requests/review_2/reject") {
        return Response.json({
          requestId: "review_2",
          skillId: "skill_demo",
          status: "rejected",
          createdAt: "2026-05-26T10:04:00.000Z",
        });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);
  const hostHeaders = {
    "Content-Type": "application/json",
    "X-Veslo-Host-Token": "host-token",
  };

  const skillSetResponse = await fetch(`http://127.0.0.1:${server.port}/v1/workspaces/ws_1/skill-set`, {
    method: "PATCH",
    headers: hostHeaders,
    body: JSON.stringify({
      orgId: "org_1",
      releaseChannel: "stable",
      skills: [{ installationId: "installation_1", desiredVersionId: "version_2" }],
    }),
  });
  const approveResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-review-requests/review_1/approve`,
    {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ reviewerNote: "Approved", releaseChannel: "stable" }),
    },
  );
  const rejectResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-review-requests/review_2/reject`,
    {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ reviewerNote: "Needs docs" }),
    },
  );

  expect(skillSetResponse.status).toBe(200);
  expect(approveResponse.status).toBe(200);
  expect(rejectResponse.status).toBe(200);
  expect(registryCalls).toEqual([
    {
      method: "PATCH",
      url: "/v1/workspaces/ws_1/skill-set",
      body: {
        orgId: "org_1",
        releaseChannel: "stable",
        skills: [{ installationId: "installation_1", desiredVersionId: "version_2" }],
      },
    },
    {
      method: "POST",
      url: "/v1/skill-review-requests/review_1/approve",
      body: { reviewerNote: "Approved", releaseChannel: "stable" },
    },
    {
      method: "POST",
      url: "/v1/skill-review-requests/review_2/reject",
      body: { reviewerNote: "Needs docs" },
    },
  ]);
});

test("registry proxy exposes rollout policy reads and host-only writes", async () => {
  const registryCalls: Array<{
    method: string;
    url: string;
    auth: string | null;
    org: string | null;
    user: string | null;
    body: unknown;
  }> = [];
  const policy = {
    id: "policy_1",
    skillId: "skill_demo",
    versionId: "version_1",
    target: "workspace",
    audience: "selected-workspaces",
    catalogScope: "organization",
    orgId: "org_1",
    workspaceId: "ws_1",
    enabled: true,
    updatePolicy: "release_channel",
    releaseChannel: "stable",
    removalPolicy: "admin_removable",
    createdAt: "2026-05-26T10:00:00.000Z",
    updatedAt: "2026-05-26T10:05:00.000Z",
  };
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      registryCalls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
        user: request.headers.get("x-veslo-den-user-id"),
        body: request.method === "GET" || request.method === "DELETE" ? null : await request.json(),
      });

      if (request.method === "GET" && url.pathname === "/v1/skill-rollout-policies") {
        return Response.json({ policies: [policy], nextCursor: null });
      }

      if (request.method === "POST" && url.pathname === "/v1/skill-rollout-policies") {
        return Response.json({ policy });
      }

      if (request.method === "PATCH" && url.pathname === "/v1/skill-rollout-policies/policy_1") {
        return Response.json({ policy: { ...policy, enabled: false, versionId: null, releaseChannel: null } });
      }

      if (request.method === "DELETE" && url.pathname === "/v1/skill-rollout-policies/policy_1") {
        return Response.json({ policy: { ...policy, enabled: false } });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  });
  runningServers.push(registry as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture(`http://127.0.0.1:${registry.port}`);
  const clientHeaders = {
    Authorization: "Bearer client-token",
    "x-veslo-den-org-id": "org_1",
    "x-veslo-den-user-id": "user_1",
  };
  const hostHeaders = {
    "Content-Type": "application/json",
    "X-Veslo-Host-Token": "host-token",
    "x-veslo-den-org-id": "org_1",
    "x-veslo-den-user-id": "user_1",
  };

  const listResponse = await fetch(
    `http://127.0.0.1:${server.port}/v1/skill-rollout-policies?cursor=next%2Fcursor&limit=20&orgId=org_1&workspaceId=ws_1`,
    { headers: clientHeaders },
  );
  const unauthorizedWrite = await fetch(`http://127.0.0.1:${server.port}/v1/skill-rollout-policies`, {
    method: "POST",
    headers: {
      ...clientHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ skillId: "skill_demo" }),
  });
  const createResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skill-rollout-policies`, {
    method: "POST",
    headers: hostHeaders,
    body: JSON.stringify({
      skillId: "skill_demo",
      versionId: "version_1",
      target: "workspace",
      audience: "selected-workspaces",
      catalogScope: "organization",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      updatePolicy: "release_channel",
      releaseChannel: "stable",
      removalPolicy: "admin_removable",
    }),
  });
  const updateResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skill-rollout-policies/policy_1`, {
    method: "PATCH",
    headers: hostHeaders,
    body: JSON.stringify({
      enabled: false,
      versionId: null,
      updatePolicy: "latest_approved",
      releaseChannel: null,
    }),
  });
  const deleteResponse = await fetch(`http://127.0.0.1:${server.port}/v1/skill-rollout-policies/policy_1`, {
    method: "DELETE",
    headers: hostHeaders,
  });

  expect(listResponse.status).toBe(200);
  expect(unauthorizedWrite.status).toBe(401);
  expect(createResponse.status).toBe(200);
  expect(updateResponse.status).toBe(200);
  expect(deleteResponse.status).toBe(200);
  expect(await listResponse.json()).toEqual({ policies: [policy], nextCursor: null });
  expect(registryCalls).toEqual([
    {
      method: "GET",
      url: "/v1/skill-rollout-policies?cursor=next%2Fcursor&limit=20&orgId=org_1&workspaceId=ws_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: null,
    },
    {
      method: "POST",
      url: "/v1/skill-rollout-policies",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: {
        skillId: "skill_demo",
        versionId: "version_1",
        target: "workspace",
        audience: "selected-workspaces",
        catalogScope: "organization",
        orgId: "org_1",
        workspaceId: "ws_1",
        enabled: true,
        updatePolicy: "release_channel",
        releaseChannel: "stable",
        removalPolicy: "admin_removable",
      },
    },
    {
      method: "PATCH",
      url: "/v1/skill-rollout-policies/policy_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: {
        versionId: null,
        enabled: false,
        updatePolicy: "latest_approved",
        releaseChannel: null,
      },
    },
    {
      method: "DELETE",
      url: "/v1/skill-rollout-policies/policy_1",
      auth: "Bearer registry-token",
      org: "org_1",
      user: "user_1",
      body: null,
    },
  ]);
});
