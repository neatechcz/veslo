import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test } from "bun:test";

import { ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER } from "./orchestrator-lifecycle-client.js";
import { startServer } from "./server.js";

type RunKind = "prompt" | "command" | "shell" | "summarize";

type RunRecord = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  engineSessionId: string;
  directory: string;
  kind: RunKind;
  status: "submitted" | "running" | "blocked" | "completed" | "failed" | "aborted";
  abortRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

type RunStoreLike = {
  insert(record: RunRecord): void;
  update(
    workspaceId: string,
    runId: string,
    patch: Partial<Omit<RunRecord, "workspaceId" | "runId">>,
  ): RunRecord | null;
  get(workspaceId: string, runId: string): RunRecord | null;
  latestForConversation(workspaceId: string, conversationId: string): RunRecord | null;
  activeForConversation(workspaceId: string, conversationId: string): RunRecord | null;
};

type RunAlreadyActiveErrorLike = Error & {
  activeRunId: string;
};

async function loadOrchestratorRunModules() {
  const orchestratorSrc = new URL("../../orchestrator/src/", import.meta.url).href;
  const [probeModule, registryModule, storeModule] = await Promise.all([
    import(`${orchestratorSrc}run-activity-probe.ts`),
    import(`${orchestratorSrc}run-registry.ts`),
    import(`${orchestratorSrc}run-store.ts`),
  ]) as Array<Record<string, unknown>>;

  return {
    createRunActivityProbe: probeModule.createRunActivityProbe as (deps: {
      getEngine: (workspaceId: string) => { baseUrl: string };
      buildEngineRequest: (
        engine: { baseUrl: string },
        input: { workspaceId: string; directory: string; targetPath: string; method: "GET" },
      ) => { url: string; headers: Record<string, string> };
    }) => (record: RunRecord) => Promise<{ active: boolean } | { unreachable: true }>,
    createRunRegistry: registryModule.createRunRegistry as (deps: {
      store: RunStoreLike;
      probeRunActivity: (record: RunRecord) => Promise<{ active: boolean } | { unreachable: true }>;
    }) => {
      register(input: {
        workspaceId: string;
        conversationId: string;
        runId: string;
        engineSessionId: string;
        directory: string;
        kind: RunKind;
      }): Promise<RunRecord>;
    },
    createRunStore: storeModule.createRunStore as (options: { dbPath: string }) => RunStoreLike,
    RunAlreadyActiveError: registryModule.RunAlreadyActiveError as {
      new(activeRunId: string): RunAlreadyActiveErrorLike;
    },
  };
}

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    try {
      runningServers.pop()?.stop?.(true);
    } catch {
      // ignore cleanup errors in tests
    }
  }
  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function useTempVesloDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
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
}

function startTestServer(input: {
  workspaceRoot: string;
  upstreamPort: number;
  orchestratorPort: number;
}) {
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: input.workspaceRoot,
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${input.upstreamPort}/workspace/ws_1/opencode`,
    }],
    authorizedRoots: [input.workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    orchestratorDaemonUrl: `http://127.0.0.1:${input.orchestratorPort}`,
    orchestratorLifecycleToken: "lifecycle-token",
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

function parseRunKind(value: unknown): RunKind | null {
  return value === "prompt" || value === "command" || value === "shell" || value === "summarize"
    ? value
    : null;
}

describe("stale active run integration", () => {
  test("10 stale active conversations are released through OpenCode idle status without touching the slow message fallback", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-stale-active-workspace-"));
    tempDirs.push(workspaceRoot);
    const dataDir = await useTempVesloDataDir("veslo-stale-active-data-");
    const {
      createRunActivityProbe,
      createRunRegistry,
      createRunStore,
      RunAlreadyActiveError,
    } = await loadOrchestratorRunModules();
    const runStore = createRunStore({
      dbPath: join(dataDir, "runs.sqlite"),
    });

    const instanceCount = 10;
    const messageFallbackDelayMs = 2_500;
    const sessionIds: string[] = [];
    const statusProbeTimes: number[] = [];
    const statusDirectoryQueries: string[] = [];
    const statusDirectoryHeaders: string[] = [];
    const messageFallbackSessions: string[] = [];
    const submittedSessions: string[] = [];
    const submittedTimes: number[] = [];
    const submittedBodies: unknown[] = [];

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session") {
          const body = await request.json().catch(() => null) as { title?: unknown } | null;
          const title = typeof body?.title === "string" ? body.title : "";
          const indexMatch = /instance-(\d+)/.exec(title);
          const index = indexMatch ? Number(indexMatch[1]) : sessionIds.length;
          const sessionId = `sess-${index}`;
          sessionIds[index] = sessionId;
          return Response.json({
            id: sessionId,
            title,
            directory: workspaceRoot,
            parentID: null,
            time: { created: Date.now(), updated: Date.now() },
          });
        }

        if (request.method === "GET" && url.pathname === "/workspace/ws_1/opencode/session/status") {
          statusProbeTimes.push(performance.now());
          statusDirectoryQueries.push(url.searchParams.get("directory") ?? "");
          statusDirectoryHeaders.push(request.headers.get("x-opencode-directory") ?? "");
          return Response.json(Object.fromEntries(
            sessionIds.filter(Boolean).map((sessionId) => [sessionId, { type: "idle" }]),
          ));
        }

        const messageMatch = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname);
        if (request.method === "GET" && messageMatch) {
          messageFallbackSessions.push(decodeURIComponent(messageMatch[1] ?? ""));
          await sleep(messageFallbackDelayMs);
          return Response.json([]);
        }

        const promptMatch = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
        if (request.method === "POST" && promptMatch) {
          submittedSessions.push(decodeURIComponent(promptMatch[1] ?? ""));
          submittedTimes.push(performance.now());
          submittedBodies.push(await request.json().catch(() => null));
          return Response.json({ ok: true });
        }

        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const registry = createRunRegistry({
      store: runStore,
      probeRunActivity: createRunActivityProbe({
        getEngine: () => ({ baseUrl: `http://127.0.0.1:${upstream.port}/workspace/ws_1/opencode` }),
        buildEngineRequest: (engine, input) => ({
          url: `${engine.baseUrl}${input.targetPath}?directory=${encodeURIComponent(input.directory)}`,
          headers: { "x-opencode-directory": input.directory },
        }),
      }),
    });

    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.headers.get(ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER) !== "lifecycle-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const kind = parseRunKind(body?.kind);
          if (!kind) return Response.json({ error: "invalid run kind" }, { status: 400 });

          try {
            const record = await registry.register({
              workspaceId: "ws_1",
              conversationId: typeof body?.conversationId === "string" ? body.conversationId : "",
              runId: typeof body?.runId === "string" ? body.runId : "",
              engineSessionId: typeof body?.engineSessionId === "string" ? body.engineSessionId : "",
              directory: typeof body?.directory === "string" ? body.directory : "",
              kind,
            });
            return Response.json({ ok: true, ...record });
          } catch (error) {
            if (error instanceof RunAlreadyActiveError) {
              return Response.json(
                { error: "run_already_active", activeRunId: error.activeRunId },
                { status: 409 },
              );
            }
            return Response.json(
              { error: error instanceof Error ? error.message : String(error) },
              { status: 400 },
            );
          }
        }

        if (request.method === "POST" && url.pathname.includes("/failed")) {
          return Response.json({ ok: true });
        }

        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      orchestratorPort: orchestrator.port,
    });
    const headers = {
      Authorization: "Bearer client-token",
      "Content-Type": "application/json",
    };

    const created = await Promise.all(Array.from({ length: instanceCount }, async (_value, index) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          directory: workspaceRoot,
          title: `stale-active instance-${index}`,
        }),
      });
      expect(response.status).toBe(201);
      return await response.json() as {
        conversationId: string;
        opencodeSessionId: string;
      };
    }));

    const staleRecords: RunRecord[] = created.map((item, index) => ({
      workspaceId: "ws_1",
      conversationId: item.conversationId,
      runId: `stale-${index}`,
      engineSessionId: item.opencodeSessionId,
      directory: workspaceRoot,
      kind: "prompt",
      status: "running",
      abortRequested: false,
      createdAt: Date.now() - 60_000 - index,
      startedAt: Date.now() - 60_000 - index,
      completedAt: null,
      error: null,
    }));
    for (const record of staleRecords) runStore.insert(record);

    const startedAt = performance.now();
    const runResults = await Promise.all(created.map(async (item, index) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(item.conversationId)}/runs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            kind: "prompt_async",
            directory: workspaceRoot,
            parts: [{ type: "text", text: `Hello ${index}` }],
          }),
        },
      );
      const payload = await response.json().catch(() => null) as { runId?: string; code?: string } | null;
      return { status: response.status, payload };
    }));
    const elapsedMs = performance.now() - startedAt;

    expect(runResults.map((result) => result.status)).toEqual(Array(instanceCount).fill(200));
    expect(runResults.every((result) => typeof result.payload?.runId === "string")).toBe(true);
    expect(submittedSessions.sort()).toEqual(sessionIds.filter(Boolean).sort());
    expect(submittedBodies).toHaveLength(instanceCount);
    expect(statusProbeTimes).toHaveLength(instanceCount);
    expect(statusDirectoryQueries).toEqual(Array(instanceCount).fill(workspaceRoot));
    expect(statusDirectoryHeaders).toEqual(Array(instanceCount).fill(workspaceRoot));
    expect(messageFallbackSessions).toEqual([]);
    expect(elapsedMs).toBeLessThan(messageFallbackDelayMs);
    expect(submittedTimes.every((submittedAt) =>
      statusProbeTimes.some((statusAt) => statusAt <= submittedAt)
    )).toBe(true);

    staleRecords.forEach((stale, index) => {
      expect(runStore.get(stale.workspaceId, stale.runId)?.status).toBe("completed");
      const active = runStore.activeForConversation(stale.workspaceId, stale.conversationId);
      expect(active?.runId).toBe(runResults[index]?.payload?.runId);
      expect(active?.engineSessionId).toBe(created[index]?.opencodeSessionId);
      expect(active?.status).toBe("running");
    });
  });
});
