import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "../server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
let previousVesloDataDir: string | undefined;

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore cleanup errors
    }
  }
  if (previousVesloDataDir === undefined) {
    delete process.env.VESLO_DATA_DIR;
  } else {
    process.env.VESLO_DATA_DIR = previousVesloDataDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startFixture() {
  const workspaceRoot = await tempDir("veslo-user-skill-store-route-workspace-");
  const dataDir = await tempDir("veslo-user-skill-store-route-data-");
  previousVesloDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;

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
  });

  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server, workspaceRoot };
}

const clientHeaders = {
  Authorization: "Bearer client-token",
  "content-type": "application/json",
};

test("user-global skill store routes persist and sync runtime materializations", async () => {
  const { server, workspaceRoot } = await startFixture();

  const createResponse = await fetch(`http://127.0.0.1:${server.port}/skills/user-global-store`, {
    method: "POST",
    headers: clientHeaders,
    body: JSON.stringify({
      name: "portable-helper",
      description: "Portable helper",
      content: "# Portable helper\n\nUse this in any workspace.\n",
    }),
  });
  expect(createResponse.status).toBe(200);
  const createPayload = await createResponse.json() as {
    item: { name: string; path: string; scope: string };
    action: string;
  };
  expect(createPayload.action).toBe("added");
  expect(createPayload.item).toMatchObject({
    name: "portable-helper",
    path: "veslo-user-store://portable-helper",
    scope: "user-global",
  });

  const listResponse = await fetch(`http://127.0.0.1:${server.port}/skills/user-global-store`, {
    headers: { Authorization: "Bearer client-token" },
  });
  expect(listResponse.status).toBe(200);
  const listPayload = await listResponse.json() as { items: Array<{ name: string }> };
  expect(listPayload.items.map((item) => item.name)).toEqual(["portable-helper"]);

  const detailResponse = await fetch(`http://127.0.0.1:${server.port}/skills/user-global-store/portable-helper`, {
    headers: { Authorization: "Bearer client-token" },
  });
  expect(detailResponse.status).toBe(200);
  const detailPayload = await detailResponse.json() as { content: string };
  expect(detailPayload.content).toContain("name: portable-helper");
  expect(detailPayload.content).toContain("description: Portable helper");

  const syncResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/user-global-store/sync`, {
    method: "POST",
    headers: clientHeaders,
  });
  expect(syncResponse.status).toBe(200);
  const syncPayload = await syncResponse.json() as {
    reloadRequired: boolean;
    materializedSkills: Array<{ name: string }>;
    conflicts: unknown[];
  };
  expect(syncPayload.reloadRequired).toBe(true);
  expect(syncPayload.conflicts).toEqual([]);
  expect(syncPayload.materializedSkills.map((skill) => skill.name)).toEqual(["portable-helper"]);

  const materializedPath = join(workspaceRoot, ".opencode", "skills", "veslo-user", "portable-helper", "SKILL.md");
  const materialized = await readFile(materializedPath, "utf8");
  expect(materialized).toContain("name: portable-helper");

  const deleteResponse = await fetch(`http://127.0.0.1:${server.port}/skills/user-global-store/portable-helper`, {
    method: "DELETE",
    headers: { Authorization: "Bearer client-token" },
  });
  expect(deleteResponse.status).toBe(200);

  const cleanupResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/skills/user-global-store/sync`, {
    method: "POST",
    headers: clientHeaders,
  });
  expect(cleanupResponse.status).toBe(200);
  await expect(access(materializedPath)).rejects.toThrow();
});
