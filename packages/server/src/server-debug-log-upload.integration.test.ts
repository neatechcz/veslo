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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe("debug log upload integration", () => {
  test("host-enqueued events are retried until a later successful upload acknowledges the batch", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-upload-"));
    tempDirs.push(workspaceRoot);

    const received: Array<{ batchId: string; eventCount: number }> = [];
    let attempts = 0;
    const den = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        attempts += 1;
        const body = await request.json() as { batchId: string; events: unknown[] };
        if (attempts <= 3) {
          return new Response(JSON.stringify({ ok: false, acceptedBatchIds: [] }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        received.push({ batchId: body.batchId, eventCount: body.events.length });
        return new Response(JSON.stringify({ ok: true, acceptedBatchIds: [body.batchId] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    runningServers.push(den as { stop?: (closeActiveConnections?: boolean) => void });

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
        enabled: true,
        ingestUrl: `http://127.0.0.1:${den.port}/v1/internal/debug-logs`,
        ingestToken: "ingest-token",
        batchMaxEvents: 100,
        batchMaxBytes: 65536,
        spoolMaxBytes: 10485760,
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const response = await fetch(`http://127.0.0.1:${server.port}/internal/debug-logs`, {
      method: "POST",
      headers: {
        "X-Veslo-Host-Token": "host-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            id: "evt-1",
            userId: "usr_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            source: "engine",
            stream: "stdout",
            timestamp: Date.now(),
            sequenceNo: 1,
            payload: { text: "hello" },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await waitFor(() => attempts >= 4 && received.length === 1, 4_000).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (attempts=${attempts}, received=${JSON.stringify(received)})`,
      );
    });
    expect(received[0]?.eventCount).toBe(1);
  });
});
