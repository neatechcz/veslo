import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER } from "../orchestrator-lifecycle-client.js";
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

const setEnvVarForTest = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  envRestores.push(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
};

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.message ?? "condition was not met before timeout");
}

const startTestServer = (input: {
  workspaceRoot: string;
  upstreamPort: number;
  workspaces?: Array<{ id: string; name: string; path: string; baseUrl?: string }>;
  orchestratorDaemonUrl?: string;
  orchestratorLifecycleToken?: string;
}) => {
  const workspaces = input.workspaces?.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    workspaceType: "local" as const,
    baseUrl: workspace.baseUrl ?? `http://127.0.0.1:${input.upstreamPort}`,
  })) ?? [
    {
      id: "ws_1",
      name: "Workspace",
      path: input.workspaceRoot,
      workspaceType: "local" as const,
      baseUrl: `http://127.0.0.1:${input.upstreamPort}`,
    },
  ];
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((workspace) => workspace.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    orchestratorDaemonUrl: input.orchestratorDaemonUrl,
    orchestratorLifecycleToken: input.orchestratorLifecycleToken,
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
  test("POST /workspace/:id/conversations/import backfills live OpenCode sessions for passive reads", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-import-"));
    tempDirs.push(workspaceRoot);
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: 9,
    });

    const importResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/import`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          sessions: [
            {
              id: "sess-live",
              title: "Live",
              parentID: null,
              time: { created: 100, updated: 200 },
            },
          ],
        }),
      },
    );
    expect(importResponse.status).toBe(200);

    const conversationsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations?directory=${encodeURIComponent(workspaceRoot)}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(conversationsResponse.status).toBe(200);
    const conversationsPayload = await conversationsResponse.json() as {
      source: string;
      items: Array<{ id: string; conversationId?: string; opencodeSessionId?: string }>;
    };
    expect(["sqlite", "unavailable"]).toContain(conversationsPayload.source);
    expect(conversationsPayload.items).toHaveLength(1);
    expect(conversationsPayload.items[0]?.id).toBe("sess-live");
    expect(conversationsPayload.items[0]?.conversationId).toMatch(/^conv-/);
    expect(conversationsPayload.items[0]?.opencodeSessionId).toBe("sess-live");
  });

  test("POST /workspace/:id/conversations derives opencode baseUrl from orchestrator daemon for local workspaces", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-orchestrator-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let upstreamPath = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamPath = url.pathname;
        if (request.method === "POST" && url.pathname === "/workspace/ws_orch/opencode/session") {
          return Response.json({
            id: "sess-orch",
            title: "Orchestrated",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${upstream.port}`,
      workspaces: [
        {
          id: "ws_orch",
          name: "Orchestrated",
          path: workspaceRoot,
          baseUrl: "",
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_orch/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Orchestrated",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(upstreamPath).toBe("/workspace/ws_orch/opencode/session");
    const payload = await response.json() as { id: string; opencodeSessionId: string };
    expect(payload.id).toBe("sess-orch");
    expect(payload.opencodeSessionId).toBe("sess-orch");
  });

  test("POST /workspace/:id/conversations retries stale local baseUrl through orchestrator daemon", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-orchestrator-stale-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let staleBaseUrlHit = false;
    const staleUpstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        staleBaseUrlHit = true;
        return Response.json({ error: "engine_not_running", workspaceId: "ws_old" }, { status: 503 });
      },
    });
    runningServers.push(staleUpstream as { stop?: (closeActiveConnections?: boolean) => void });

    let orchestratorPath = "";
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        orchestratorPath = url.pathname;
        if (request.method === "POST" && url.pathname === "/workspace/ws_orch_stale/opencode/session") {
          return Response.json({
            id: "sess-orch-stale",
            title: "Orchestrated stale",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: staleUpstream.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      workspaces: [
        {
          id: "ws_orch_stale",
          name: "Orchestrated stale",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${staleUpstream.port}/workspace/ws_old/opencode`,
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_orch_stale/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Orchestrated stale",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(staleBaseUrlHit).toBe(true);
    expect(orchestratorPath).toBe("/workspace/ws_orch_stale/opencode/session");
    const payload = await response.json() as { id: string; opencodeSessionId: string };
    expect(payload.id).toBe("sess-orch-stale");
    expect(payload.opencodeSessionId).toBe("sess-orch-stale");
  });

  test("POST /workspace/:id/conversations ignores persisted empty workspace opencode mount", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-empty-mount-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let malformedBaseUrlHit = false;
    const malformed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        malformedBaseUrlHit = true;
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    runningServers.push(malformed as { stop?: (closeActiveConnections?: boolean) => void });

    let orchestratorPath = "";
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        orchestratorPath = url.pathname;
        if (request.method === "POST" && url.pathname === "/workspace/ws_empty_mount/opencode/session") {
          return Response.json({
            id: "sess-empty-mount",
            title: "Recovered empty mount",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: malformed.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      workspaces: [
        {
          id: "ws_empty_mount",
          name: "Empty mount",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${malformed.port}/workspace//opencode`,
        },
      ],
    });

    const listResponse = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
      headers: { Authorization: "Bearer client-token" },
    });
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json() as {
      items: Array<{ id: string; baseUrl?: string; opencode?: { baseUrl?: string } }>;
    };
    const listed = listPayload.items.find((item) => item.id === "ws_empty_mount");
    expect(listed?.baseUrl).toBe(`http://127.0.0.1:${orchestrator.port}/workspace/ws_empty_mount/opencode`);
    expect(listed?.opencode?.baseUrl).toBe(`http://127.0.0.1:${orchestrator.port}/workspace/ws_empty_mount/opencode`);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_empty_mount/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Recovered empty mount",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(malformedBaseUrlHit).toBe(false);
    expect(orchestratorPath).toBe("/workspace/ws_empty_mount/opencode/session");
    const payload = await response.json() as { id: string; opencodeSessionId: string };
    expect(payload.id).toBe("sess-empty-mount");
    expect(payload.opencodeSessionId).toBe("sess-empty-mount");
  });

  test("POST /workspace/:id/conversations/:conversationId/runs queues and drains when lifecycle has an active run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-queue-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const engineSubmits: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-queued",
            title: "Queued",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-queued/prompt_async") {
          engineSubmits.push(url.pathname);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    let lifecycleStatus = "running";
    const orchestratorRequests: string[] = [];
    const registerRequests: string[] = [];
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        orchestratorRequests.push(`${request.method} ${url.pathname}`);
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (
          request.method === "GET" &&
          url.pathname.endsWith("/runs/active")
        ) {
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: "conv-active",
            runId: "run-active",
            status: "running",
            stale: false,
          });
        }
        if (
          request.method === "GET" &&
          url.pathname.endsWith("/runs/latest")
        ) {
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: "conv-active",
            runId: "run-active",
            status: lifecycleStatus,
            stale: false,
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          registerRequests.push(typeof body?.runId === "string" ? body.runId : "");
          lifecycleStatus = "running";
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: "running", stale: false });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Queued",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "X-Veslo-Send-Trace-Id": "send-queued",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          clientMessageId: "msg-queued",
          parts: [{ type: "text", text: "Queue me" }],
        }),
      },
    );
    expect(runResponse.status).toBe(202);
    const payload = await runResponse.json() as {
      status?: string;
      queueItemId?: string;
      activeRunId?: string;
      queuePosition?: number;
      debugTrace?: Array<{ event: string }>;
    };
    expect(payload.status).toBe("queued");
    expect(payload.queueItemId).toMatch(/^queue_/);
    expect(payload.activeRunId).toBe("run-active");
    expect(payload.queuePosition).toBe(1);
    expect(payload.debugTrace?.some((entry) => entry.event === "server:conversation-run:queued")).toBe(true);
    expect(engineSubmits).toEqual([]);
    expect(registerRequests).toEqual([]);
    expect(orchestratorRequests.some((entry) => entry.endsWith("/runs/active"))).toBe(true);

    lifecycleStatus = "completed";
    await waitForCondition(
      () => engineSubmits.length > 0,
      { timeoutMs: 3_000, message: "expected queued run to drain after active run completed" },
    );
    expect(registerRequests).toHaveLength(1);
    expect(engineSubmits).toEqual(["/session/sess-queued/prompt_async"]);
  });

  test("POST /workspace/:id/sessions/:sessionId/transcript reconciles lifecycle and wakes queued runs", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-transcript-reconcile-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const engineSubmits: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-transcript-reconcile",
            title: "Transcript reconcile",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-transcript-reconcile/prompt_async") {
          engineSubmits.push(url.pathname);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    let lifecycleStatus = "running";
    let latestRequests = 0;
    const registerRequests: string[] = [];
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/runs/active")) {
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: "conv-active",
            runId: "run-active",
            status: "running",
            stale: false,
          });
        }
        if (request.method === "GET" && url.pathname.endsWith("/runs/latest")) {
          latestRequests += 1;
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: "conv-active",
            runId: "run-active",
            status: lifecycleStatus,
            stale: false,
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          registerRequests.push(typeof body?.runId === "string" ? body.runId : "");
          lifecycleStatus = "running";
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: "running", stale: false });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });
    const headers = {
      Authorization: "Bearer client-token",
      "Content-Type": "application/json",
    };

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Transcript reconcile",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversationId: string;
      opencodeSessionId: string;
    };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          clientMessageId: "msg-transcript-queued",
          parts: [{ type: "text", text: "Queue then drain" }],
        }),
      },
    );
    expect(runResponse.status).toBe(202);
    expect(engineSubmits).toEqual([]);

    lifecycleStatus = "completed";
    const appendResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${encodeURIComponent(created.opencodeSessionId)}/transcript`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          directory: workspaceRoot,
          reason: "session.idle",
          messages: [
            {
              id: "msg-user",
              sessionID: created.opencodeSessionId,
              role: "user",
              time: { created: 1_000 },
            },
            {
              id: "msg-assistant",
              sessionID: created.opencodeSessionId,
              role: "assistant",
              time: { created: 2_000, completed: 3_000 },
            },
          ],
          partsByMessageId: {
            "msg-user": [],
            "msg-assistant": [],
          },
        }),
      },
    );
    expect(appendResponse.status).toBe(200);

    await waitForCondition(
      () => latestRequests > 0 && engineSubmits.length > 0,
      { timeoutMs: 1_000, message: "expected terminal transcript append to wake queued run before poll interval" },
    );
    expect(registerRequests).toHaveLength(1);
    expect(engineSubmits).toEqual(["/session/sess-transcript-reconcile/prompt_async"]);
  });

  test.if(process.platform === "win32")("POST /workspace/:id/conversations accepts Windows directory casing differences", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "Veslo-Server-Conversations-Case-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-case",
            title: "Case",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      workspaces: [
        {
          id: "ws_case",
          name: "Case",
          path: workspaceRoot.toLowerCase(),
          baseUrl: `http://127.0.0.1:${upstream.port}`,
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_case/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Case",
        }),
      },
    );

    expect(response.status).toBe(201);
    const payload = await response.json() as { id: string };
    expect(payload.id).toBe("sess-case");
  });

  test("POST /workspace/:id/conversations creates an engine session and persists a binding", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-workspace-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let upstreamHits = 0;
    const receivedBodies: Array<Record<string, unknown>> = [];
    const receivedDirectoryHeaders: string[] = [];
    const receivedRunPaths: string[] = [];
    const receivedRunDirectories: string[] = [];
    const receivedAbortPaths: string[] = [];
    const receivedAbortDirectories: string[] = [];
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
        if (request.method === "POST" && url.pathname === "/session/sess-created/abort") {
          upstreamHits += 1;
          receivedAbortPaths.push(`${url.pathname}${url.search}`);
          receivedAbortDirectories.push(request.headers.get("x-opencode-directory") ?? "");
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
          sessionID: "must-not-forward",
          extra: "must-not-forward",
          clientMessageId: "msg-client-1",
          origin: "session:normal",
          parts: [{ type: "text", text: "Hello" }],
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    const runPayload = await runResponse.json() as {
      ok: boolean;
      conversationId: string;
      opencodeSessionId: string;
      runId: string;
      clientMessageId?: string | null;
      origin?: string | null;
      status: string;
      kind: string;
    };
    expect(runPayload.ok).toBe(true);
    expect(runPayload.conversationId).toBe(payload.conversationId);
    expect(runPayload.opencodeSessionId).toBe("sess-created");
    expect(runPayload.status).toBe("submitted");
    expect(runPayload.kind).toBe("prompt_async");
    expect(runPayload.clientMessageId).toBe("msg-client-1");
    expect(runPayload.origin).toBe("session:normal");
    expect(receivedRunPaths[0]).toBe(`/session/sess-created/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`);
    expect(receivedRunDirectories[0]).toBe(workspaceRoot);
    expect(receivedBodies[1]?.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(receivedBodies[1]?.messageID).toBeUndefined();
    expect(receivedBodies[1]?.directory).toBeUndefined();
    expect(receivedBodies[1]?.kind).toBeUndefined();
    expect(receivedBodies[1]?.sessionID).toBeUndefined();
    expect(receivedBodies[1]?.extra).toBeUndefined();
    expect(receivedBodies[1]?.clientMessageId).toBeUndefined();
    expect(receivedBodies[1]?.origin).toBeUndefined();

    const abortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(payload.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          runId: runPayload.runId,
        }),
      },
    );
    expect(abortResponse.status).toBe(200);
    const abortPayload = await abortResponse.json() as {
      ok: boolean;
      conversationId: string;
      opencodeSessionId: string;
      runId: string;
      status: string;
      kind: string;
    };
    expect(abortPayload.ok).toBe(true);
    expect(abortPayload.conversationId).toBe(payload.conversationId);
    expect(abortPayload.opencodeSessionId).toBe("sess-created");
    expect(abortPayload.runId).toBe(runPayload.runId);
    expect(abortPayload.status).toBe("submitted");
    expect(abortPayload.kind).toBe("abort");
    expect(receivedAbortPaths[0]).toBe(`/session/sess-created/abort?directory=${encodeURIComponent(workspaceRoot)}`);
    expect(receivedAbortDirectories[0]).toBe(workspaceRoot);

    const missingRunIdAbortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(payload.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
        }),
      },
    );
    expect(missingRunIdAbortResponse.status).toBe(400);

    const missingDirectoryAbortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(payload.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId: runPayload.runId,
        }),
      },
    );
    expect(missingDirectoryAbortResponse.status).toBe(400);

    const missingDirectoryRunResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(payload.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          parts: [{ type: "text", text: "Hello" }],
        }),
      },
    );
    expect(missingDirectoryRunResponse.status).toBe(400);
    expect(upstreamHits).toBe(3);
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

  test("POST /workspace/:id/conversations/:conversationId/runs rejects conversation ids from another workspace before engine contact", async () => {
    const workspaceRootA = await mkdtemp(join(tmpdir(), "veslo-server-conversations-workspace-a-"));
    const workspaceRootB = await mkdtemp(join(tmpdir(), "veslo-server-conversations-workspace-b-"));
    tempDirs.push(workspaceRootA, workspaceRootB);
    await useTempVesloDataDir();

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamHits += 1;
        if (request.method === "POST" && url.pathname === "/session") {
          const receivedBody = await request.json() as Record<string, unknown>;
          return Response.json({
            id: "sess-created-a",
            title: receivedBody.title,
            directory: receivedBody.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        return Response.json({ error: "run must not reach upstream" }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot: workspaceRootA,
      upstreamPort: upstream.port,
      workspaces: [
        { id: "ws_a", name: "Workspace A", path: workspaceRootA },
        { id: "ws_b", name: "Workspace B", path: workspaceRootB },
      ],
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_a/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRootA,
          title: "Workspace A Conversation",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };
    expect(created.conversationId).toMatch(/^conv-/);
    expect(upstreamHits).toBe(1);

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_b/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRootB,
          parts: [{ type: "text", text: "Should not run" }],
        }),
      },
    );
    expect(runResponse.status).toBe(404);
    expect(upstreamHits).toBe(1);

    const abortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_b/conversations/${encodeURIComponent(created.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRootB,
          runId: "run-from-workspace-a",
        }),
      },
    );
    expect(abortResponse.status).toBe(404);
    expect(upstreamHits).toBe(1);
  });

  test("conversation runs delegate lifecycle to orchestrator before engine submit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-lifecycle-workspace-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const events: string[] = [];
    let submitShouldFail = false;
    let registerShouldConflict = false;
    let runIdFromRegister = "";
    let conversationIdFromRegister = "";
    const orchestratorRequests: Array<{
      method: string;
      pathname: string;
      token: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const engineRequests: Array<{
      method: string;
      pathname: string;
      search: string;
      body: Record<string, unknown> | null;
    }> = [];

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        engineRequests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session") {
          events.push("engine-create-session");
          return Response.json({
            id: "sess-created",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session/sess-created/prompt_async") {
          events.push(submitShouldFail ? "engine-submit-failed" : "engine-submit");
          if (submitShouldFail) {
            return Response.json({ error: "submit failed" }, { status: 500 });
          }
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session/sess-created/abort") {
          events.push("engine-abort");
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        orchestratorRequests.push({
          method: request.method,
          pathname: url.pathname,
          token: request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER),
          body,
        });
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          events.push("orchestrator-register");
          if (registerShouldConflict) {
            return Response.json({ error: "run_already_active", activeRunId: "run-active" }, { status: 409 });
          }
          runIdFromRegister = typeof body?.runId === "string" ? body.runId : "";
          conversationIdFromRegister = typeof body?.conversationId === "string" ? body.conversationId : "";
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: "running", stale: false });
        }
        if (request.method === "POST" && url.pathname === `/workspace/ws_1/runs/${encodeURIComponent(runIdFromRegister)}/failed`) {
          events.push("orchestrator-mark-failed");
          return Response.json({ ok: true, runId: runIdFromRegister, status: "failed" });
        }
        if (request.method === "POST" && url.pathname === `/workspace/ws_1/runs/${encodeURIComponent(runIdFromRegister)}/abort-requested`) {
          events.push("orchestrator-abort-requested");
          return Response.json({ ok: true, runId: runIdFromRegister, abortRequested: true });
        }
        if (
          request.method === "GET" &&
          url.pathname === `/workspace/ws_1/conversations/${encodeURIComponent(conversationIdFromRegister)}/runs/latest`
        ) {
          events.push("orchestrator-status");
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: conversationIdFromRegister,
            runId: runIdFromRegister,
            status: "completed",
            stale: false,
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_stale/opencode`,
        },
      ],
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Lifecycle Conversation",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "X-Veslo-Send-Trace-Id": "send-trace-abc",
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
      runId: string;
      conversationId: string;
      debugTrace?: Array<{
        source: string;
        event: string;
        traceId?: string;
        durationMs?: number;
      }>;
    };
    expect(runPayload.runId).toBe(runIdFromRegister);
    expect(runPayload.conversationId).toBe(created.conversationId);
    expect(runPayload.debugTrace?.some((entry) =>
      entry.source === "server" &&
      entry.event === "server:conversation-run:resolve-target" &&
      entry.traceId === "send-trace-abc" &&
      typeof entry.durationMs === "number"
    )).toBe(true);
    expect(runPayload.debugTrace?.some((entry) =>
      entry.source === "server" &&
      entry.event === "server:conversation-run:lifecycle-register" &&
      entry.traceId === "send-trace-abc" &&
      typeof entry.durationMs === "number"
    )).toBe(true);
    expect(runPayload.debugTrace?.some((entry) =>
      entry.source === "server" &&
      entry.event === "server:conversation-run:opencode-submit" &&
      entry.traceId === "send-trace-abc" &&
      typeof entry.durationMs === "number"
    )).toBe(true);
    expect(events.indexOf("orchestrator-register")).toBeLessThan(events.indexOf("engine-submit"));
    const registerRequest = orchestratorRequests.find((entry) => entry.pathname === "/workspace/ws_1/runs/register");
    expect(registerRequest?.token).toBe("lifecycle-token");
    expect(registerRequest?.body?.kind).toBe("prompt");
    expect(registerRequest?.body?.engineSessionId).toBe("sess-created");
    expect(engineRequests.some((entry) =>
      entry.pathname === "/workspace/ws_1/opencode/session/sess-created/prompt_async"
    )).toBe(true);

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs/latest`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    expect(statusResponse.status).toBe(200);
    const statusPayload = await statusResponse.json() as { runId: string; status: string; stale: boolean };
    expect(statusPayload.runId).toBe(runIdFromRegister);
    expect(statusPayload.status).toBe("completed");
    expect(statusPayload.stale).toBe(false);

    const abortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          runId: runPayload.runId,
        }),
      },
    );
    expect(abortResponse.status).toBe(200);
    expect(events.indexOf("engine-abort")).toBeLessThan(events.indexOf("orchestrator-abort-requested"));

    submitShouldFail = true;
    const failedRunResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Fail" }],
        }),
      },
    );
    expect(failedRunResponse.status).toBe(502);
    expect(events.indexOf("engine-submit-failed")).toBeLessThan(events.indexOf("orchestrator-mark-failed"));

    registerShouldConflict = true;
    const engineRequestsBeforeConflict = engineRequests.length;
    const conflictResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Conflict" }],
        }),
      },
    );
    expect(conflictResponse.status).toBe(202);
    const conflictPayload = await conflictResponse.json() as {
      status?: string;
      activeRunId?: string | null;
      queueItemId?: string;
      queuePosition?: number;
    };
    expect(conflictPayload.status).toBe("queued");
    expect(conflictPayload.activeRunId).toBe("run-active");
    expect(conflictPayload.queueItemId).toMatch(/^queue_/);
    expect(conflictPayload.queuePosition).toBe(1);
    expect(engineRequests).toHaveLength(engineRequestsBeforeConflict);
  });

  test("managed prompt runs fail fast when the expected AI gateway provider request never starts", async () => {
    setEnvVarForTest("VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS", "25");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-gateway-start-watch-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let runIdFromRegister = "";
    let conversationIdFromRegister = "";
    let lifecycleStatus = "running";
    let serverPort = 0;
    let providerFetchError = "";
    const failedRequests: Array<Record<string, unknown> | null> = [];
    const abortRequests: string[] = [];
    const providerRequests: Array<{
      authorization: string | null;
      sessionId: string | null;
      workspaceId: string | null;
      gatewayToken: string | null;
      body: unknown;
    }> = [];

    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
          const requestBody = await request.json().catch(() => null) as unknown;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            gatewayToken: request.headers.get("x-veslo-gateway-token"),
            body: requestBody,
          });
          return Response.json({
            id: "chatcmpl_sessionless_watchdog",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.5",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          });
        }
        return Response.json({ error: "unexpected gateway route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(gateway as { stop?: (closeActiveConnections?: boolean) => void });
    setEnvVarForTest("VESLO_AI_GATEWAY_BASE_URL", `http://127.0.0.1:${gateway.port}`);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session") {
          return Response.json({
            id: "sess-watch",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session/sess-watch/prompt_async") {
          void fetch(`http://127.0.0.1:${serverPort}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: "Bearer client-token",
              "Content-Type": "application/json",
              "x-veslo-gateway-token": "gateway-access-token",
              "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
            },
            body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "Sessionless" }] }),
          }).catch((error) => {
            providerFetchError = error instanceof Error ? error.message : String(error);
          });
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session/sess-watch/abort") {
          abortRequests.push(url.searchParams.get("directory") ?? "");
          return Response.json({ ok: true, aborted: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          runIdFromRegister = typeof body?.runId === "string" ? body.runId : "";
          conversationIdFromRegister = typeof body?.conversationId === "string" ? body.conversationId : "";
          lifecycleStatus = "running";
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: lifecycleStatus, stale: false });
        }
        if (request.method === "POST" && url.pathname === `/workspace/ws_1/runs/${encodeURIComponent(runIdFromRegister)}/failed`) {
          failedRequests.push(body);
          lifecycleStatus = "failed";
          return Response.json({ ok: true, runId: runIdFromRegister, status: lifecycleStatus });
        }
        if (
          request.method === "GET" &&
          url.pathname === `/workspace/ws_1/conversations/${encodeURIComponent(conversationIdFromRegister)}/runs/${encodeURIComponent(runIdFromRegister)}`
        ) {
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: conversationIdFromRegister,
            runId: runIdFromRegister,
            status: lifecycleStatus,
            stale: false,
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_stale/opencode`,
        },
      ],
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Gateway Watch",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };
    serverPort = server.port;

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
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
          expectAiGatewayStart: true,
        }),
      },
    );
    expect(runResponse.status).toBe(504);
    const runPayload = await runResponse.json() as { code?: string; message?: string };
    expect(runPayload.code).toBe("ai_gateway_provider_start_timeout");
    expect(runPayload.message).toContain("AI gateway provider request did not start");

    await waitForCondition(
      () => providerRequests.length > 0 || Boolean(providerFetchError),
      { timeoutMs: 1_000, message: "expected sessionless provider request to be proxied" },
    );
    expect(providerFetchError).toBe("");
    expect(providerRequests).toEqual([
      {
        authorization: "Bearer gateway-access-token",
        sessionId: "${OPENCODE_SESSION_ID}",
        workspaceId: null,
        gatewayToken: null,
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Sessionless" }],
        },
      },
    ]);

    await waitForCondition(
      () => failedRequests.length > 0,
      { timeoutMs: 1_000, message: "expected gateway provider start watchdog to mark the run failed" },
    );
    expect(String(failedRequests[0]?.error ?? "")).toContain("AI gateway provider request did not start");
    expect(abortRequests).toEqual([workspaceRoot]);
  });

  test("managed prompt provider-start watchdog matches placeholder session ids by workspace header", async () => {
    setEnvVarForTest("VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS", "500");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-gateway-workspace-watch-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let serverPort = 0;
    let runIdFromRegister = "";
    let conversationIdFromRegister = "";
    let lifecycleStatus = "running";
    let providerFetchError = "";
    const failedRequests: Array<Record<string, unknown> | null> = [];
    const abortRequests: string[] = [];
    const providerRequests: Array<{
      authorization: string | null;
      sessionId: string | null;
      workspaceId: string | null;
      sendTraceId: string | null;
      gatewayToken: string | null;
      body: unknown;
    }> = [];

    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
          const requestBody = await request.json().catch(() => null) as unknown;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            sendTraceId: request.headers.get("x-veslo-send-trace-id"),
            gatewayToken: request.headers.get("x-veslo-gateway-token"),
            body: requestBody,
          });
          return Response.json({
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.5",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          });
        }
        return Response.json({ error: "unexpected gateway route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(gateway as { stop?: (closeActiveConnections?: boolean) => void });
    setEnvVarForTest("VESLO_AI_GATEWAY_BASE_URL", `http://127.0.0.1:${gateway.port}`);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session") {
          return Response.json({
            id: "sess-placeholder-watch",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (
          request.method === "POST" &&
          url.pathname === "/workspace/ws_1/opencode/session/sess-placeholder-watch/prompt_async"
        ) {
          void fetch(`http://127.0.0.1:${serverPort}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: "Bearer client-token",
              "Content-Type": "application/json",
              "x-veslo-gateway-token": "gateway-access-token",
              "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
              "x-veslo-workspace-id": "ws_1",
              "x-veslo-send-trace-id": request.headers.get("x-veslo-send-trace-id") ?? "missing-trace",
            },
            body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "Hello" }] }),
          }).catch((error) => {
            providerFetchError = error instanceof Error ? error.message : String(error);
          });
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session/sess-placeholder-watch/abort") {
          abortRequests.push(url.searchParams.get("directory") ?? "");
          return Response.json({ ok: true, aborted: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          runIdFromRegister = typeof body?.runId === "string" ? body.runId : "";
          conversationIdFromRegister = typeof body?.conversationId === "string" ? body.conversationId : "";
          lifecycleStatus = "running";
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: lifecycleStatus, stale: false });
        }
        if (request.method === "POST" && url.pathname === `/workspace/ws_1/runs/${encodeURIComponent(runIdFromRegister)}/failed`) {
          failedRequests.push(body);
          lifecycleStatus = "failed";
          return Response.json({ ok: true, runId: runIdFromRegister, status: lifecycleStatus });
        }
        if (
          request.method === "GET" &&
          url.pathname === `/workspace/ws_1/conversations/${encodeURIComponent(conversationIdFromRegister)}/runs/${encodeURIComponent(runIdFromRegister)}`
        ) {
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: conversationIdFromRegister,
            runId: runIdFromRegister,
            status: lifecycleStatus,
            stale: false,
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_1/opencode`,
        },
      ],
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });
    serverPort = server.port;

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "X-Veslo-Send-Trace-Id": "send-workflow-test",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Gateway Workspace Watch",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
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
          expectAiGatewayStart: true,
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    await waitForCondition(
      () => providerRequests.length > 0 || Boolean(providerFetchError),
      { timeoutMs: 1_000, message: "expected provider request to reach the managed gateway proxy" },
    );
    expect(providerFetchError).toBe("");
    expect(providerRequests).toEqual([
      {
        authorization: "Bearer gateway-access-token",
        sessionId: "sess-placeholder-watch",
        workspaceId: null,
        sendTraceId: null,
        gatewayToken: null,
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Hello" }],
        },
      },
    ]);
    expect(failedRequests).toEqual([]);
    expect(abortRequests).toEqual([]);
  });

  test("managed prompt provider-start watchdog prefers OpenCode session id over stale workspace headers", async () => {
    setEnvVarForTest("VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS", "500");
    const workspaceRootTarget = await mkdtemp(join(tmpdir(), "veslo-server-gateway-target-watch-"));
    const workspaceRootStale = await mkdtemp(join(tmpdir(), "veslo-server-gateway-stale-watch-"));
    tempDirs.push(workspaceRootTarget, workspaceRootStale);
    await useTempVesloDataDir();

    let serverPort = 0;
    let providerFetchError = "";
    let stalePromptSubmitted = false;
    const failedRequests: Array<{ workspaceId: string; body: Record<string, unknown> | null }> = [];
    const providerRequests: Array<{
      authorization: string | null;
      sessionId: string | null;
      workspaceId: string | null;
      body: unknown;
    }> = [];

    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
          const requestBody = await request.json().catch(() => null) as unknown;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            body: requestBody,
          });
          return Response.json({
            id: "chatcmpl_target",
            object: "chat.completion",
            created: 1,
            model: "gpt-5.5",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          });
        }
        return Response.json({ error: "unexpected gateway route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(gateway as { stop?: (closeActiveConnections?: boolean) => void });
    setEnvVarForTest("VESLO_AI_GATEWAY_BASE_URL", `http://127.0.0.1:${gateway.port}`);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.method === "POST" && url.pathname === "/workspace/ws_target/opencode/session") {
          return Response.json({
            id: "sess-target",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_stale/opencode/session") {
          return Response.json({
            id: "sess-stale",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_stale/opencode/session/sess-stale/prompt_async") {
          stalePromptSubmitted = true;
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_target/opencode/session/sess-target/prompt_async") {
          void fetch(`http://127.0.0.1:${serverPort}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: "Bearer client-token",
              "Content-Type": "application/json",
              "x-veslo-gateway-token": "gateway-access-token",
              "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
              "x-veslo-workspace-id": "ws_stale",
              "x-session-id": "sess-target",
              "x-veslo-send-trace-id": request.headers.get("x-veslo-send-trace-id") ?? "missing-trace",
            },
            body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "Hello" }] }),
          }).catch((error) => {
            providerFetchError = error instanceof Error ? error.message : String(error);
          });
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname.endsWith("/abort")) {
          return Response.json({ ok: true, aborted: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const runsByWorkspace = new Map<string, { runId: string; conversationId: string; status: string }>();
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const registerMatch = url.pathname.match(/^\/workspace\/([^/]+)\/runs\/register$/);
        if (request.method === "POST" && registerMatch?.[1]) {
          const workspaceId = decodeURIComponent(registerMatch[1]);
          const state = {
            runId: typeof body?.runId === "string" ? body.runId : "",
            conversationId: typeof body?.conversationId === "string" ? body.conversationId : "",
            status: "running",
          };
          runsByWorkspace.set(workspaceId, state);
          return Response.json({ ok: true, ...body, workspaceId, status: state.status, stale: false });
        }

        const failedMatch = url.pathname.match(/^\/workspace\/([^/]+)\/runs\/([^/]+)\/failed$/);
        if (request.method === "POST" && failedMatch?.[1]) {
          const workspaceId = decodeURIComponent(failedMatch[1]);
          const state = runsByWorkspace.get(workspaceId);
          if (state) state.status = "failed";
          failedRequests.push({ workspaceId, body });
          return Response.json({
            ok: true,
            workspaceId,
            runId: decodeURIComponent(failedMatch[2] ?? ""),
            status: "failed",
          });
        }

        const activeMatch = url.pathname.match(/^\/workspace\/([^/]+)\/conversations\/([^/]+)\/runs\/([^/]+)$/);
        if (request.method === "GET" && activeMatch?.[1]) {
          const workspaceId = decodeURIComponent(activeMatch[1]);
          const state = runsByWorkspace.get(workspaceId);
          if (!state && activeMatch[3] === "active") {
            return Response.json({
              ok: true,
              workspaceId,
              conversationId: decodeURIComponent(activeMatch[2] ?? ""),
              runId: null,
              status: "completed",
              stale: false,
            });
          }
          return Response.json({
            ok: true,
            workspaceId,
            conversationId: state?.conversationId ?? decodeURIComponent(activeMatch[2] ?? ""),
            runId: state?.runId ?? decodeURIComponent(activeMatch[3] ?? ""),
            status: state?.status ?? "running",
            stale: false,
          });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot: workspaceRootTarget,
      upstreamPort: upstream.port,
      workspaces: [
        {
          id: "ws_target",
          name: "Target",
          path: workspaceRootTarget,
          baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_target/opencode`,
        },
        {
          id: "ws_stale",
          name: "Stale",
          path: workspaceRootStale,
          baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_stale/opencode`,
        },
      ],
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
    });
    serverPort = server.port;

    const createConversation = async (workspaceId: string, directory: string, title: string) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/${workspaceId}/conversations`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer client-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ directory, title }),
        },
      );
      expect(response.status).toBe(201);
      return await response.json() as { conversationId: string };
    };

    const staleConversation = await createConversation("ws_stale", workspaceRootStale, "Stale Workspace");
    const targetConversation = await createConversation("ws_target", workspaceRootTarget, "Target Workspace");

    const staleRunPromise = fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_stale/conversations/${encodeURIComponent(staleConversation.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRootStale,
          parts: [{ type: "text", text: "Stale" }],
          expectAiGatewayStart: true,
        }),
      },
    ).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

    await waitForCondition(
      () => runsByWorkspace.has("ws_stale") && stalePromptSubmitted,
      { timeoutMs: 1_000, message: "expected stale workspace run to be registered and waiting" },
    );

    const targetRunResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_target/conversations/${encodeURIComponent(targetConversation.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRootTarget,
          parts: [{ type: "text", text: "Hello" }],
          expectAiGatewayStart: true,
        }),
      },
    );
    expect(targetRunResponse.status).toBe(200);

    await waitForCondition(
      () => providerRequests.length > 0 || Boolean(providerFetchError),
      { timeoutMs: 1_000, message: "expected target provider request to reach the managed gateway proxy" },
    );
    expect(providerFetchError).toBe("");
    expect(providerRequests).toEqual([
      {
        authorization: "Bearer gateway-access-token",
        sessionId: "sess-target",
        workspaceId: null,
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Hello" }],
        },
      },
    ]);
    expect(failedRequests.some((entry) => entry.workspaceId === "ws_target")).toBe(false);

    const staleRun = await staleRunPromise;
    expect(staleRun.status).toBe(504);
    expect(failedRequests.some((entry) => entry.workspaceId === "ws_stale")).toBe(true);
  });
});
