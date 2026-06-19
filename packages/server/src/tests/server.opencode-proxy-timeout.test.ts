import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../server.js";
import type { WorkspaceInfo } from "../types.js";

// Send-timeout fix 2026-06-10 — proxyOpencodeRequest used to fetch upstream
// with no timeout at all, so a hung engine/orchestrator held client requests
// open until the client's own 60s timeout fired. The proxy now bounds the
// wait for response HEADERS (streaming bodies, e.g. SSE, stay unaffected).

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const PROXY_HEADERS_TIMEOUT_ENV = "VESLO_OPENCODE_PROXY_HEADERS_TIMEOUT_MS";

afterEach(async () => {
  delete process.env[PROXY_HEADERS_TIMEOUT_ENV];
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

function buildWorkspace(id: string, path: string, baseUrl: string): WorkspaceInfo {
  return {
    id,
    name: `Workspace ${id}`,
    path,
    workspaceType: "local",
    baseUrl,
  };
}

async function startVesloFixture(workspaces: WorkspaceInfo[]) {
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((w) => w.path),
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
  return server as unknown as { port: number };
}

test("proxy returns 502 quickly when upstream never sends response headers", async () => {
  process.env[PROXY_HEADERS_TIMEOUT_ENV] = "300";
  const hanging = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  runningServers.push(hanging as unknown as { stop?: (closeActiveConnections?: boolean) => void });

  const ws = await mkdtemp(join(tmpdir(), "veslo-proxy-timeout-"));
  tempDirs.push(ws);
  const server = await startVesloFixture([
    buildWorkspace("ws_hang", ws, `http://127.0.0.1:${hanging.port}`),
  ]);

  const start = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_hang/opencode/mcp`,
    { headers: { Authorization: "Bearer client-token" } },
  );
  const elapsed = Date.now() - start;
  const body = (await response.json()) as { code?: string };

  expect(response.status).toBe(502);
  expect(body.code).toBe("opencode_proxy_timeout");
  expect(elapsed).toBeLessThan(5_000);
});

test("headers timeout does not cut streaming bodies that outlive the window", async () => {
  process.env[PROXY_HEADERS_TIMEOUT_ENV] = "300";
  const streaming = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            await new Promise((r) => setTimeout(r, 450));
            controller.enqueue(new TextEncoder().encode("data: two\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  runningServers.push(streaming as unknown as { stop?: (closeActiveConnections?: boolean) => void });

  const ws = await mkdtemp(join(tmpdir(), "veslo-proxy-stream-"));
  tempDirs.push(ws);
  const server = await startVesloFixture([
    buildWorkspace("ws_stream", ws, `http://127.0.0.1:${streaming.port}`),
  ]);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_stream/opencode/event`,
    { headers: { Authorization: "Bearer client-token" } },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("data: one");
  expect(text).toContain("data: two");
});
