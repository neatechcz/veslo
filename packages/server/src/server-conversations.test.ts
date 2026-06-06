import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { startServer } from "./server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore cleanup errors in tests
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

const useTempVesloDataDir = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-server-conversations-data-"));
  tempDirs.push(dataDir);
  const previous = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previous === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previous;
    }
  });
  return dataDir;
};

const startTestServer = (input: { workspaceRoot: string; upstreamPort: number }) => {
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
        path: input.workspaceRoot,
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${input.upstreamPort}`,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
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
};

describe("conversation routes", () => {
  test("POST /workspace/:id/conversations creates an engine session and persists a binding", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-workspace-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let upstreamHits = 0;
    const receivedBodies: Array<Record<string, unknown>> = [];
    const receivedDirectoryHeaders: string[] = [];
    const receivedRunPaths: string[] = [];
    const receivedRunDirectories: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          upstreamHits += 1;
          receivedDirectoryHeaders.push(request.headers.get("x-opencode-directory") ?? "");
          const receivedBody = await request.json() as Record<string, unknown>;
          receivedBodies.push(receivedBody);
          return Response.json({
            id: "sess-created",
            title: receivedBody.title,
            directory: receivedBody.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-created/prompt_async") {
          upstreamHits += 1;
          receivedRunPaths.push(`${url.pathname}${url.search}`);
          receivedRunDirectories.push(request.headers.get("x-opencode-directory") ?? "");
          const receivedBody = await request.json() as Record<string, unknown>;
          receivedBodies.push(receivedBody);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route" }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({ workspaceRoot, upstreamPort: upstream.port });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Created Conversation",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(upstreamHits).toBe(1);
    expect(receivedDirectoryHeaders[0]).toBe(workspaceRoot);
    expect(receivedBodies[0]?.directory).toBe(workspaceRoot);
    expect(receivedBodies[0]?.title).toBe("Created Conversation");

    const payload = await response.json() as {
      id: string;
      workspaceId: string;
      conversationId: string;
      opencodeSessionId: string;
      directory: string;
      title: string;
    };
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.id).toBe("sess-created");
    expect(payload.opencodeSessionId).toBe("sess-created");
    expect(payload.conversationId).toMatch(/^conv-/);
    expect(payload.directory).toBe(workspaceRoot);
    expect(payload.title).toBe("Created Conversation");

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${encodeURIComponent(payload.conversationId)}/transcript?limit=1`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(transcriptResponse.status).toBe(200);
    const transcriptPayload = await transcriptResponse.json() as {
      sessionId: string;
      conversationId?: string;
      opencodeSessionId?: string;
    };
    expect(transcriptPayload.sessionId).toBe("sess-created");
    expect(transcriptPayload.conversationId).toBe(payload.conversationId);
    expect(transcriptPayload.opencodeSessionId).toBe("sess-created");

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(payload.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Hello" }],
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    const runPayload = await runResponse.json() as {
      ok: boolean;
      conversationId: string;
      opencodeSessionId: string;
      status: string;
      kind: string;
    };
    expect(runPayload.ok).toBe(true);
    expect(runPayload.conversationId).toBe(payload.conversationId);
    expect(runPayload.opencodeSessionId).toBe("sess-created");
    expect(runPayload.status).toBe("submitted");
    expect(runPayload.kind).toBe("prompt_async");
    expect(receivedRunPaths[0]).toBe(`/session/sess-created/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`);
    expect(receivedRunDirectories[0]).toBe(workspaceRoot);
    expect(receivedBodies[1]?.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(receivedBodies[1]?.directory).toBeUndefined();
  });

  test("POST /workspace/:id/conversations rejects directories outside the workspace before engine contact", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-workspace-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return Response.json({ id: "should-not-happen" });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({ workspaceRoot, upstreamPort: upstream.port });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: join(tmpdir(), "veslo-outside"),
          title: "Rejected",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(upstreamHits).toBe(0);
  });
});
