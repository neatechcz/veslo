import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";

import { startServer } from "../server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const runningNodeServers: Array<ReturnType<typeof createServer>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (runningNodeServers.length > 0) {
    const server = runningNodeServers.pop();
    if (!server) continue;
    server.closeAllConnections?.();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
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

async function reserveLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function listenNodeServer(server: ReturnType<typeof createServer>): Promise<number> {
  const port = await reserveLoopbackPort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  runningNodeServers.push(server);
  return port;
}

async function startFixture(options: { opencodeBaseUrl?: string } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-bounded-body-"));
  tempDirs.push(workspaceRoot);

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" },
      {
        id: "ws_opencode",
        name: "OpenCode Workspace",
        path: workspaceRoot,
        workspaceType: "local",
        baseUrl: options.opencodeBaseUrl,
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
  return server;
}

async function createFileSession(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/workspace/ws_1/files/sessions`, {
    method: "POST",
    headers: {
      Authorization: "Bearer client-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ write: true }),
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as { session: { id: string } };
  return payload.session.id;
}

describe("bounded server body handling", () => {
  test("generic JSON routes reject oversized request bodies with 413", async () => {
    const server = await startFixture();
    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        selectedSessionId: "sess_1",
        loadedTopLevelSessionIds: ["sess_1"],
        expandedSubagentSessionIds: [],
        filler: "x".repeat(2 * 1024 * 1024),
      }),
    });

    expect(response.status).toBe(413);
    const payload = await response.json() as { code: string };
    expect(payload.code).toBe("payload_too_large");
  });

  test("file-session write rejects oversized JSON before decoding content", async () => {
    const server = await startFixture();
    const sessionId = await createFileSession(server.port);
    const response = await fetch(`http://127.0.0.1:${server.port}/files/sessions/${sessionId}/write-batch`, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        writes: [
          {
            path: "large.md",
            contentBase64: "a".repeat(8 * 1024 * 1024),
          },
        ],
      }),
    });

    expect(response.status).toBe(413);
    const payload = await response.json() as { code: string };
    expect(payload.code).toBe("payload_too_large");
  });

  test("OpenCode JSON helpers reject oversized upstream responses", async () => {
    const oversizedMessages = JSON.stringify([
      {
        info: { id: "msg-user", role: "user" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { id: "msg-assistant", role: "assistant" },
        parts: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
      },
    ]);
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(Buffer.byteLength(oversizedMessages, "utf8")));
      res.end(oversizedMessages);
    });
    const upstreamPort = await listenNodeServer(upstream);
    const server = await startFixture({ opencodeBaseUrl: `http://127.0.0.1:${upstreamPort}` });

    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_opencode/sessions/sess_oversized`, {
      method: "DELETE",
      headers: { Authorization: "Bearer client-token" },
    });

    expect(response.status).toBe(502);
    const payload = await response.json() as { code: string };
    expect(payload.code).toBe("opencode_response_too_large");
  });

  test("OpenCode JSON helpers time out hung upstream requests", async () => {
    const previousTimeout = process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS;
    process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS = "250";
    try {
      const upstream = createServer((_req, _res) => {
        // Keep the socket open without sending headers.
      });
      const upstreamPort = await listenNodeServer(upstream);
      const server = await startFixture({ opencodeBaseUrl: `http://127.0.0.1:${upstreamPort}` });

      const controller = new AbortController();
      const startedAt = Date.now();
      const responsePromise = fetch(`http://127.0.0.1:${server.port}/workspace/ws_opencode/sessions/sess_hung`, {
        method: "DELETE",
        headers: { Authorization: "Bearer client-token" },
        signal: controller.signal,
      }).then(async (response) => ({
        kind: "response" as const,
        status: response.status,
        payload: await response.json().catch(() => null) as { code?: string } | null,
      }));

      const outcome = await Promise.race([
        responsePromise,
        new Promise<{ kind: "client-timeout" }>((resolve) => {
          setTimeout(() => {
            controller.abort();
            resolve({ kind: "client-timeout" });
          }, 1_200);
        }),
      ]);

      expect(outcome.kind).toBe("response");
      if (outcome.kind !== "response") return;
      expect(Date.now() - startedAt).toBeLessThan(1_100);
      expect(outcome.status).toBe(502);
      expect(outcome.payload?.code).toBe("opencode_request_timeout");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS;
      } else {
        process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  test("inbox upload rejects oversized multipart bodies before form parsing", async () => {
    const previousMaxBytes = process.env.VESLO_INBOX_MAX_BYTES;
    process.env.VESLO_INBOX_MAX_BYTES = "512";
    try {
      const server = await startFixture();
      const form = new FormData();
      form.append("file", new Blob(["x".repeat(2 * 1024)]), "large.txt");

      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/inbox`, {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
        },
        body: form,
      });

      expect(response.status).toBe(413);
      const payload = await response.json() as { code: string };
      expect(payload.code).toBe("payload_too_large");
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.VESLO_INBOX_MAX_BYTES;
      } else {
        process.env.VESLO_INBOX_MAX_BYTES = previousMaxBytes;
      }
    }
  });
});
