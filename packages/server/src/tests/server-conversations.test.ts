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
    expect(receivedBodies[1]?.kind).toBeUndefined();
    expect(receivedBodies[1]?.sessionID).toBeUndefined();
    expect(receivedBodies[1]?.extra).toBeUndefined();

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
    expect(orchestratorRequests[0]?.token).toBe("lifecycle-token");
    expect(orchestratorRequests[0]?.body?.kind).toBe("prompt");
    expect(orchestratorRequests[0]?.body?.engineSessionId).toBe("sess-created");
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
    expect(conflictResponse.status).toBe(409);
    expect(engineRequests).toHaveLength(engineRequestsBeforeConflict);
  });
});
