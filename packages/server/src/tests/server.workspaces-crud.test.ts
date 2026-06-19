import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { startServer } from "../server.js";
import type { WorkspaceInfo } from "../types.js";
import { workspaceIdForPath } from "../workspaces.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startFixture(seedWorkspaces: WorkspaceInfo[] = []) {
  const configDir = await mkdtemp(join(tmpdir(), "veslo-crud-config-"));
  tempDirs.push(configDir);
  const configPath = join(configDir, "server.json");

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath,
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: seedWorkspaces,
    authorizedRoots: seedWorkspaces.map((w) => w.path),
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
  });

  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server, configPath };
}

function hostHeaders() {
  return { "x-veslo-host-token": "host-token", "Content-Type": "application/json" };
}

function clientHeaders() {
  return { Authorization: "Bearer client-token" };
}

test("POST /workspaces/local creates a new workspace and persists", async () => {
  const { server, configPath } = await startFixture();
  const newDir = await mkdtemp(join(tmpdir(), "veslo-ws-new-"));
  tempDirs.push(newDir);

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: newDir, name: "MyProj" }),
  });

  expect(response.status).toBe(201);
  const payload = (await response.json()) as { activeId: string; items: Array<{ id: string; name: string }>; persisted: boolean };
  expect(payload.activeId).toBeTruthy();
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0]!.name).toBe("MyProj");
  expect(payload.persisted).toBe(true);

  // Verify GET reflects the create
  const list = (await (await fetch(`http://127.0.0.1:${server.port}/workspaces`, { headers: clientHeaders() })).json()) as { items: Array<{ id: string }>; activeId: string };
  expect(list.items).toHaveLength(1);
  expect(list.activeId).toBe(payload.activeId);

  // Verify persisted file
  const onDisk = JSON.parse(await readFile(configPath, "utf8")) as { workspaces: Array<{ path: string; name: string }> };
  expect(onDisk.workspaces).toHaveLength(1);
  expect(onDisk.workspaces[0]!.path).toBe(newDir);
  expect(onDisk.workspaces[0]!.name).toBe("MyProj");
});

test("POST /workspaces/local with default name uses basename", async () => {
  const { server } = await startFixture();
  const newDir = await mkdtemp(join(tmpdir(), "veslo-ws-basename-"));
  tempDirs.push(newDir);

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: newDir }),
  });

  const payload = (await response.json()) as { items: Array<{ name: string }> };
  const expectedBase = basename(newDir);
  expect(payload.items[0]!.name).toBe(expectedBase);
});

test("POST /workspaces/local rejects empty path with 400", async () => {
  const { server } = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: "" }),
  });
  expect(response.status).toBe(400);
  const payload = (await response.json()) as { code: string };
  expect(payload.code).toBe("invalid_payload");
});

test("POST /workspaces/local rejects duplicate with 409", async () => {
  const { server } = await startFixture();
  const newDir = await mkdtemp(join(tmpdir(), "veslo-ws-dup-"));
  tempDirs.push(newDir);

  const first = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: newDir }),
  });
  expect(first.status).toBe(201);

  const second = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: newDir }),
  });
  expect(second.status).toBe(409);
  const payload = (await second.json()) as { code: string };
  expect(payload.code).toBe("workspace_exists");
});

test("POST /workspaces/local updates existing workspace opencode metadata", async () => {
  const seedDir = await mkdtemp(join(tmpdir(), "veslo-ws-metadata-"));
  tempDirs.push(seedDir);
  const workspaceId = workspaceIdForPath(seedDir);
  const seed: WorkspaceInfo = {
    id: workspaceId,
    name: "Seed",
    path: seedDir,
    workspaceType: "local",
  };
  const { server, configPath } = await startFixture([seed]);
  const baseUrl = `http://127.0.0.1:62930/workspace/${workspaceId}/opencode/`;

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({
      path: seedDir,
      name: "Seed",
      baseUrl,
      directory: seedDir,
      opencodeUsername: "opencode",
      opencodePassword: "secret",
    }),
  });

  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    items: Array<{ id: string; baseUrl?: string; opencode?: { baseUrl?: string; username?: string } }>;
    persisted: boolean;
  };
  const updated = payload.items.find((item) => item.id === seed.id);
  expect(updated?.baseUrl).toBe(`http://127.0.0.1:62930/workspace/${workspaceId}/opencode`);
  expect(updated?.opencode?.baseUrl).toBe(`http://127.0.0.1:62930/workspace/${workspaceId}/opencode`);
  expect(updated?.opencode?.username).toBe("opencode");
  expect(payload.persisted).toBe(true);

  const onDisk = JSON.parse(await readFile(configPath, "utf8")) as {
    workspaces: Array<{
      baseUrl?: string;
      directory?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
    }>;
  };
  expect(onDisk.workspaces[0]!.baseUrl).toBe(`http://127.0.0.1:62930/workspace/${workspaceId}/opencode`);
  expect(onDisk.workspaces[0]!.directory).toBe(seedDir);
  expect(onDisk.workspaces[0]!.opencodeUsername).toBe("opencode");
  expect(onDisk.workspaces[0]!.opencodePassword).toBe("secret");
});

test("POST /workspaces/local treats repeated opencode metadata registration as idempotent", async () => {
  const seedDir = await mkdtemp(join(tmpdir(), "veslo-ws-metadata-idempotent-"));
  tempDirs.push(seedDir);
  const workspaceId = workspaceIdForPath(seedDir);
  const baseUrl = `http://127.0.0.1:62930/workspace/${workspaceId}/opencode`;
  const seed: WorkspaceInfo = {
    id: workspaceId,
    name: "Seed",
    path: seedDir,
    workspaceType: "local",
    baseUrl,
    directory: seedDir,
    opencodeUsername: "opencode",
    opencodePassword: "secret",
  };
  const { server } = await startFixture([seed]);

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({
      path: seedDir,
      name: "Seed",
      baseUrl,
      directory: seedDir,
      opencodeUsername: "opencode",
      opencodePassword: "secret",
    }),
  });

  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    items: Array<{ id: string; baseUrl?: string; opencode?: { baseUrl?: string; username?: string } }>;
    persisted: boolean;
  };
  const registered = payload.items.find((item) => item.id === seed.id);
  expect(registered?.baseUrl).toBe(baseUrl);
  expect(registered?.opencode?.baseUrl).toBe(baseUrl);
  expect(registered?.opencode?.username).toBe("opencode");
  expect(payload.persisted).toBe(false);
});

test("POST /workspaces/local requires host token (not client)", async () => {
  const { server } = await startFixture();
  const newDir = await mkdtemp(join(tmpdir(), "veslo-ws-auth-"));
  tempDirs.push(newDir);

  // Send only client bearer token (no host-token header) → must fail with 401
  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: { Authorization: "Bearer client-token", "Content-Type": "application/json" },
    body: JSON.stringify({ path: newDir }),
  });
  expect(response.status).toBe(401);
});

test("PATCH /workspaces/:id renames workspace and persists", async () => {
  const seedDir = await mkdtemp(join(tmpdir(), "veslo-ws-seed-"));
  tempDirs.push(seedDir);
  const seed: WorkspaceInfo = { id: "ws_seed", name: "OldName", path: seedDir, workspaceType: "local" };
  const { server, configPath } = await startFixture([seed]);

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/${seed.id}`, {
    method: "PATCH",
    headers: hostHeaders(),
    body: JSON.stringify({ name: "NewName" }),
  });

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { items: Array<{ id: string; name: string }>; persisted: boolean };
  expect(payload.items.find((w) => w.id === seed.id)!.name).toBe("NewName");
  expect(payload.persisted).toBe(true);

  const onDisk = JSON.parse(await readFile(configPath, "utf8")) as { workspaces: Array<{ name: string }> };
  expect(onDisk.workspaces[0]!.name).toBe("NewName");
});

test("PATCH /workspaces/:id rejects empty name with 400", async () => {
  const seedDir = await mkdtemp(join(tmpdir(), "veslo-ws-rename-"));
  tempDirs.push(seedDir);
  const seed: WorkspaceInfo = { id: "ws_rename", name: "X", path: seedDir, workspaceType: "local" };
  const { server } = await startFixture([seed]);

  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/${seed.id}`, {
    method: "PATCH",
    headers: hostHeaders(),
    body: JSON.stringify({ name: "  " }),
  });
  expect(response.status).toBe(400);
});

test("PATCH /workspaces/:id returns 404 for unknown id", async () => {
  const { server } = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/workspaces/ws_nonexistent`, {
    method: "PATCH",
    headers: hostHeaders(),
    body: JSON.stringify({ name: "X" }),
  });
  expect(response.status).toBe(404);
});

test("CRUD flow end-to-end: create → list → rename → list", async () => {
  const { server } = await startFixture();
  const newDir = await mkdtemp(join(tmpdir(), "veslo-crud-e2e-"));
  tempDirs.push(newDir);

  const create = await (await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ path: newDir, name: "Alpha" }),
  })).json() as { activeId: string };
  expect(create.activeId).toBeTruthy();

  const list1 = (await (await fetch(`http://127.0.0.1:${server.port}/workspaces`, { headers: clientHeaders() })).json()) as { items: Array<{ id: string; name: string }> };
  expect(list1.items.find((w) => w.id === create.activeId)!.name).toBe("Alpha");

  await fetch(`http://127.0.0.1:${server.port}/workspaces/${create.activeId}`, {
    method: "PATCH",
    headers: hostHeaders(),
    body: JSON.stringify({ name: "Beta" }),
  });

  const list2 = (await (await fetch(`http://127.0.0.1:${server.port}/workspaces`, { headers: clientHeaders() })).json()) as { items: Array<{ id: string; name: string }> };
  expect(list2.items.find((w) => w.id === create.activeId)!.name).toBe("Beta");
});
