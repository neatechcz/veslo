import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { setSoulMaterializationTestHookForTests, startServer } from "../server.js";
import type { SoulDocument } from "../soul-memory.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  setSoulMaterializationTestHookForTests(null);
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

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

function document(input: {
  scope: SoulDocument["scope"];
  ownerId: string;
  versionId: string;
  content: string;
  createdBy?: string;
}): SoulDocument {
  return {
    id: `${input.scope}_${input.ownerId}`,
    scope: input.scope,
    ownerId: input.ownerId,
    currentVersionId: input.versionId,
    heartbeatEnabled: true,
    versions: [
      {
        id: input.versionId,
        content: input.content,
        changeSummary: "Initial",
        createdAt: "2026-06-05T10:00:00.000Z",
        createdBy: input.createdBy ?? "user_1",
        source: "api",
        baseVersionId: null,
        restoreSourceVersionId: null,
      },
    ],
  };
}

async function startFixture(input: {
  denApiBase?: string;
  readOnly?: boolean;
  approval?: { mode: "auto" | "manual"; timeoutMs: number };
} = {}) {
  const dataDir = await tempDir("veslo-soul-routes-data-");
  const workspaceRoot = await tempDir("veslo-soul-routes-workspace-");
  const inactiveWorkspaceRoot = await tempDir("veslo-soul-routes-inactive-workspace-");
  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: input.approval ?? { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    configPath: join(dataDir, "server.json"),
    workspaces: [
      {
        id: "ws_active",
        name: "Active Workspace",
        path: workspaceRoot,
        workspaceType: "local",
      },
      {
        id: "ws_inactive",
        name: "Inactive Workspace",
        path: inactiveWorkspaceRoot,
        workspaceType: "local",
      },
    ],
    authorizedRoots: [workspaceRoot, inactiveWorkspaceRoot],
    readOnly: input.readOnly ?? false,
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
  if (previousDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousDataDir;
  }
  return server;
}

const clientHeaders = {
  Authorization: "Bearer client-token",
};

const denHeaders = {
  ...clientHeaders,
  "x-veslo-den-token": "den-token",
  "x-veslo-den-org-id": "org_1",
  "x-veslo-den-user-id": "user_1",
};

async function issueToken(server: { port: number }, scope: "owner" | "collaborator" | "viewer"): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify({ scope }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { token: string }).token;
}

test("GET /soul returns organization, user, and workspace summaries", async () => {
  const organization = document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_v1",
    content: "Org memory",
    createdBy: "admin_1",
  });
  const user = document({ scope: "user", ownerId: "user_1", versionId: "user_v1", content: "User memory" });
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/soul/organization") return Response.json(organization);
      if (url.pathname === "/v1/soul/user") return Response.json(user);
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });

  await fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Workspace memory", changeSummary: "Seed workspace", baseVersionId: null }),
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/soul`, { headers: denHeaders });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    organization: { scope: string; ownerId: string; currentVersionId: string | null; status: string; canEdit: boolean };
    user: { scope: string; ownerId: string; currentVersionId: string | null; status: string; canEdit: boolean };
    workspaces: Array<{ scope: string; ownerId: string; currentVersionId: string | null; status: string }>;
  };
  expect(payload.organization).toMatchObject({
    scope: "organization",
    ownerId: "org_1",
    currentVersionId: "org_v1",
    status: "active",
    canEdit: true,
  });
  expect(payload.user).toMatchObject({
    scope: "user",
    ownerId: "user_1",
    currentVersionId: "user_v1",
    status: "active",
    canEdit: true,
  });
  expect(payload.workspaces).toContainEqual(expect.objectContaining({
    scope: "workspace",
    ownerId: "ws_active",
    currentVersionId: expect.any(String),
    status: "active",
  }));
  expect(payload.workspaces).toContainEqual(expect.objectContaining({
    scope: "workspace",
    ownerId: "ws_inactive",
    currentVersionId: null,
    status: "not_configured",
  }));
});

test("GET /soul/organization returns read model", async () => {
  const organization = document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_v1",
    content: "Org memory",
  });
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(organization),
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, { headers: denHeaders });

  expect(response.status).toBe(200);
  const payload = await response.json() as {
    document: SoulDocument;
    summary: { ownerId: string; title: string; currentVersionId: string | null; status: string };
  };
  expect(payload.document).toEqual(organization);
  expect(payload.summary).toMatchObject({
    ownerId: "org_1",
    title: "Organization Soul",
    currentVersionId: "org_v1",
    status: "active",
  });
});

test("organization Soul read canEdit requires collaborator scope even with Den context", async () => {
  const organization = document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_v1",
    content: "Org memory",
  });
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(organization),
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });
  const viewerToken = await issueToken(server, "viewer");

  const viewerResponse = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    headers: {
      ...denHeaders,
      Authorization: `Bearer ${viewerToken}`,
    },
  });
  expect(viewerResponse.status).toBe(200);
  expect((await viewerResponse.json() as { summary: { canEdit: boolean } }).summary.canEdit).toBe(false);

  const collaboratorResponse = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    headers: denHeaders,
  });
  expect(collaboratorResponse.status).toBe(200);
  expect((await collaboratorResponse.json() as { summary: { canEdit: boolean } }).summary.canEdit).toBe(true);

  const overviewResponse = await fetch(`http://127.0.0.1:${server.port}/soul`, {
    headers: {
      ...denHeaders,
      Authorization: `Bearer ${viewerToken}`,
    },
  });
  expect(overviewResponse.status).toBe(200);
  expect((await overviewResponse.json() as { organization: { canEdit: boolean } }).organization.canEdit).toBe(false);
});

test("GET /soul/organization uses request Den base header when server Den base is unset", async () => {
  const organization = document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_header_v1",
    content: "Org memory from header Den",
  });
  const denCalls: Array<{ method: string; pathname: string; auth: string | null; org: string | null }> = [];
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      denCalls.push({
        method: request.method,
        pathname: url.pathname,
        auth: request.headers.get("authorization"),
        org: request.headers.get("x-veslo-den-org-id"),
      });
      return Response.json(organization);
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    headers: {
      ...denHeaders,
      "x-veslo-den-api-base": `http://127.0.0.1:${den.port}`,
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { document: SoulDocument; summary: { currentVersionId: string | null } };
  expect(payload.document).toEqual(organization);
  expect(payload.summary.currentVersionId).toBe("org_header_v1");
  expect(denCalls).toEqual([
    {
      method: "GET",
      pathname: "/v1/soul/organization",
      auth: "Bearer den-token",
      org: "org_1",
    },
  ]);
});

test("PATCH /soul/organization requires Den auth and propagates Den 403", async () => {
  const denCalls: string[] = [];
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      denCalls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ code: "forbidden" }, { status: 403 });
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });

  const missingAuth = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    method: "PATCH",
    headers: { ...clientHeaders, "content-type": "application/json", "x-veslo-den-org-id": "org_1" },
    body: JSON.stringify({ content: "Org memory", changeSummary: "Update", baseVersionId: null }),
  });
  expect(missingAuth.status).toBe(401);

  const forbidden = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Org memory", changeSummary: "Update", baseVersionId: null }),
  });

  expect(forbidden.status).toBe(403);
  expect((await forbidden.json() as { code: string }).code).toBe("soul_den_forbidden");
  expect(denCalls).toEqual(["PATCH /v1/soul/organization"]);
});

test("PATCH /soul/organization uses request Den base header when server Den base is unset", async () => {
  const updated = document({
    scope: "organization",
    ownerId: "org_1",
    versionId: "org_header_v2",
    content: "Updated org memory from header Den",
  });
  const denCalls: Array<{ method: string; pathname: string; body: unknown }> = [];
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      denCalls.push({
        method: request.method,
        pathname: url.pathname,
        body: await request.json(),
      });
      return Response.json(updated);
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture();

  const response = await fetch(`http://127.0.0.1:${server.port}/soul/organization`, {
    method: "PATCH",
    headers: {
      ...denHeaders,
      "content-type": "application/json",
      "x-veslo-den-api-base": `http://127.0.0.1:${den.port}`,
    },
    body: JSON.stringify({
      content: "Updated org memory from header Den",
      changeSummary: "Update org through header Den",
      baseVersionId: null,
    }),
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { document: SoulDocument; summary: { currentVersionId: string | null } };
  expect(payload.document).toEqual(updated);
  expect(payload.summary.currentVersionId).toBe("org_header_v2");
  expect(denCalls).toEqual([
    {
      method: "PATCH",
      pathname: "/v1/soul/organization",
      body: {
        content: "Updated org memory from header Den",
        changeSummary: "Update org through header Den",
        baseVersionId: null,
      },
    },
  ]);
});

test("GET /soul/user reports persisted pending edit after offline user patch", async () => {
  const server = await startFixture();

  const patch = await fetch(`http://127.0.0.1:${server.port}/soul/user`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      content: "Offline user memory",
      changeSummary: "Queue offline user memory",
      baseVersionId: null,
    }),
  });

  expect(patch.status).toBe(202);
  const patchPayload = await patch.json() as {
    summary: { status: string };
    pendingEdits?: Array<{ scope: string; ownerId: string; content: string; denSynced: boolean }>;
    denSynced?: boolean;
  };
  expect(patchPayload.summary.status).toBe("pending");
  expect(patchPayload.denSynced).toBe(false);
  expect(patchPayload.pendingEdits).toEqual([
    expect.objectContaining({
      scope: "user",
      ownerId: "user_1",
      content: "Offline user memory",
      denSynced: false,
    }),
  ]);

  const read = await fetch(`http://127.0.0.1:${server.port}/soul/user`, { headers: denHeaders });
  expect(read.status).toBe(200);
  const readPayload = await read.json() as {
    summary: { status: string };
    pendingEdits?: Array<{ scope: string; ownerId: string; content: string; denSynced: boolean }>;
    denSynced?: boolean;
  };
  expect(readPayload.summary.status).toBe("pending");
  expect(readPayload.denSynced).toBe(false);
  expect(readPayload.pendingEdits).toEqual([
    expect.objectContaining({
      scope: "user",
      ownerId: "user_1",
      content: "Offline user memory",
      denSynced: false,
    }),
  ]);

  const overview = await fetch(`http://127.0.0.1:${server.port}/soul`, { headers: denHeaders });
  expect(overview.status).toBe(200);
  expect((await overview.json() as { user: { status: string } }).user.status).toBe("pending");
});

test("PATCH /soul/user creates a new version", async () => {
  const user = document({ scope: "user", ownerId: "user_1", versionId: "user_v1", content: "User memory" });
  const denCalls: Array<{ method: string; pathname: string; body: unknown }> = [];
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/soul/user") return Response.json(user);
      if (request.method === "PATCH" && url.pathname === "/v1/soul/user") {
        const body = await request.json();
        denCalls.push({ method: request.method, pathname: url.pathname, body });
        return Response.json({
          ...user,
          currentVersionId: "user_v2",
          versions: [
            ...user.versions,
            {
              id: "user_v2",
              content: "Updated user memory",
              changeSummary: "Update user",
              createdAt: "2026-06-05T11:00:00.000Z",
              createdBy: "user_1",
              source: "api",
              baseVersionId: "user_v1",
              restoreSourceVersionId: null,
            },
          ],
        });
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/soul/user`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Updated user memory", changeSummary: "Update user", baseVersionId: "user_v1" }),
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { document: SoulDocument; summary: { currentVersionId: string | null } };
  expect(payload.summary.currentVersionId).toBe("user_v2");
  expect(payload.document.versions.map((version) => version.id)).toEqual(["user_v1", "user_v2"]);
  expect(denCalls).toEqual([
    {
      method: "PATCH",
      pathname: "/v1/soul/user",
      body: {
        content: "Updated user memory",
        changeSummary: "Update user",
        baseVersionId: "user_v1",
      },
    },
  ]);
});

test("workspace soul routes work for configured workspaces that are not active", async () => {
  const server = await startFixture();

  const update = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_inactive/soul`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Inactive workspace memory", changeSummary: "Create", baseVersionId: null }),
  });

  expect(update.status).toBe(200);
  const updatePayload = await update.json() as { document: SoulDocument; summary: { currentVersionId: string | null } };
  expect(updatePayload.document.scope).toBe("workspace");
  expect(updatePayload.document.ownerId).toBe("ws_inactive");
  expect(updatePayload.document.heartbeatEnabled).toBe(true);
  expect(updatePayload.document.versions).toHaveLength(1);
  expect(updatePayload.summary.currentVersionId).toBe(updatePayload.document.currentVersionId);

  const read = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_inactive/soul`, { headers: clientHeaders });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(updatePayload);
});

test("workspace Soul writes require approval before local cache and materialization writes", async () => {
  const server = await startFixture({ approval: { mode: "manual", timeoutMs: 1_000 } });
  const workspaceRoot = tempDirs[tempDirs.length - 2]!;

  const patchPromise = fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Denied workspace memory", changeSummary: "Denied", baseVersionId: null }),
  });

  const approval = await waitForApproval(server);
  expect(approval).toMatchObject({
    workspaceId: "ws_active",
    action: "soul.workspace.update",
  });
  expect(approval.paths).toContain(join(workspaceRoot, ".opencode", "soul-workspace.md"));

  const deny = await fetch(`http://127.0.0.1:${server.port}/approvals/${approval.id}`, {
    method: "POST",
    headers: { "x-veslo-host-token": "host-token", "content-type": "application/json" },
    body: JSON.stringify({ reply: "deny" }),
  });
  expect(deny.status).toBe(200);

  const response = await patchPromise;
  expect(response.status).toBe(403);
  expect((await response.json() as { code: string }).code).toBe("write_denied");
  await expect(readFile(join(workspaceRoot, ".opencode", "soul-workspace.md"), "utf8")).rejects.toThrow();
  await expect(readFile(join(workspaceRoot, ".opencode", "veslo", "soul-manifest.json"), "utf8")).rejects.toThrow();
});

test("concurrent Soul materializations preserve newest scope content", async () => {
  const updatedUser = document({
    scope: "user",
    ownerId: "user_1",
    versionId: "user_v1",
    content: "Newest user memory",
  });
  let userDenSeen!: () => void;
  const userDenRequestReceived = new Promise<void>((resolve) => {
    userDenSeen = resolve;
  });
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/soul/user" && request.method === "PATCH") {
        userDenSeen();
        return Response.json(updatedUser);
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });
  const server = await startFixture({ denApiBase: `http://127.0.0.1:${den.port}` });
  const workspaceRoot = tempDirs[tempDirs.length - 2]!;
  let releaseWorkspaceMaterialization: (() => void) | null = null;
  const workspaceMaterializationPaused = new Promise<void>((resolve) => {
    setSoulMaterializationTestHookForTests(async ({ overrides }) => {
      if (!overrides.workspace) return;
      resolve();
      await new Promise<void>((release) => {
        releaseWorkspaceMaterialization = release;
      });
    });
  });

  const workspacePatch = fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Workspace memory", changeSummary: "Create", baseVersionId: null }),
  });
  await workspaceMaterializationPaused;

  const userPatch = fetch(`http://127.0.0.1:${server.port}/soul/user`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Newest user memory", changeSummary: "Update user", baseVersionId: null }),
  });
  await userDenRequestReceived;

  if (!releaseWorkspaceMaterialization) throw new Error("Workspace materialization did not pause");
  const releasePausedWorkspaceMaterialization: () => void = releaseWorkspaceMaterialization;
  releasePausedWorkspaceMaterialization();
  expect((await userPatch).status).toBe(200);
  const workspaceResponse = await workspacePatch;
  expect(workspaceResponse.status).toBe(200);

  expect(await readFile(join(workspaceRoot, ".opencode", "soul-user.md"), "utf8")).toBe("Newest user memory\n");
});

test("POST /workspace/:id/soul/heartbeat-toggle toggles workspace Heartbeat", async () => {
  const server = await startFixture();

  await fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul`, {
    method: "PATCH",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ content: "Workspace memory", changeSummary: "Create", baseVersionId: null }),
  });

  const off = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul/heartbeat-toggle`, {
    method: "POST",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(off.status).toBe(200);
  expect((await off.json() as { document: SoulDocument }).document.heartbeatEnabled).toBe(false);

  const on = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_active/soul/heartbeat-toggle`, {
    method: "POST",
    headers: { ...denHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(on.status).toBe(200);
  expect((await on.json() as { document: SoulDocument }).document.heartbeatEnabled).toBe(true);
});

async function waitForApproval(server: { port: number }): Promise<{
  id: string;
  workspaceId: string;
  action: string;
  paths: string[];
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${server.port}/approvals`, {
      headers: { "x-veslo-host-token": "host-token" },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      items: Array<{ id: string; workspaceId: string; action: string; paths: string[] }>;
    };
    if (payload.items[0]) return payload.items[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Approval request did not appear");
}
