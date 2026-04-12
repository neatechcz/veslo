import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";

const tempDirs: string[] = [];
const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];

afterEach(async () => {
  while (runningServers.length > 0) runningServers.pop()?.stop?.(true);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("debug log route", () => {
  test("POST /internal/debug-logs requires host auth and queues events", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-log-route-"));
    tempDirs.push(workspaceRoot);

    const server = startServer({
      host: "127.0.0.1",
      port: 0,
      token: "client-token",
      hostToken: "host-token",
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" }],
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
        batchMaxEvents: 100,
        batchMaxBytes: 65536,
        spoolMaxBytes: 10485760,
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/internal/debug-logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(unauthenticated.status).toBe(401);
  });
});
