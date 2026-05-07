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
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-logs-route-"));
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-debug-logs-data-"));
  tempDirs.push(workspaceRoot, dataDir);

  process.env.VESLO_DATA_DIR = dataDir;

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" },
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
  return server;
}

function makeBatch(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "batch-1",
    events: [
      {
        id: "evt-1",
        userId: "u1",
        orgId: "o1",
        workspaceId: "ws_1",
        source: "test",
        stream: "stdout",
        timestamp: Date.now() * 1_000_000,
        sequenceNo: 0,
        payload: { line: "hello" },
      },
    ],
    ...overrides,
  };
}

test("POST /debug-logs without host token returns 401/403", async () => {
  const server = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeBatch()),
  });
  expect([401, 403]).toContain(response.status);
});

test("POST /debug-logs with host token accepts a valid batch (202)", async () => {
  const server = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify(makeBatch()),
  });
  expect(response.status).toBe(202);
  const payload = await response.json() as { ok: boolean; acceptedBatchIds: string[] };
  expect(payload.ok).toBe(true);
  expect(payload.acceptedBatchIds).toEqual(["batch-1"]);
});

test("POST /debug-logs with malformed body returns 400 with issues", async () => {
  const server = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify({ batchId: "x", events: [{}] }),
  });
  expect(response.status).toBe(400);
  const payload = await response.json() as { code: string; issues: Array<{ path: string }> };
  expect(payload.code).toBe("invalid_batch");
  expect(payload.issues.length).toBeGreaterThan(0);
});

test("POST /debug-logs with empty events array returns 400", async () => {
  const server = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify({ batchId: "b", events: [] }),
  });
  expect(response.status).toBe(400);
});
