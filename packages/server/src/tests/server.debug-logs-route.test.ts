import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { startServer } from "../server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore
    }
  }
  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function startFixture(options: { logRequests?: boolean; debugLogUpload?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-logs-route-"));
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-debug-logs-data-"));
  tempDirs.push(workspaceRoot, dataDir);

  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previousDataDir === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previousDataDir;
    }
  });

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
    logRequests: options.logRequests ?? false,
    debugLogs: {
      enabled: options.debugLogUpload ?? false,
      ingestUrl: options.debugLogUpload ? "https://den.example/v1/internal/debug-logs" : null,
      ingestToken: options.debugLogUpload ? "debug-token" : null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 60_000,
    },
  });

  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server, dataDir };
}

async function readSpooledEvents(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const eventDir = join(dataDir, "debug-log-spool", "events");
  const files = await readdir(eventDir).catch(() => []);
  const events: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(eventDir, file), "utf8");
    events.push(JSON.parse(raw) as Record<string, unknown>);
  }
  return events;
}

async function waitForSpooledEvents(dataDir: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await readSpooledEvents(dataDir);
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readSpooledEvents(dataDir);
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
  const { server } = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeBatch()),
  });
  expect([401, 403]).toContain(response.status);
});

test("POST /debug-logs with host token accepts a valid batch (202)", async () => {
  const { server } = await startFixture({ debugLogUpload: true });
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify(makeBatch()),
  });
  expect(response.status).toBe(202);
  const payload = await response.json() as {
    ok: boolean;
    acceptedBatchIds: string[];
    cloudUploadEnabled: boolean;
  };
  expect(payload.ok).toBe(true);
  expect(payload.acceptedBatchIds).toEqual(["batch-1"]);
  expect(payload.cloudUploadEnabled).toBe(true);
});

test("POST /debug-logs reports disabled cloud upload while accepting a valid batch", async () => {
  const { server } = await startFixture();
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify(makeBatch()),
  });
  expect(response.status).toBe(202);
  const payload = await response.json() as {
    ok: boolean;
    acceptedBatchIds: string[];
    cloudUploadEnabled: boolean;
  };
  expect(payload.ok).toBe(true);
  expect(payload.acceptedBatchIds).toEqual(["batch-1"]);
  expect(payload.cloudUploadEnabled).toBe(false);
});

test("POST /debug-logs does not spool its own request log", async () => {
  const { server, dataDir } = await startFixture({ logRequests: true, debugLogUpload: true });
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify(makeBatch()),
  });
  expect(response.status).toBe(202);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const events = await waitForSpooledEvents(dataDir);
  expect(events.some((event) => event.id === "evt-1")).toBe(true);
  expect(
    events.some((event) => {
      const payload = event.payload as { attributes?: { path?: string } } | undefined;
      return event.source === "veslo-server-self" && payload?.attributes?.path === "/debug-logs";
    }),
  ).toBe(false);
});

test("POST /debug-logs with malformed body returns 400 with issues", async () => {
  const { server } = await startFixture();
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

test("POST /debug-logs rejects oversized JSON before validation", async () => {
  const { server } = await startFixture();
  const oversizedBatch = makeBatch({
    events: [
      {
        ...makeBatch().events[0],
        payload: { line: "x".repeat(300 * 1024) },
      },
    ],
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/debug-logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-veslo-host-token": "host-token",
    },
    body: JSON.stringify(oversizedBatch),
  });
  expect(response.status).toBe(413);
  const payload = await response.json() as { code: string };
  expect(payload.code).toBe("payload_too_large");
});

test("POST /debug-logs with empty events array returns 400", async () => {
  const { server } = await startFixture();
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
