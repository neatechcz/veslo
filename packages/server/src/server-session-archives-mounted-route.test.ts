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

test("mounted workspace URLs can archive, list, and unarchive sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-archive-mounted-route-"));
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
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

  const baseHeaders = {
    Authorization: "Bearer client-token",
    "Content-Type": "application/json",
    "x-veslo-account-id": "usr_123",
  };

  const putResponse = await fetch(
    `http://127.0.0.1:${server.port}/w/ws_1/session-archives/session-a`,
    {
      method: "PUT",
      headers: baseHeaders,
      body: JSON.stringify({
        archivedAt: 123,
        titleSnapshot: "Session A",
      }),
    },
  );

  expect(putResponse.status).toBe(200);
  expect(await putResponse.json()).toEqual({
    items: [
      {
        sessionId: "session-a",
        archivedAt: 123,
        titleSnapshot: "Session A",
        parentSessionId: null,
        createdAtSnapshot: null,
        updatedAtSnapshot: null,
      },
    ],
  });

  const listResponse = await fetch(
    `http://127.0.0.1:${server.port}/w/ws_1/session-archives`,
    {
      headers: {
        Authorization: "Bearer client-token",
        "x-veslo-account-id": "usr_123",
      },
    },
  );

  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toEqual({
    items: [
      {
        sessionId: "session-a",
        archivedAt: 123,
        titleSnapshot: "Session A",
        parentSessionId: null,
        createdAtSnapshot: null,
        updatedAtSnapshot: null,
      },
    ],
  });

  const deleteResponse = await fetch(
    `http://127.0.0.1:${server.port}/w/ws_1/session-archives/session-a`,
    {
      method: "DELETE",
      headers: {
        Authorization: "Bearer client-token",
        "x-veslo-account-id": "usr_123",
      },
    },
  );

  expect(deleteResponse.status).toBe(200);
  expect(await deleteResponse.json()).toEqual({ items: [] });
});
