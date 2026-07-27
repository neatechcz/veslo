import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER } from "../orchestrator-lifecycle-client.js";
import { createConversationRunQueueStore } from "../conversation-run-queue-store.js";
import {
  prepareRuntimeSkillCandidate,
  publishValidatedRuntimeSkillCandidate,
} from "../active-runtime-skill-view.js";
import { startServer } from "../server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

const expectOpenCodeAdmissionMessageId = (value: unknown) => {
  expect(typeof value).toBe("string");
  expect(value as string).toMatch(/^msg_[0-9a-f]{26}$/);
  expect(value as string).not.toMatch(/^msg_veslo_/);
};

const boundEngineResponse = (request: Request, body: unknown) => {
  const headers = new Headers();
  const skillRevision = request.headers.get("x-veslo-skill-view-revision");
  const authorizationRevision = request.headers.get("x-veslo-skill-authorization-revision");
  if (skillRevision) headers.set("x-veslo-engine-skill-view-revision", skillRevision);
  if (authorizationRevision) {
    headers.set("x-veslo-engine-authorization-revision", authorizationRevision);
  }
  return Response.json(body, { headers });
};

const removeTempDir = async (dir: string) => {
  const attempts = process.platform === "win32" ? 6 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code) || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
  throw lastError;
};

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
    await removeTempDir(dir);
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

const seedLegacyOpenCodeDb = (
  dbPath: string,
  directory: string,
  sessions: Array<{
    id: string;
    title?: string;
    parentID?: string | null;
    messageText?: string;
  }>,
) => {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        directory TEXT,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const insertSession = db.query(
      "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    const insertMessage = db.query("INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)");
    const insertPart = db.query("INSERT INTO part (id, session_id, message_id, data) VALUES (?1, ?2, ?3, ?4)");
    for (const [index, session] of sessions.entries()) {
      const created = 100 + index;
      insertSession.run(session.id, session.title ?? session.id, directory, session.parentID ?? null, created, created + 10);
      if (session.messageText) {
        const messageId = `msg-${session.id}`;
        const partId = `prt-${session.id}`;
        insertMessage.run(messageId, session.id, JSON.stringify({
          id: messageId,
          sessionID: session.id,
          role: "assistant",
        }));
        insertPart.run(partId, session.id, messageId, JSON.stringify({
          id: partId,
          sessionID: session.id,
          messageID: messageId,
          type: "text",
          text: session.messageText,
        }));
      }
    }
  } finally {
    db.close();
  }
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

function managedAiAccessBundleResponse(accessToken = "gateway-access-token"): Response {
  return Response.json({
    accessToken,
    aiAccess: {
      id: "ai_access_test",
      userId: "user_123",
      enabled: true,
      provider: "codex_oauth",
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5"],
      updatedAt: "2026-04-08T10:00:00.000Z",
    },
  });
}

async function primeAiGatewayRuntimeAuthorization(server: { port: number }): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/me/ai-access`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-gateway-authorization": "Bearer den-user-token",
    },
  });
  expect(response.status).toBe(200);
}

const startTestServer = (input: {
  workspaceRoot: string;
  upstreamPort: number;
  workspaces?: Array<{
    id: string;
    name: string;
    path: string;
    workspaceType?: "local" | "remote";
    baseUrl?: string;
  }>;
  orchestratorDaemonUrl?: string;
  orchestratorLifecycleToken?: string;
}) => {
  const workspaces = input.workspaces?.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    workspaceType: workspace.workspaceType ?? ("local" as const),
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
  test("mounted OpenCode session create accepts and reuses a caller-supplied id", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-session-id-contract-"));
    tempDirs.push(workspaceRoot);
    const requestedSessionId = "ses_veslo_v1_0123456789abcdef0123456789abcdef";
    const upstreamSessions = new Map<string, Record<string, unknown>>();
    const receivedBodies: Array<Record<string, unknown>> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        if (request.method !== "POST" || url.pathname !== "/session" || typeof body?.id !== "string") {
          return Response.json({ error: "unexpected upstream route" }, { status: 404 });
        }
        receivedBodies.push(body);
        const id = body.id;
        const existing = upstreamSessions.get(id);
        const session = existing ?? {
          id,
          title: typeof body.title === "string" ? body.title : id,
          directory: typeof body.directory === "string" ? body.directory : workspaceRoot,
          parentID: null,
          time: { created: 100, updated: 100 },
        };
        upstreamSessions.set(id, session);
        return Response.json(session);
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({ workspaceRoot, upstreamPort: upstream.port });
    const create = () => fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/opencode/session`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: requestedSessionId,
          directory: workspaceRoot,
          title: "Idempotent requested session",
        }),
      },
    );

    const first = await create();
    const second = await create();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json() as { id?: string }).id).toBe(requestedSessionId);
    expect((await second.json() as { id?: string }).id).toBe(requestedSessionId);
    expect(receivedBodies).toEqual([
      {
        id: requestedSessionId,
        directory: workspaceRoot,
        title: "Idempotent requested session",
      },
      {
        id: requestedSessionId,
        directory: workspaceRoot,
        title: "Idempotent requested session",
      },
    ]);
    expect([...upstreamSessions]).toHaveLength(1);
  });

  test("POST /workspace/:id/conversations/submit returns a dry-run result without contacting OpenCode", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-dry-run-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        upstreamRequests.push(new URL(request.url).pathname);
        return Response.json({ error: "dry run must not contact upstream" }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-1",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-1" },
          draft: {
            mode: "prompt",
            text: "Hello",
            parts: [{ type: "text", text: "Hello" }],
          },
          options: { dryRun: true },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      workspaceId?: string;
      clientMessageId?: string;
      requestHash?: string;
      draftDisposition?: string;
      target?: { directory?: string | null; pendingClientSessionId?: string | null };
    };
    expect(payload.status).toBe("dry_run");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.clientMessageId).toBe("msg-submit-1");
    expect(payload.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.draftDisposition).toBe("keep");
    expect(payload.target?.directory).toBe(workspaceRoot);
    expect(payload.target?.pendingClientSessionId).toBe("pending-1");
    expect(upstreamRequests).toEqual([]);
  });

  test("POST /workspace/:id/conversations/submit rejects invalid composer payloads before OpenCode contact", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-invalid-"));
    tempDirs.push(workspaceRoot);
    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return Response.json({ error: "invalid submit must not reach OpenCode" }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });
    const target = { directory: workspaceRoot, pendingClientSessionId: "pending-invalid" };
    const cases: Array<{ body: Record<string, unknown>; message: string }> = [
      {
        body: {
          clientMessageId: "msg-invalid-parts",
          origin: "session:normal",
          source: "enter",
          target,
          draft: {
            mode: "prompt",
            text: "Hello",
            parts: { unexpected: true },
          },
        },
        message: "draft.parts must be an array",
      },
      {
        body: {
          clientMessageId: "msg-invalid-attachments",
          origin: "session:normal",
          source: "enter",
          target,
          draft: {
            mode: "prompt",
            text: "Hello",
            parts: [],
            attachments: { name: "not-an-array" },
          },
        },
        message: "draft.attachments must be an array",
      },
      {
        body: {
          clientMessageId: "msg-invalid-attachment-kind",
          origin: "session:normal",
          source: "enter",
          target,
          draft: {
            mode: "prompt",
            text: "Hello",
            parts: [],
            attachments: [
              {
                name: "payload.bin",
                kind: "binary",
                mimeType: "application/octet-stream",
                dataUrl: "data:application/octet-stream;base64,AA==",
              },
            ],
          },
        },
        message: "draft.attachments[0].kind must be image or file",
      },
      {
        body: {
          clientMessageId: "msg-invalid-queue-policy",
          origin: "session:normal",
          source: "enter",
          target,
          draft: {
            mode: "prompt",
            text: "Hello",
            parts: [],
          },
          options: {
            submitQueuePolicy: "urgent",
          },
        },
        message: "options.submitQueuePolicy is invalid",
      },
    ];

    for (const item of cases) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer client-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(item.body),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_payload",
        message: item.message,
      });
    }
    expect(upstreamHits).toBe(0);
  });

  test("POST /workspace/:id/conversations/submit materializes and submits a first conversation idempotently", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-materialize-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: url.pathname,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          const id = typeof body?.id === "string" ? body.id : "sess-submit-created";
          return Response.json({
            id,
            title: body?.title ?? "First submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });
    const body = {
      clientMessageId: "msg-submit-materialize",
      origin: "session:normal",
      source: "enter",
      target: { directory: workspaceRoot, pendingClientSessionId: "pending-materialize" },
      draft: {
        mode: "prompt",
        text: "Create from submit",
        parts: [{ type: "text", text: "Create from submit" }],
      },
    };
    const submit = () => fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-materialize-trace",
        },
        body: JSON.stringify(body),
      },
    );

    const firstResponse = await submit();
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as {
      status?: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      runId?: string;
      clientMessageId?: string;
      pendingClientSessionId?: string | null;
      draftDisposition?: string;
      materializedSession?: { id?: string; title?: string; conversationId?: string; opencodeSessionId?: string };
    };
    expect(firstPayload.status).toBe("submitted");
    expect(firstPayload.workspaceId).toBe("ws_1");
    expect(firstPayload.conversationId).toMatch(/^conv-/);
    expect(firstPayload.opencodeSessionId).toMatch(/^ses_veslo_v1_[a-f0-9]{32}$/);
    expect(firstPayload.runId).toMatch(/^[a-z0-9_-]+$/i);
    expect(firstPayload.clientMessageId).toBe("msg-submit-materialize");
    expect(firstPayload.pendingClientSessionId).toBeUndefined();
    expect(firstPayload.draftDisposition).toBe("clear");
    expect(firstPayload.materializedSession?.id).toBe(firstPayload.opencodeSessionId);
    expect(firstPayload.materializedSession?.title).toBe("Create from submit");
    expect(firstPayload.materializedSession?.conversationId).toBe(firstPayload.conversationId);
    expect(firstPayload.materializedSession?.opencodeSessionId).toBe(firstPayload.opencodeSessionId);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]?.path).toBe("/session");
    expect(upstreamRequests[0]?.traceId).toBe("submit-materialize-trace");
    expect(upstreamRequests[0]?.body).toMatchObject({
      id: firstPayload.opencodeSessionId,
      directory: workspaceRoot,
      title: "Create from submit",
    });
    expect(upstreamRequests[1]?.path).toBe(`/session/${firstPayload.opencodeSessionId}/prompt_async`);
    expect(upstreamRequests[1]?.traceId).toBe("submit-materialize-trace");
    expectOpenCodeAdmissionMessageId(upstreamRequests[1]?.body?.messageID);
    expect(upstreamRequests[1]?.body?.parts).toEqual([{ type: "text", text: "Create from submit" }]);

    const retryResponse = await submit();
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toEqual(firstPayload);
    expect(upstreamRequests).toHaveLength(2);
  });

  test("POST /workspace/:id/conversations/submit registers server-created local workspaces before orchestrator session create", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-private-orchestrator-"));
    tempDirs.push(workspaceRoot);
    const registeredWorkspaces = new Set<string>();
    const orchestratorRequests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    let createdSessionCount = 0;
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        orchestratorRequests.push({ path: url.pathname, body });
        if (request.method === "POST" && url.pathname === "/workspaces") {
          const id = typeof body?.serverWorkspaceId === "string"
            ? body.serverWorkspaceId
            : typeof body?.id === "string"
              ? body.id
              : "";
          if (!id || typeof body?.path !== "string") {
            return Response.json({ error: "invalid workspace registration" }, { status: 400 });
          }
          registeredWorkspaces.add(id);
          return Response.json({
            activeId: id,
            workspace: {
              id,
              name: body.name ?? "Private",
              path: body.path,
              workspaceType: "local",
              serverWorkspaceId: id,
              createdAt: Date.now(),
            },
          });
        }

        const sessionMatch = url.pathname.match(/^\/workspace\/([^/]+)\/opencode\/session$/);
        if (request.method === "POST" && sessionMatch?.[1]) {
          const workspaceId = decodeURIComponent(sessionMatch[1]);
          if (!registeredWorkspaces.has(workspaceId)) {
            return Response.json({ error: "workspace not found" }, { status: 404 });
          }
          createdSessionCount += 1;
          return boundEngineResponse(request, {
            id: `sess-private-created-${createdSessionCount}`,
            title: body?.title ?? "Private first submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }

        const promptMatch = url.pathname.match(/^\/workspace\/([^/]+)\/opencode\/session\/([^/]+)\/prompt_async$/);
        if (request.method === "POST" && promptMatch?.[1] && promptMatch?.[2]) {
          const workspaceId = decodeURIComponent(promptMatch[1]);
          if (!registeredWorkspaces.has(workspaceId)) {
            return Response.json({ error: "workspace not found" }, { status: 404 });
          }
          return boundEngineResponse(request, { ok: true });
        }
        return Response.json({ error: "unexpected orchestrator route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(orchestrator as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: 0,
      workspaces: [],
      orchestratorDaemonUrl: `http://127.0.0.1:${orchestrator.port}`,
    });

    const workspaceResponse = await fetch(`http://127.0.0.1:${server.port}/workspaces/local`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Private", path: workspaceRoot }),
    });
    expect(workspaceResponse.status).toBe(201);
    const workspacePayload = await workspaceResponse.json() as {
      workspace?: { id?: string; path?: string; baseUrl?: string };
    };
    const workspaceId = workspacePayload.workspace?.id ?? "";
    expect(workspaceId).toMatch(/^ws-/);
    expect(workspacePayload.workspace?.baseUrl).toBe(
      `http://127.0.0.1:${orchestrator.port}/workspace/${workspaceId}/opencode`,
    );

    const submitResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${encodeURIComponent(workspaceId)}/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-private-orchestrator-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-private-orchestrator",
          origin: "composer-target:create-private",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-private-orchestrator" },
          draft: {
            mode: "prompt",
            text: "Private server submit",
            parts: [{ type: "text", text: "Private server submit" }],
          },
        }),
      },
    );

    expect(submitResponse.status).toBe(200);
    const submitPayload = await submitResponse.json() as {
      status?: string;
      workspaceId?: string;
      opencodeSessionId?: string;
      clientMessageId?: string;
    };
    expect(submitPayload.status).toBe("submitted");
    expect(submitPayload.workspaceId).toBe(workspaceId);
    expect(submitPayload.opencodeSessionId).toBe("sess-private-created-1");
    expect(submitPayload.clientMessageId).toBe("msg-private-orchestrator");

    const paths = orchestratorRequests.map((entry) => entry.path);
    const firstRegisterIndex = paths.indexOf("/workspaces");
    const sessionIndex = paths.indexOf(`/workspace/${workspaceId}/opencode/session`);
    const promptIndex = paths.indexOf(`/workspace/${workspaceId}/opencode/session/sess-private-created-1/prompt_async`);
    expect(firstRegisterIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeGreaterThan(firstRegisterIndex);
    expect(promptIndex).toBeGreaterThan(sessionIndex);
    const registrations = orchestratorRequests.filter((entry) => entry.path === "/workspaces");
    expect(registrations).toHaveLength(1);
    expect(registrations.every((entry) => entry.body?.serverWorkspaceId === workspaceId)).toBe(true);
    expect(registrations.every((entry) => entry.body?.path === workspaceRoot)).toBe(true);

    const secondSubmitResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${encodeURIComponent(workspaceId)}/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-private-orchestrator-second-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-private-orchestrator-second",
          origin: "composer-target:create-private",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-private-orchestrator-second" },
          draft: {
            mode: "prompt",
            text: "Private server submit again",
            parts: [{ type: "text", text: "Private server submit again" }],
          },
        }),
      },
    );
    expect(secondSubmitResponse.status).toBe(200);
    expect(orchestratorRequests.filter((entry) => entry.path === "/workspaces")).toHaveLength(2);
  });

  test("DELETE /workspace/:id/sessions/:sessionId retries stale local baseUrl through orchestrator daemon", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-delete-session-orchestrator-stale-"));
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

    const orchestratorRequests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
    const orchestrator = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        orchestratorRequests.push({ path: url.pathname, method: request.method, body });
        if (request.method === "POST" && url.pathname === "/workspaces") {
          return Response.json({ ok: true });
        }
        if (request.method === "DELETE" && url.pathname === "/workspace/ws_delete/opencode/session/sess-delete") {
          return Response.json({ ok: true });
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
          id: "ws_delete",
          name: "Delete",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${staleUpstream.port}/workspace/ws_old/opencode`,
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_delete/sessions/sess-delete`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer client-token" },
      },
    );

    expect(response.status).toBe(200);
    expect(staleBaseUrlHit).toBe(true);
    const paths = orchestratorRequests.map((entry) => entry.path);
    expect(paths.indexOf("/workspaces")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/workspace/ws_delete/opencode/session/sess-delete")).toBeGreaterThan(
      paths.indexOf("/workspaces"),
    );
    expect(orchestratorRequests.find((entry) => entry.path === "/workspaces")?.body?.serverWorkspaceId).toBe("ws_delete");
  });

  test("POST /workspace/:id/conversations/submit joins duplicate sends while OpenCode is slow", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-slow-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    let sessionRequests = 0;
    let promptRequests = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: url.pathname,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          sessionRequests += 1;
          await new Promise((resolve) => setTimeout(resolve, 90));
          return Response.json({
            id: "sess-submit-slow",
            title: body?.title ?? "Slow submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-slow/prompt_async") {
          promptRequests += 1;
          await new Promise((resolve) => setTimeout(resolve, 90));
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });
    const body = {
      clientMessageId: "msg-submit-slow",
      origin: "session:normal",
      source: "enter",
      target: { directory: workspaceRoot, pendingClientSessionId: "pending-slow" },
      draft: {
        mode: "prompt",
        text: "Slow network duplicate send",
        parts: [{ type: "text", text: "Slow network duplicate send" }],
      },
    };
    const submit = () => fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-slow-trace",
        },
        body: JSON.stringify(body),
      },
    );

    const firstSubmit = submit();
    await waitForCondition(
      () => sessionRequests === 1,
      { timeoutMs: 1_000, message: "expected the slow session creation to start" },
    );
    const secondSubmit = submit();
    const [firstResponse, secondResponse] = await Promise.all([firstSubmit, secondSubmit]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as {
      status?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      runId?: string;
      materializedSession?: { id?: string };
    };
    const secondPayload = await secondResponse.json() as typeof firstPayload;
    expect(firstPayload.status).toBe("submitted");
    expect(secondPayload).toEqual(firstPayload);
    expect(firstPayload.opencodeSessionId).toBe("sess-submit-slow");
    expect(firstPayload.materializedSession?.id).toBe("sess-submit-slow");
    expect(sessionRequests).toBe(1);
    expect(promptRequests).toBe(1);
    expect(upstreamRequests.map((entry) => entry.path)).toEqual([
      "/session",
      "/session/sess-submit-slow/prompt_async",
    ]);
    expect(upstreamRequests.every((entry) => entry.traceId === "submit-slow-trace")).toBe(true);
    expectOpenCodeAdmissionMessageId(upstreamRequests[1]?.body?.messageID);
  });

  test("POST /workspace/:id/conversations/submit resolves implicit skills from a large workspace inventory with MCP config present", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-many-skills-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-many-skills-home-"));
    tempDirs.push(workspaceRoot, homeRoot);
    setEnvVarForTest("HOME", homeRoot);
    setEnvVarForTest("USERPROFILE", homeRoot);
    setEnvVarForTest("XDG_CONFIG_HOME", join(homeRoot, ".config"));
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const skillsRoot = join(workspaceRoot, ".opencode", "skills");
    await mkdir(skillsRoot, { recursive: true });
    const fillerSkills = Array.from({ length: 60 }, (_, index) => `general-helper-${String(index).padStart(2, "0")}`);
    await Promise.all(fillerSkills.map(async (name, index) => {
      const skillDir = join(skillsRoot, name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${name}`,
          `description: General helper ${index} for unrelated maintenance notes.`,
          `trigger: unrelated helper ${index}`,
          "---",
          "",
          `# ${name}`,
          "",
        ].join("\n"),
        "utf8",
      );
    }));
    await mkdir(join(skillsRoot, "broken-skill"), { recursive: true });
    await writeFile(
      join(skillsRoot, "broken-skill", "SKILL.md"),
      [
        "---",
        "name: broken-skill",
        "---",
        "",
        "# Broken Skill",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(skillsRoot, "company-research-czech"), { recursive: true });
    await writeFile(
      join(skillsRoot, "company-research-czech", "SKILL.md"),
      [
        "---",
        "name: company-research-czech",
        "description: Use when user asks for company search and profile extraction from a website.",
        "trigger: company search",
        "---",
        "",
        "# Company Research Czech",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({
        mcp: {
          browser: {
            type: "local",
            command: ["node", "browser-mcp.js"],
          },
          remoteDocs: {
            type: "remote",
            url: "https://mcp.example.test/docs",
          },
          servers: {
            futureShape: {
              type: "remote",
              url: "https://future.example.test/mcp",
            },
          },
        },
      }),
      "utf8",
    );

    const upstreamRequests: Array<{
      path: string;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-many-skills",
            title: body?.title ?? "Many skills",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-many-skills/command") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-many-skills-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-many-skills",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-many-skills" },
          draft: {
            mode: "prompt",
            text: "https://example.test use company search skill for this",
            parts: [],
          },
          options: {
            model: {
              providerID: "openai",
              modelID: "gpt-5.5",
              modalities: { input: ["text"], output: ["text"] },
            },
            agent: "build",
            variant: "xhigh",
            implicitSkillCommandPolicy: "allow",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      opencodeSessionId?: string;
      debugTrace?: Array<{ event: string }>;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.opencodeSessionId).toBe("sess-many-skills");
    expect(upstreamRequests.map((entry) => entry.path)).toEqual([
      "/session",
      `/session/sess-many-skills/command?directory=${encodeURIComponent(workspaceRoot)}`,
    ]);
    expect(upstreamRequests[1]?.body).toMatchObject({
      command: "company-research-czech",
      arguments: "https://example.test use company search skill for this",
      agent: "build",
      model: "openai/gpt-5.5",
      variant: "xhigh",
    });
    expect(upstreamRequests[1]?.body?.messageID).toBeUndefined();
    expect(upstreamRequests[1]?.body?.parts).toBeUndefined();
    expect(payload.debugTrace?.some((entry) => entry.event === "server:conversation-run:opencode-submit"))
      .toBe(true);
  });

  test("POST /workspace/:id/conversations/submit keeps ambiguous implicit skill prompts as prompt runs", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-ambiguous-skills-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-ambiguous-skills-home-"));
    tempDirs.push(workspaceRoot, homeRoot);
    setEnvVarForTest("HOME", homeRoot);
    setEnvVarForTest("USERPROFILE", homeRoot);
    setEnvVarForTest("XDG_CONFIG_HOME", join(homeRoot, ".config"));
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const skillsRoot = join(workspaceRoot, ".opencode", "skills");
    await mkdir(skillsRoot, { recursive: true });
    for (const name of ["company-research-czech", "company-research-global"]) {
      await mkdir(join(skillsRoot, name), { recursive: true });
      await writeFile(
        join(skillsRoot, name, "SKILL.md"),
        [
          "---",
          `name: ${name}`,
          "description: Use when user asks for company research and website profile extraction.",
          "trigger: company research",
          "---",
          "",
          `# ${name}`,
          "",
        ].join("\n"),
        "utf8",
      );
    }

    const upstreamRequests: Array<{
      path: string;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-ambiguous-skills",
            title: body?.title ?? "Ambiguous skills",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-ambiguous-skills/prompt_async") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-ambiguous-skills",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-ambiguous-skills" },
          draft: {
            mode: "prompt",
            text: "Please use company research skill for this website",
            parts: [],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { status?: string; opencodeSessionId?: string };
    expect(payload.status).toBe("submitted");
    expect(payload.opencodeSessionId).toBe("sess-ambiguous-skills");
    expect(upstreamRequests.map((entry) => entry.path)).toEqual([
      "/session",
      `/session/sess-ambiguous-skills/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
    ]);
    expect(upstreamRequests[1]?.body).toMatchObject({
      parts: [{ type: "text", text: "Please use company research skill for this website" }],
    });
    expectOpenCodeAdmissionMessageId(upstreamRequests[1]?.body?.messageID);
    expect(upstreamRequests[1]?.body?.command).toBeUndefined();
  });

  test("POST /workspace/:id/conversations/submit keeps ordinary prompts as prompt runs when no skills or MCP are present", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-no-skills-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-no-skills-home-"));
    tempDirs.push(workspaceRoot, homeRoot);
    setEnvVarForTest("HOME", homeRoot);
    setEnvVarForTest("USERPROFILE", homeRoot);
    setEnvVarForTest("XDG_CONFIG_HOME", join(homeRoot, ".config"));
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const upstreamRequests: Array<{
      path: string;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-no-skills",
            title: body?.title ?? "No skills",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-no-skills/prompt_async") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-no-skills",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-no-skills" },
          draft: {
            mode: "prompt",
            text: "Please inspect this repository",
            parts: [],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { status?: string; opencodeSessionId?: string };
    expect(payload.status).toBe("submitted");
    expect(payload.opencodeSessionId).toBe("sess-no-skills");
    expect(upstreamRequests.map((entry) => entry.path)).toEqual([
      "/session",
      `/session/sess-no-skills/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
    ]);
    expect(upstreamRequests[1]?.body).toMatchObject({
      parts: [{ type: "text", text: "Please inspect this repository" }],
    });
    expectOpenCodeAdmissionMessageId(upstreamRequests[1]?.body?.messageID);
    expect(upstreamRequests[1]?.body?.command).toBeUndefined();
  });

  test("POST /workspace/:id/conversations/submit carries run-scoped AI gateway authorization to OpenCode provider calls", async () => {
    const dataDir = await useTempVesloDataDir();
    setEnvVarForTest("VESLO_TOKEN_STORE", join(dataDir, "tokens.json"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-gateway-"));
    tempDirs.push(workspaceRoot);
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });

    const gatewayRequests: Array<{
      path: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
      workspaceId: string | null;
      body: unknown;
    }> = [];
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
          gatewayRequests.push({
            path: url.pathname,
            authorization: request.headers.get("authorization"),
            gatewayToken: request.headers.get("x-veslo-gateway-token"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            body: null,
          });
          return managedAiAccessBundleResponse("runtime-scoped-gateway-token");
        }
        if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
          const requestBody = await request.json().catch(() => null) as unknown;
          gatewayRequests.push({
            path: url.pathname,
            authorization: request.headers.get("authorization"),
            gatewayToken: request.headers.get("x-veslo-gateway-token"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            body: requestBody,
          });
          return Response.json({
            id: "chatcmpl_submit_gateway",
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

    let serverPort = 0;
    let providerFetchStatus = 0;
    let providerFetchError = "";
    const upstreamRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamRequests.push(url.pathname);
        const body = request.method === "POST"
          ? await request.json().catch(() => null) as Record<string, unknown> | null
          : null;
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-gateway",
            title: body?.title ?? "Gateway submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-gateway/prompt_async") {
          try {
            const providerResponse = await fetch(
              `http://127.0.0.1:${serverPort}/ai-gateway/providers/codex_oauth/v1/chat/completions`,
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer client-token",
                  "Content-Type": "application/json",
                  "x-veslo-gateway-token": "Bearer [redacted]",
                  "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
                  "x-veslo-workspace-id": "ws_1",
                },
                body: JSON.stringify({
                  model: "gpt-5.5",
                  messages: [{ role: "user", content: "Composer gateway" }],
                }),
              },
            );
            providerFetchStatus = providerResponse.status;
          } catch (error) {
            providerFetchError = error instanceof Error ? error.message : String(error);
          }
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });
    serverPort = server.port;

    const tokenResponse = await fetch(`http://127.0.0.1:${server.port}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-host-token": "host-token",
      },
      body: JSON.stringify({ scope: "collaborator", label: "composer" }),
    });
    expect(tokenResponse.status).toBe(201);
    const issued = await tokenResponse.json() as { token: string };

    const accessResponse = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/me/ai-access`, {
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "x-veslo-gateway-authorization": "Bearer den-user-token",
      },
    });
    expect(accessResponse.status).toBe(200);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${issued.token}`,
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-gateway-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-gateway",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-submit-gateway" },
          draft: {
            mode: "prompt",
            text: "Composer should call managed AI",
            parts: [{ type: "text", text: "Composer should call managed AI" }],
          },
          options: {
            expectAiGatewayStart: true,
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      opencodeSessionId?: string;
      debugTrace?: Array<{ event: string }>;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.opencodeSessionId).toBe("sess-submit-gateway");
    expect(providerFetchStatus).toBe(200);
    expect(providerFetchError).toBe("");
    expect(upstreamRequests).toEqual([
      "/session",
      "/session/sess-submit-gateway/prompt_async",
    ]);
    expect(gatewayRequests).toEqual([
      {
        path: "/api/me/ai-access",
        authorization: "Bearer den-user-token",
        gatewayToken: null,
        sessionId: null,
        workspaceId: null,
        body: null,
      },
      {
        path: "/providers/codex_oauth/v1/chat/completions",
        authorization: "Bearer runtime-scoped-gateway-token",
        gatewayToken: null,
        sessionId: "sess-submit-gateway",
        workspaceId: null,
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Composer gateway" }],
        },
      },
    ]);
    expect(payload.debugTrace?.some((entry) => entry.event === "server:conversation-run:opencode-submit"))
      .toBe(true);
  });

  test("POST /workspace/:id/conversations/submit returns materialized session when first run submit fails", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-materialized-failed-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamRequests.push(url.pathname);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-created-failed",
            title: "Create then fail",
            time: { created: Date.now(), updated: Date.now() },
            directory: workspaceRoot,
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-created-failed/prompt_async") {
          return Response.json({ error: "prompt failed" }, { status: 502 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const submit = () =>
      fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer client-token",
          "x-veslo-send-trace-id": "submit-materialized-failed-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-materialized-failed",
          origin: "session:normal",
          source: "enter",
          target: { directory: workspaceRoot, pendingClientSessionId: "pending-submit-materialized-failed" },
          draft: {
            mode: "prompt",
            text: "Create then fail",
            parts: [{ type: "text", text: "Create then fail" }],
          },
          options: { submitQueuePolicy: "normal" },
        }),
      });

    const response = await submit();
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      code?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      pendingClientSessionId?: string | null;
      materializedSession?: { id?: string; conversationId?: string; opencodeSessionId?: string };
      draftDisposition?: string;
    };
    expect(payload.status).toBe("failed");
    expect(payload.draftDisposition).toBe("restore");
    expect(payload.conversationId).toBeTruthy();
    expect(payload.opencodeSessionId).toBe("sess-submit-created-failed");
    expect(payload.pendingClientSessionId).toBe("pending-submit-materialized-failed");
    expect(payload.materializedSession?.id).toBe("sess-submit-created-failed");
    expect(payload.materializedSession?.conversationId).toBe(payload.conversationId);
    expect(payload.materializedSession?.opencodeSessionId).toBe("sess-submit-created-failed");

    const retryResponse = await submit();
    expect(retryResponse.status).toBe(200);
    const retryPayload = await retryResponse.json() as typeof payload;
    expect(retryPayload.status).toBe("failed");
    expect(retryPayload.draftDisposition).toBe("restore");
    expect(retryPayload.conversationId).toBe(payload.conversationId);
    expect(retryPayload.opencodeSessionId).toBe("sess-submit-created-failed");
    expect(retryPayload.pendingClientSessionId).toBe("pending-submit-materialized-failed");
    expect(upstreamRequests).toEqual([
      "/session",
      "/session/sess-submit-created-failed/prompt_async",
      "/session/sess-submit-created-failed/prompt_async",
    ]);
  });

  test("POST /workspace/:id/conversations/submit submits an existing conversation through run admission", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-existing-run-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-existing",
            title: body?.title ?? "Existing submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-existing/prompt_async") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
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
          title: "Existing submit",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversationId: string;
      opencodeSessionId: string;
    };
    expect(created.opencodeSessionId).toBe("sess-submit-existing");
    await mkdir(join(workspaceRoot, "sessions", "sess-submit-existing"), { recursive: true });
    await writeFile(join(workspaceRoot, "sessions", "sess-submit-existing", "brief.txt"), "brief");

    const submitBody = {
      clientMessageId: "msg-submit-existing-run",
      origin: "session:normal",
      source: "enter",
      target: { conversationId: created.conversationId, directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Submit existing run",
        parts: [{ type: "text", text: "Submit existing run" }],
        attachments: [{
          name: "brief.txt",
          kind: "file",
          mimeType: "text/plain",
          dataUrl: "data:text/plain;base64,YnJpZWY=",
          fileSessionPath: "sessions/sess-submit-existing/brief.txt",
        }],
      },
      options: {
        model: {
          providerID: "openai",
          modelID: "gpt-5.5",
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        agent: "build",
        variant: "xhigh",
      },
    };
    const submit = () => fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-existing-run-trace",
        },
        body: JSON.stringify(submitBody),
      },
    );

    const submitResponse = await submit();
    expect(submitResponse.status).toBe(200);
    const payload = await submitResponse.json() as {
      status?: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      runId?: string;
      clientMessageId?: string;
      draftDisposition?: string;
      debugTrace?: Array<{ event: string }>;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.conversationId).toBe(created.conversationId);
    expect(payload.opencodeSessionId).toBe("sess-submit-existing");
    expect(payload.runId).toMatch(/^[a-z0-9_-]+$/i);
    expect(payload.clientMessageId).toBe("msg-submit-existing-run");
    expect(payload.draftDisposition).toBe("clear");
    expect(payload.debugTrace?.some((entry) => entry.event === "server:conversation-run:opencode-submit"))
      .toBe(true);
    expect(payload.debugTrace?.some((entry) => entry.event === "server:conversation-run:submitted"))
      .toBe(true);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[1]?.path).toBe(
      `/session/sess-submit-existing/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(upstreamRequests[1]?.traceId).toBe("submit-existing-run-trace");
    expect(upstreamRequests[1]?.body?.parts).toEqual([
      { type: "text", text: "Submit existing run\nAttached workspace file: sessions/sess-submit-existing/brief.txt" },
    ]);
    expectOpenCodeAdmissionMessageId(upstreamRequests[1]?.body?.messageID);
    expect(upstreamRequests[1]?.body?.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
    expect(upstreamRequests[1]?.body?.agent).toBe("build");
    expect(upstreamRequests[1]?.body?.variant).toBe("xhigh");
    expect(upstreamRequests[1]?.body?.directory).toBeUndefined();
    expect(upstreamRequests[1]?.body?.kind).toBeUndefined();
    expect(upstreamRequests[1]?.body?.clientMessageId).toBeUndefined();
    expect(upstreamRequests[1]?.body?.origin).toBeUndefined();

    const retryResponse = await submit();
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toEqual(payload);
    expect(upstreamRequests).toHaveLength(2);
  });

  test("POST /workspace/:id/conversations/submit imports verified legacy OpenCode session targets", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-legacy-import-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "opencode.db");
    seedLegacyOpenCodeDb(dbPath, workspaceRoot, [{
      id: "sess-legacy-submit",
      title: "Legacy Submit",
    }]);
    setEnvVarForTest("VESLO_OPENCODE_DB_PATH", dbPath);

    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session/sess-legacy-submit/prompt_async") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const submitResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-legacy-import-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-legacy-import",
          origin: "session:normal",
          source: "enter",
          target: { opencodeSessionId: "sess-legacy-submit", directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "Continue legacy session",
            parts: [{ type: "text", text: "Continue legacy session" }],
          },
        }),
      },
    );

    expect(submitResponse.status).toBe(200);
    const payload = await submitResponse.json() as {
      status?: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      runId?: string;
      clientMessageId?: string;
      draftDisposition?: string;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.conversationId).toMatch(/^conv-/);
    expect(payload.opencodeSessionId).toBe("sess-legacy-submit");
    expect(payload.runId).toMatch(/^[a-z0-9_-]+$/i);
    expect(payload.clientMessageId).toBe("msg-submit-legacy-import");
    expect(payload.draftDisposition).toBe("clear");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.path).toBe(
      `/session/sess-legacy-submit/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(upstreamRequests[0]?.traceId).toBe("submit-legacy-import-trace");
    expectOpenCodeAdmissionMessageId(upstreamRequests[0]?.body?.messageID);
  });

  test("GET /workspace/:id/sessions/:sessionId/transcript imports legacy OpenCode session identity", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-transcript-legacy-import-"));
    tempDirs.push(workspaceRoot);
    const dbPath = join(workspaceRoot, "opencode.db");
    seedLegacyOpenCodeDb(dbPath, workspaceRoot, [{
      id: "sess-legacy-read",
      title: "Legacy Read",
      messageText: "legacy transcript",
    }]);
    setEnvVarForTest("VESLO_OPENCODE_DB_PATH", dbPath);

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return new Response("passive transcript read must not hit upstream", { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/sess-legacy-read/transcript?limit=10&directory=${encodeURIComponent(workspaceRoot)}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );

    expect(transcriptResponse.status).toBe(200);
    const payload = await transcriptResponse.json() as {
      sessionId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      messages?: unknown[];
      partsByMessageId?: Record<string, unknown[]>;
      source?: string;
    };
    expect(payload.sessionId).toBe("sess-legacy-read");
    expect(payload.conversationId).toMatch(/^conv-/);
    expect(payload.opencodeSessionId).toBe("sess-legacy-read");
    expect(payload.messages?.length).toBe(1);
    expect(payload.partsByMessageId?.["msg-sess-legacy-read"]?.length).toBe(1);
    expect(payload.source).toBe("sqlite");
    expect(upstreamHits).toBe(0);
  });

  test("POST /workspace/:id/conversations/submit owns replacement revert before submit", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-replace-run-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          method: request.method,
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-replace",
            title: body?.title ?? "Replacement submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "GET" && url.pathname === "/session/sess-submit-replace") {
          return Response.json({ id: "sess-submit-replace", revert: { messageID: "msg_previous_revert" } });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace/abort") {
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace/revert") {
          return Response.json({ id: "sess-submit-replace", revert: { messageID: body?.messageID } });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace/prompt_async") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
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
          title: "Replacement submit",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversationId: string;
      opencodeSessionId: string;
    };

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-replace-run-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-replace-run",
          origin: "session:replacement",
          target: { conversationId: created.conversationId, directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "Edited replacement",
            parts: [{ type: "text", text: "Edited replacement" }],
          },
          options: {
            replaceMessageId: "msg_original",
            model: { providerID: "openai", modelID: "gpt-5.5" },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      draftDisposition?: string;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.conversationId).toBe(created.conversationId);
    expect(payload.opencodeSessionId).toBe("sess-submit-replace");
    expect(payload.draftDisposition).toBe("clear");
    expect(upstreamRequests.map((request) => request.path)).toEqual([
      "/session",
      `/session/sess-submit-replace?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace/abort?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace/revert?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
    ]);
    expect(upstreamRequests[3]?.body).toEqual({ messageID: "msg_original" });
    expectOpenCodeAdmissionMessageId(upstreamRequests[4]?.body?.messageID);
    expect(upstreamRequests[4]?.body?.parts).toEqual([{ type: "text", text: "Edited replacement" }]);
  });

  test("POST /workspace/:id/conversations/submit restores replacement revert when submit fails", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-replace-restore-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({ path: `${url.pathname}${url.search}`, method: request.method, body });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-replace-restore",
            title: body?.title ?? "Replacement restore",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "GET" && url.pathname === "/session/sess-submit-replace-restore") {
          return Response.json({ id: "sess-submit-replace-restore", revert: null });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace-restore/abort") {
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace-restore/revert") {
          return Response.json({ id: "sess-submit-replace-restore", revert: { messageID: body?.messageID } });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace-restore/prompt_async") {
          return Response.json({ error: "submit failed" }, { status: 500 });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-replace-restore/unrevert") {
          return Response.json({ id: "sess-submit-replace-restore", revert: null });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({ workspaceRoot, upstreamPort: upstream.port });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ directory: workspaceRoot, title: "Replacement restore" }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-replace-restore",
          origin: "session:replacement",
          target: { conversationId: created.conversationId, directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "Edited replacement failure",
            parts: [{ type: "text", text: "Edited replacement failure" }],
          },
          options: {
            replaceMessageId: "msg_original",
            model: { providerID: "openai", modelID: "gpt-5.5" },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { status?: string; code?: string; draftDisposition?: string };
    expect(payload.status).toBe("failed");
    expect(payload.code).toBe("replacement_submit_failed_restore_succeeded");
    expect(payload.draftDisposition).toBe("restore");
    expect(upstreamRequests.map((request) => request.path)).toEqual([
      "/session",
      `/session/sess-submit-replace-restore?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace-restore/abort?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace-restore/revert?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace-restore/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
      `/session/sess-submit-replace-restore/unrevert?directory=${encodeURIComponent(workspaceRoot)}`,
    ]);
  });

  test("POST /workspace/:id/conversations/submit returns queued for send-now when lifecycle has an active run", async () => {
    const vesloDataDir = await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-send-now-queued-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const engineSubmits: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-send-now-queued",
            title: body?.title ?? "Send now queued",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-send-now-queued/prompt_async") {
          engineSubmits.push(url.pathname);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    let activeRequests = 0;
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
          activeRequests += 1;
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
            status: "running",
            stale: false,
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/runs/register") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          registerRequests.push(typeof body?.runId === "string" ? body.runId : "");
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
          title: "Send now queued",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversationId: string;
      opencodeSessionId: string;
    };
    expect(created.opencodeSessionId).toBe("sess-submit-send-now-queued");

    const submitBody = {
      clientMessageId: "msg-submit-send-now-queued",
      origin: "session:send-now",
      source: "send-now",
      target: { conversationId: created.conversationId, directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Send now queued",
        parts: [{ type: "text", text: "Send now queued" }],
      },
      options: {
        submitQueuePolicy: "send-now",
        model: { providerID: "openai", modelID: "gpt-5.5" },
      },
    };
    const submit = () => fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-send-now-queued-trace",
        },
        body: JSON.stringify(submitBody),
      },
    );

    const submitResponse = await submit();
    expect(submitResponse.status).toBe(202);
    const payload = await submitResponse.json() as {
      status?: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      queueItemId?: string;
      reservedRunId?: string;
      queuePosition?: number;
      clientMessageId?: string;
      draftDisposition?: string;
    };
    expect(payload.status).toBe("queued");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.conversationId).toBe(created.conversationId);
    expect(payload.opencodeSessionId).toBe("sess-submit-send-now-queued");
    expect(payload.queueItemId).toMatch(/^queue_/);
    expect(payload.reservedRunId).toMatch(/^[a-z0-9_-]+$/i);
    expect(payload.queuePosition).toBe(1);
    expect(payload.clientMessageId).toBe("msg-submit-send-now-queued");
    expect(payload.draftDisposition).toBe("clear");
    expect(activeRequests).toBeGreaterThan(0);
    expect(registerRequests).toEqual([]);
    expect(engineSubmits).toEqual([]);
    expect(upstreamRequests).toHaveLength(1);

    const serverQueueOnlyResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-server-queue-only-trace",
        },
        body: JSON.stringify({
          ...submitBody,
          clientMessageId: "msg-submit-server-queue-only",
          options: {
            ...submitBody.options,
            submitQueuePolicy: "server-queue-only",
          },
        }),
      },
    );
    expect(serverQueueOnlyResponse.status).toBe(202);
    const serverQueueOnlyPayload = await serverQueueOnlyResponse.json() as {
      status?: string;
      queueItemId?: string;
      reservedRunId?: string;
      draftDisposition?: string;
    };
    expect(serverQueueOnlyPayload.status).toBe("queued");
    expect(serverQueueOnlyPayload.queueItemId).toMatch(/^queue_/);
    expect(serverQueueOnlyPayload.reservedRunId).toMatch(/^[a-z0-9_-]+$/i);
    expect(serverQueueOnlyPayload.draftDisposition).toBe("clear");
    expect(engineSubmits).toEqual([]);

    const queueStatusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${created.conversationId}/queue/${payload.queueItemId}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(queueStatusResponse.status).toBe(200);
    const queueStatusPayload = await queueStatusResponse.json() as {
      status?: string;
      workspaceId?: string;
      conversationId?: string;
      queueItemId?: string;
      reservedRunId?: string;
      clientMessageId?: string;
      error?: string | null;
    };
    expect(queueStatusPayload).toMatchObject({
      status: "pending",
      workspaceId: "ws_1",
      conversationId: created.conversationId,
      queueItemId: payload.queueItemId,
      reservedRunId: payload.reservedRunId,
      clientMessageId: "msg-submit-send-now-queued",
      error: null,
    });

    const queuedRunStatusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${created.conversationId}/runs/${payload.reservedRunId}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(queuedRunStatusResponse.status).toBe(200);
    const queuedRunStatusPayload = await queuedRunStatusResponse.json() as Record<string, unknown>;
    expect(queuedRunStatusPayload).toMatchObject({
      ok: true,
      workspaceId: "ws_1",
      conversationId: created.conversationId,
      runId: payload.reservedRunId,
      status: "queued",
      stale: false,
      clientMessageId: "msg-submit-send-now-queued",
      queueItemId: payload.queueItemId,
      queueState: "pending",
    });

    const listConversationId = "conv-queue-read";
    const listStore = createConversationRunQueueStore({ dataDir: vesloDataDir, now: () => 2_000 });
    const enqueueListItem = (clientMessageId: string) => listStore.enqueue({
      workspaceId: "ws_1",
      conversationId: listConversationId,
      opencodeSessionId: "sess-queue-read",
      directory: "/private/queue-directory",
      reservedRunId: `run-${clientMessageId}`,
      clientMessageId,
      origin: "session:queue-drain",
      kind: "prompt_async",
      bodyJson: JSON.stringify({
        kind: "prompt_async",
        text: "private queued prompt body",
        runtimeAuthorizationActorTokenHash: "runtime-auth-secret",
      }),
    }).item;
    const listPending = enqueueListItem("list-pending");
    const listStarting = enqueueListItem("list-starting");
    const listFailed = enqueueListItem("list-failed");
    const listSubmitted = enqueueListItem("list-submitted");
    listStore.markStarting(listStarting.queueItemId);
    listStore.markStarting(listFailed.queueItemId);
    listStore.markFailed(listFailed.queueItemId, "Bearer queue-token authorization=raw-secret");
    listStore.markStarting(listSubmitted.queueItemId);
    listStore.markSubmitted(listSubmitted.queueItemId);

    const listBaseUrl = `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${listConversationId}/queue?status=pending&status=starting&status=failed`;
    const fullListResponse = await fetch(`${listBaseUrl}&limit=100`, {
      headers: { Authorization: "Bearer client-token" },
    });
    expect(fullListResponse.status).toBe(200);
    const fullListPayload = await fullListResponse.json() as {
      items?: Array<Record<string, unknown>>;
      nextCursor?: string | null;
    };
    expect(fullListPayload.nextCursor).toBeNull();
    expect(fullListPayload.items).toHaveLength(3);
    expect(fullListPayload.items?.map((item) => item.queueItemId)).not.toContain(listSubmitted.queueItemId);
    expect(fullListPayload.items?.map((item) => item.status).sort()).toEqual(["failed", "pending", "starting"]);
    const failedListItem = fullListPayload.items?.find((item) => item.queueItemId === listFailed.queueItemId);
    expect(failedListItem).toMatchObject({
      workspaceId: "ws_1",
      conversationId: listConversationId,
      opencodeSessionId: "sess-queue-read",
      reservedRunId: "run-list-failed",
      clientMessageId: "list-failed",
      kind: "prompt_async",
      status: "failed",
      queuePosition: null,
      error: "Bearer [redacted] authorization=[redacted]",
    });
    for (const item of fullListPayload.items ?? []) {
      for (const forbidden of [
        "bodyJson",
        "directory",
        "requestHash",
        "runtimeAuthorizationActorTokenHash",
        "origin",
        "activeRunId",
        "attempts",
      ]) {
        expect(item).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(item)).not.toContain("private queued prompt body");
      expect(JSON.stringify(item)).not.toContain("queue-token");
      expect(JSON.stringify(item)).not.toContain("raw-secret");
    }

    const firstPageResponse = await fetch(`${listBaseUrl}&limit=2`, {
      headers: { Authorization: "Bearer client-token" },
    });
    const firstPagePayload = await firstPageResponse.json() as {
      items?: Array<Record<string, unknown>>;
      nextCursor?: string | null;
    };
    expect(firstPageResponse.status).toBe(200);
    expect(firstPagePayload.items).toHaveLength(2);
    expect(firstPagePayload.nextCursor).toEqual(expect.any(String));
    const secondPageResponse = await fetch(`${listBaseUrl}&limit=2&cursor=${encodeURIComponent(firstPagePayload.nextCursor!)}`, {
      headers: { Authorization: "Bearer client-token" },
    });
    const secondPagePayload = await secondPageResponse.json() as { items?: Array<Record<string, unknown>>; nextCursor?: string | null };
    expect(secondPageResponse.status).toBe(200);
    expect(secondPagePayload.nextCursor).toBeNull();
    expect([
      ...(firstPagePayload.items ?? []).map((item) => item.queueItemId),
      ...(secondPagePayload.items ?? []).map((item) => item.queueItemId),
    ]).toEqual((fullListPayload.items ?? []).map((item) => item.queueItemId));

    for (const invalidUrl of [
      `${listBaseUrl}&status=submitted`,
      `${listBaseUrl}&limit=101`,
      `${listBaseUrl}&cursor=not-a-queue-cursor`,
    ]) {
      const invalidResponse = await fetch(invalidUrl, { headers: { Authorization: "Bearer client-token" } });
      expect(invalidResponse.status).toBe(400);
    }
    const foreignConversationResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/conv-queue-foreign/queue?limit=10`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    expect(foreignConversationResponse.status).toBe(200);
    expect((await foreignConversationResponse.json() as { items?: unknown[] }).items).toEqual([]);

    const queueStore = createConversationRunQueueStore({ dataDir: vesloDataDir });
    queueStore.markStarting(payload.queueItemId!);
    queueStore.markFailed(payload.queueItemId!, "queued drain failed");
    const failedQueueStatusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${created.conversationId}/queue/${payload.queueItemId}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(failedQueueStatusResponse.status).toBe(200);
    const failedQueueStatusPayload = await failedQueueStatusResponse.json() as {
      status?: string;
      error?: string | null;
    };
    expect(failedQueueStatusPayload.status).toBe("failed");
    expect(failedQueueStatusPayload.error).toBe("queued drain failed");

    const activeRequestsAfterFirstSubmit = activeRequests;
    const latestRequestsAfterFirstSubmit = latestRequests;
    const retryResponse = await submit();
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({
      status: "failed",
      code: "queued_run_failed",
      message: "queued drain failed",
      workspaceId: "ws_1",
      conversationId: created.conversationId,
      opencodeSessionId: "sess-submit-send-now-queued",
      queueItemId: payload.queueItemId,
      reservedRunId: payload.reservedRunId,
      clientMessageId: "msg-submit-send-now-queued",
      draftDisposition: "restore",
    });
    expect(activeRequests).toBe(activeRequestsAfterFirstSubmit);
    expect(latestRequests).toBe(latestRequestsAfterFirstSubmit);
    expect(registerRequests).toEqual([]);
    expect(engineSubmits).toEqual([]);
    expect(upstreamRequests).toHaveLength(1);
  });

  test("POST /workspace/:id/conversations/submit submits compact as a summarize run", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-compact-run-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: Array<{
      path: string;
      traceId: string | null;
      body: Record<string, unknown> | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        upstreamRequests.push({
          path: `${url.pathname}${url.search}`,
          traceId: request.headers.get("x-veslo-send-trace-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-submit-compact",
            title: body?.title ?? "Compact submit",
            directory: body?.directory ?? workspaceRoot,
            parentID: null,
            time: { created: 100, updated: 100 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-submit-compact/summarize") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
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
          title: "Compact submit",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversationId: string;
      opencodeSessionId: string;
    };
    expect(created.opencodeSessionId).toBe("sess-submit-compact");

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "x-veslo-send-trace-id": "submit-compact-run-trace",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-compact-run",
          origin: "session:normal",
          target: { conversationId: created.conversationId, directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "/compact",
            parts: [{ type: "text", text: "/compact" }],
          },
          options: {
            model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      draftDisposition?: string;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.conversationId).toBe(created.conversationId);
    expect(payload.opencodeSessionId).toBe("sess-submit-compact");
    expect(payload.draftDisposition).toBe("clear");
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[1]?.path).toBe(
      `/session/sess-submit-compact/summarize?directory=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(upstreamRequests[1]?.traceId).toBe("submit-compact-run-trace");
    expect(upstreamRequests[1]?.body).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    });
  });

  test("POST /workspace/:id/conversations/submit returns a typed restore result when materialization fails", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-materialize-fail-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamRequests.push(url.pathname);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({ error: "create failed" }, { status: 500 });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-materialize-fail",
          origin: "session:normal",
          target: { directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "Create should fail",
            parts: [{ type: "text", text: "Create should fail" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      code?: string;
      draftDisposition?: string;
      debugTrace?: Array<{ upstreamCode?: string | null; upstreamStatus?: number | null }>;
    };
    expect(payload.status).toBe("failed");
    expect(payload.code).toBe("conversation_create_failed");
    expect(payload.draftDisposition).toBe("restore");
    expect(payload.debugTrace?.[0]?.upstreamCode).toBe("opencode_request_failed");
    expect(payload.debugTrace?.[0]?.upstreamStatus).toBe(502);
    expect(upstreamRequests).toEqual(["/session"]);
  });

  test("POST /workspace/:id/conversations/submit rejects idempotency conflicts", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-conflict-"));
    tempDirs.push(workspaceRoot);
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: 9,
    });
    const url = `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`;
    const submit = (text: string) => fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientMessageId: "msg-submit-conflict",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text,
          parts: [{ type: "text", text }],
        },
        options: { dryRun: true },
      }),
    });

    expect((await submit("First")).status).toBe(200);
    const conflictResponse = await submit("Second");
    expect(conflictResponse.status).toBe(409);
    const conflict = await conflictResponse.json() as { code?: string; message?: string };
    expect(conflict.code).toBe("idempotency_conflict");
  });

  test("POST /workspace/:id/conversations/submit treats dry-run and real submit intents as different requests", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-dry-run-hash-"));
    tempDirs.push(workspaceRoot);
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: 9,
    });
    const url = `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/submit`;
    const baseBody = {
      clientMessageId: "msg-submit-dry-run-hash",
      origin: "session:normal",
      target: { directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Same text",
        parts: [{ type: "text", text: "Same text" }],
      },
    };
    const submit = (options?: Record<string, unknown>) => fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...baseBody,
        ...(options ? { options } : {}),
      }),
    });

    expect((await submit({ dryRun: true })).status).toBe(200);
    const conflictResponse = await submit();
    expect(conflictResponse.status).toBe(409);
    const conflict = await conflictResponse.json() as { code?: string };
    expect(conflict.code).toBe("idempotency_conflict");
  });

  test("POST /workspace/:id/conversations/submit blocks remote workspaces before local queue ownership", async () => {
    await useTempVesloDataDir();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-remote-"));
    tempDirs.push(workspaceRoot);
    const upstreamRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        upstreamRequests.push(new URL(request.url).pathname);
        return Response.json({ error: "remote dry-run block must not contact upstream" }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });
    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      workspaces: [{
        id: "ws_remote",
        name: "Remote",
        path: workspaceRoot,
        workspaceType: "remote",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
      }],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_remote/conversations/submit`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: "msg-submit-remote",
          origin: "session:normal",
          target: { directory: workspaceRoot },
          draft: {
            mode: "prompt",
            text: "Remote",
            parts: [{ type: "text", text: "Remote" }],
          },
          options: { dryRun: true },
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      status?: string;
      code?: string;
      draftDisposition?: string;
      recoverable?: boolean;
    };
    expect(payload.status).toBe("blocked");
    expect(payload.code).toBe("remote_submit_unavailable");
    expect(payload.draftDisposition).toBe("restore");
    expect(payload.recoverable).toBe(true);
    expect(upstreamRequests).toEqual([]);

    const queueReadResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_remote/conversations/conv-remote/queue?limit=10`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    expect(queueReadResponse.status).toBe(404);
  });

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
    await mkdir(join(workspaceRoot, ".opencode", "skills", "example"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, ".opencode", "skills", "example", "SKILL.md"),
      "---\nname: example\ndescription: Example\n---\n",
      "utf8",
    );
    const servingCandidate = await prepareRuntimeSkillCandidate({
      id: "ws_orch",
      name: "Orchestrated",
      path: workspaceRoot,
      workspaceType: "local",
    });
    await publishValidatedRuntimeSkillCandidate(servingCandidate);

    let upstreamPath = "";
    const receivedSkillBindings: Array<{
      revision: string | null;
      authorizationRevision: string | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        upstreamPath = url.pathname;
        if (request.method === "POST" && url.pathname === "/workspace/ws_orch/opencode/session") {
          receivedSkillBindings.push({
            revision: request.headers.get("x-veslo-skill-view-revision"),
            authorizationRevision: request.headers.get(
              "x-veslo-skill-authorization-revision",
            ),
          });
          return boundEngineResponse(request, {
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
    expect(receivedSkillBindings[0]).toEqual({
      revision: servingCandidate.revision,
      authorizationRevision: servingCandidate.authorizationRevision,
    });
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
          return boundEngineResponse(request, {
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

  test("POST /workspace/:id/conversations retries unable-to-connect local baseUrl through orchestrator daemon", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-orchestrator-unable-connect-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let staleBaseUrlHit = false;
    const staleUpstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        staleBaseUrlHit = true;
        return Response.json({
          error: "Unable to connect. Is the computer able to access the url?",
        }, { status: 500 });
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
        if (request.method === "POST" && url.pathname === "/workspace/ws_orch_unable_connect/opencode/session") {
          return boundEngineResponse(request, {
            id: "sess-orch-unable-connect",
            title: "Orchestrated unable connect",
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
          id: "ws_orch_unable_connect",
          name: "Orchestrated unable connect",
          path: workspaceRoot,
          baseUrl: `http://127.0.0.1:${staleUpstream.port}/workspace/ws_old/opencode`,
        },
      ],
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_orch_unable_connect/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Orchestrated unable connect",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(staleBaseUrlHit).toBe(true);
    expect(orchestratorPath).toBe("/workspace/ws_orch_unable_connect/opencode/session");
    const payload = await response.json() as { id: string; opencodeSessionId: string };
    expect(payload.id).toBe("sess-orch-unable-connect");
    expect(payload.opencodeSessionId).toBe("sess-orch-unable-connect");
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
          return boundEngineResponse(request, {
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

  test("remote conversation runs bypass the local lifecycle owner", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-remote-lifecycle-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const engineRequests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-remote",
            title: "Remote",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-remote/prompt_async") {
          engineRequests.push(url.pathname);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const lifecycleRequests: string[] = [];
    const lifecycle = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        lifecycleRequests.push(`${request.method} ${url.pathname}`);
        return Response.json({ error: "remote workspaces must not call local lifecycle" }, { status: 500 });
      },
    });
    runningServers.push(lifecycle as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
      orchestratorDaemonUrl: `http://127.0.0.1:${lifecycle.port}`,
      orchestratorLifecycleToken: "lifecycle-token",
      workspaces: [
        {
          id: "ws_remote",
          name: "Remote",
          path: workspaceRoot,
          workspaceType: "remote",
          baseUrl: `http://127.0.0.1:${upstream.port}`,
        },
      ],
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_remote/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          title: "Remote",
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_remote/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
          "X-Veslo-Send-Trace-Id": "send-remote",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Remote run" }],
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    const payload = await runResponse.json() as {
      status?: string;
      debugTrace?: Array<{ event: string; enabled?: boolean }>;
    };
    expect(payload.status).toBe("submitted");
    expect(payload.debugTrace?.some((entry) =>
      entry.event === "server:conversation-run:lifecycle-owner" && entry.enabled === false
    )).toBe(true);
    expect(payload.debugTrace?.some((entry) =>
      entry.event === "server:conversation-run:lifecycle-active-peek" ||
      entry.event === "server:conversation-run:lifecycle-register" ||
      entry.event === "server:conversation-run:queued"
    )).toBe(false);
    expect(lifecycleRequests).toEqual([]);
    expect(engineRequests).toEqual(["/session/sess-remote/prompt_async"]);
  });

  test("POST /workspace/:id/sessions/:sessionId/transcript rejects retired client snapshot writes", async () => {
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
    expect(appendResponse.status).toBe(410);
    await expect(appendResponse.json()).resolves.toMatchObject({
      code: "transcript_snapshot_write_retired",
    });
    expect(latestRequests).toBe(0);
    expect(registerRequests).toEqual([]);
    expect(engineSubmits).toEqual([]);
  });

  test("accepted run lifecycle watcher wakes queued runs after terminal status", async () => {
    setEnvVarForTest("VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_MS", "10");
    setEnvVarForTest("VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_POLL_MS", "20");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-watcher-drain-"));
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
            id: "sess-watcher-drain",
            title: "Watcher drain",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-watcher-drain/prompt_async") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const parts = Array.isArray(body?.parts) ? body.parts : [];
          const firstPart = parts[0] && typeof parts[0] === "object" ? parts[0] as { text?: unknown } : {};
          engineSubmits.push(String(firstPart.text ?? ""));
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    type LifecycleRecord = {
      workspaceId: string;
      conversationId: string;
      runId: string;
      status: "running" | "completed";
      stale: false;
    };
    const records = new Map<string, LifecycleRecord>();
    let latestRunId = "";
    const registerRequests: string[] = [];
    const runStatusRequests: string[] = [];
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
          const runId = typeof body?.runId === "string" ? body.runId : "";
          const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
          registerRequests.push(runId);
          latestRunId = runId;
          const record = { workspaceId: "ws_1", conversationId, runId, status: "running" as const, stale: false as const };
          records.set(runId, record);
          return Response.json({ ok: true, ...record });
        }
        const activeMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/active$/.exec(url.pathname);
        if (request.method === "GET" && activeMatch) {
          const conversationId = decodeURIComponent(activeMatch[1] ?? "");
          const active = [...records.values()].find((record) =>
            record.conversationId === conversationId && record.status === "running"
          );
          if (!active) return Response.json({ error: "run not found" }, { status: 404 });
          return Response.json({ ok: true, ...active });
        }
        const statusMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && statusMatch) {
          const runId = decodeURIComponent(statusMatch[2] ?? "");
          const record = runId === "latest" ? records.get(latestRunId) : records.get(runId);
          if (!record) return Response.json({ error: "run not found" }, { status: 404 });
          runStatusRequests.push(runId);
          return Response.json({ ok: true, ...record });
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
    const createResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: workspaceRoot, title: "Watcher drain" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const firstResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          clientMessageId: "first",
          parts: [{ type: "text", text: "First" }],
        }),
      },
    );
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as { runId: string };
    expect(engineSubmits).toEqual(["First"]);

    const secondResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Second" }],
        }),
      },
    );
    expect(secondResponse.status).toBe(202);
    expect(engineSubmits).toEqual(["First"]);

    const firstRecord = records.get(firstPayload.runId);
    expect(firstRecord).toBeDefined();
    if (firstRecord) firstRecord.status = "completed";

    await waitForCondition(
      () => engineSubmits.includes("Second"),
      { timeoutMs: 1_000, message: "expected accepted-run watcher to wake queued run before poll interval" },
    );
    expect(registerRequests).toHaveLength(2);
    expect(runStatusRequests).toContain(firstPayload.runId);
    expect(engineSubmits).toEqual(["First", "Second"]);
    const secondRunId = registerRequests[1] ?? "";
    const secondRecord = records.get(secondRunId);
    if (secondRecord) secondRecord.status = "completed";
    await waitForCondition(
      () => runStatusRequests.includes(secondRunId),
      { timeoutMs: 1_000, message: "expected second accepted-run watcher to observe terminal status" },
    );
  });

  test("accepted run lifecycle watcher keeps polling stale status until terminal", async () => {
    setEnvVarForTest("VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_MS", "10");
    setEnvVarForTest("VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_POLL_MS", "20");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-watcher-stale-"));
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
            id: "sess-watcher-stale",
            title: "Watcher stale",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-watcher-stale/prompt_async") {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const parts = Array.isArray(body?.parts) ? body.parts : [];
          const firstPart = parts[0] && typeof parts[0] === "object" ? parts[0] as { text?: unknown } : {};
          engineSubmits.push(String(firstPart.text ?? ""));
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    type LifecycleRecord = {
      workspaceId: string;
      conversationId: string;
      runId: string;
      status: "running" | "completed";
    };
    const records = new Map<string, LifecycleRecord>();
    let latestRunId = "";
    let firstRunStatusPolls = 0;
    const registerRequests: string[] = [];
    const runStatusRequests: string[] = [];
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
          const runId = typeof body?.runId === "string" ? body.runId : "";
          const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
          registerRequests.push(runId);
          latestRunId = runId;
          const record = { workspaceId: "ws_1", conversationId, runId, status: "running" as const };
          records.set(runId, record);
          return Response.json({ ok: true, ...record, stale: false });
        }
        const activeMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/active$/.exec(url.pathname);
        if (request.method === "GET" && activeMatch) {
          const conversationId = decodeURIComponent(activeMatch[1] ?? "");
          const active = [...records.values()].find((record) =>
            record.conversationId === conversationId && record.status === "running"
          );
          if (!active) return Response.json({ error: "run not found" }, { status: 404 });
          return Response.json({ ok: true, ...active, stale: false });
        }
        const statusMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && statusMatch) {
          const runId = decodeURIComponent(statusMatch[2] ?? "");
          const record = runId === "latest" ? records.get(latestRunId) : records.get(runId);
          if (!record) return Response.json({ error: "run not found" }, { status: 404 });
          runStatusRequests.push(runId);
          if (runId === registerRequests[0]) {
            firstRunStatusPolls += 1;
            if (firstRunStatusPolls <= 2) {
              return Response.json({ ok: true, ...record, status: "running", stale: true });
            }
            record.status = "completed";
          }
          return Response.json({ ok: true, ...record, stale: false });
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
    const createResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: workspaceRoot, title: "Watcher stale" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const firstResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "First" }],
        }),
      },
    );
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as { runId: string };
    expect(engineSubmits).toEqual(["First"]);

    const secondResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Second" }],
        }),
      },
    );
    expect(secondResponse.status).toBe(202);

    await waitForCondition(
      () => engineSubmits.includes("Second"),
      { timeoutMs: 1_000, message: "expected stale watcher retry to wake queued run after terminal status" },
    );
    expect(runStatusRequests.filter((runId) => runId === firstPayload.runId).length).toBeGreaterThanOrEqual(3);
    expect(registerRequests).toHaveLength(2);
    expect(engineSubmits).toEqual(["First", "Second"]);
  });

  test("successful abort reconciles inactive lifecycle rows to aborted", async () => {
    setEnvVarForTest("VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_MS", "5000");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-abort-reconcile-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/session") {
          return Response.json({
            id: "sess-abort-reconcile",
            title: "Abort reconcile",
            directory: workspaceRoot,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-abort-reconcile/prompt_async") {
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/session/sess-abort-reconcile/abort") {
          return Response.json({ ok: true, aborted: true });
        }
        return Response.json({ error: "unexpected upstream route", path: url.pathname }, { status: 404 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    type LifecycleRecord = {
      workspaceId: string;
      conversationId: string;
      runId: string;
      status: "running" | "completed" | "aborted";
      stale: false;
      abortRequested?: boolean;
      error?: string | null;
    };
    const records = new Map<string, LifecycleRecord>();
    const abortedBodies: Array<Record<string, unknown> | null> = [];
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
          const runId = typeof body?.runId === "string" ? body.runId : "";
          const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
          const record = {
            workspaceId: "ws_1",
            conversationId,
            runId,
            status: "running" as const,
            stale: false as const,
            abortRequested: false,
            error: null,
          };
          records.set(runId, record);
          return Response.json({ ok: true, ...record });
        }
        const activeMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/active$/.exec(url.pathname);
        if (request.method === "GET" && activeMatch) {
          const conversationId = decodeURIComponent(activeMatch[1] ?? "");
          const active = [...records.values()].find((record) =>
            record.conversationId === conversationId && record.status === "running"
          );
          if (!active) return Response.json({ error: "run not found" }, { status: 404 });
          return Response.json({ ok: true, ...active });
        }
        const statusMatch = /^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && statusMatch) {
          const runId = decodeURIComponent(statusMatch[2] ?? "");
          const record = records.get(runId);
          if (!record) return Response.json({ error: "run not found" }, { status: 404 });
          return Response.json({ ok: true, ...record });
        }
        const abortIntentMatch = /^\/workspace\/ws_1\/runs\/([^/]+)\/abort-requested$/.exec(url.pathname);
        if (request.method === "POST" && abortIntentMatch) {
          const runId = decodeURIComponent(abortIntentMatch[1] ?? "");
          const record = records.get(runId);
          if (!record) return Response.json({ error: "run not found" }, { status: 404 });
          record.abortRequested = true;
          return Response.json({ ok: true, ...record });
        }
        const abortedMatch = /^\/workspace\/ws_1\/runs\/([^/]+)\/aborted$/.exec(url.pathname);
        if (request.method === "POST" && abortedMatch) {
          const runId = decodeURIComponent(abortedMatch[1] ?? "");
          const record = records.get(runId);
          if (!record) return Response.json({ error: "run not found" }, { status: 404 });
          abortedBodies.push(body);
          record.status = "aborted";
          record.abortRequested = true;
          record.error = typeof body?.error === "string" ? body.error : null;
          return Response.json({ ok: true, ...record });
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
    const createResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: workspaceRoot, title: "Abort reconcile" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { conversationId: string };

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Abort me" }],
        }),
      },
    );
    expect(runResponse.status).toBe(200);
    const runPayload = await runResponse.json() as { runId: string };
    const record = records.get(runPayload.runId);
    expect(record).toBeDefined();
    if (record) record.status = "completed";

    const abortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/abort`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          directory: workspaceRoot,
          runId: runPayload.runId,
        }),
      },
    );
    expect(abortResponse.status).toBe(200);

    await waitForCondition(
      () => abortedBodies.length > 0 && records.get(runPayload.runId)?.status === "aborted",
      { timeoutMs: 1_000, message: "expected abort reconcile to terminalize inactive run as aborted" },
    );
    expect(records.get(runPayload.runId)?.abortRequested).toBe(true);
    expect(String(abortedBodies[0]?.error ?? "")).toContain("user abort reconciled");
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
          return boundEngineResponse(request, {
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
          messageID: "msg-client-1",
          model: { providerID: "openai", modelID: "gpt-5.5" },
          agent: "build",
          system: "system prompt",
          tools: { read: false },
          mode: "build",
          variant: "xhigh",
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
    expectOpenCodeAdmissionMessageId(receivedBodies[1]?.messageID);
    expect(receivedBodies[1]?.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
    expect(receivedBodies[1]?.agent).toBe("build");
    expect(receivedBodies[1]?.system).toBe("system prompt");
    expect(receivedBodies[1]?.tools).toEqual({ read: false });
    expect(receivedBodies[1]?.mode).toBe("build");
    expect(receivedBodies[1]?.variant).toBe("xhigh");
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
    expect([
      transcriptPayload.opencodeSessionId,
      runPayload.opencodeSessionId,
      abortPayload.opencodeSessionId,
    ]).toEqual(["sess-created", "sess-created", "sess-created"]);

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
    expect(missingRunIdAbortResponse.status).toBe(503);

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

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_b/sessions/${encodeURIComponent(created.conversationId)}/transcript?directory=${encodeURIComponent(workspaceRootB)}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(transcriptResponse.status).toBe(404);
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

  test("conversation run and abort reject unbound OpenCode session ids before engine contact", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-conversations-unbound-session-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return Response.json({ error: "unbound session must not reach upstream" }, { status: 500 });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

    const server = startTestServer({
      workspaceRoot,
      upstreamPort: upstream.port,
    });

    const runResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent("sess-unbound")}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "prompt_async",
          directory: workspaceRoot,
          parts: [{ type: "text", text: "Should not run" }],
        }),
      },
    );
    expect(runResponse.status).toBe(404);

    const abortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent("sess-unbound")}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          runId: "run-unbound",
        }),
      },
    );
    expect(abortResponse.status).toBe(404);
    expect(upstreamHits).toBe(0);
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
    let activeRunAvailable = false;
    let lifecycleStatus = "running";
    let lifecycleError: string | null = null;
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
      conversationRunId: string | null;
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
        engineRequests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          conversationRunId: request.headers.get("x-veslo-conversation-run-id"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/workspace/ws_1/opencode/session") {
          events.push("engine-create-session");
          return boundEngineResponse(request, {
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
          return boundEngineResponse(request, { ok: true });
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
        if (request.method === "POST" && url.pathname === `/workspace/ws_1/runs/${encodeURIComponent(runIdFromRegister)}/aborted`) {
          events.push("orchestrator-mark-aborted");
          return Response.json({ ok: true, runId: runIdFromRegister, status: "aborted", abortRequested: true });
        }
        if (
          request.method === "GET" &&
          (
            url.pathname === `/workspace/ws_1/conversations/${encodeURIComponent(conversationIdFromRegister)}/runs/latest` ||
            url.pathname === `/workspace/ws_1/conversations/${encodeURIComponent(conversationIdFromRegister)}/runs/active`
          )
        ) {
          events.push(url.pathname.endsWith("/runs/active") ? "orchestrator-active" : "orchestrator-status");
          if (url.pathname.endsWith("/runs/active") && !activeRunAvailable) {
            return Response.json({ error: "run not found" }, { status: 404 });
          }
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId: conversationIdFromRegister,
            runId: runIdFromRegister,
            status: lifecycleStatus,
            stale: false,
            clientMessageId: "msg-lifecycle",
            error: lifecycleError,
            activityKind: "model_retry",
            waitReason: "model_retry_no_output",
            lastUsefulProgressAt: 1_000,
            retrySince: 2_000,
            noProgressSeconds: 12,
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
    expect(registerRequest?.body?.opencodeSessionId).toBe("sess-created");
    const submitRequest = engineRequests.find((entry) =>
      entry.pathname === "/workspace/ws_1/opencode/session/sess-created/prompt_async"
    );
    expect(submitRequest).toBeDefined();
    expect(submitRequest?.conversationRunId).toBe(runIdFromRegister);

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs/latest`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    expect(statusResponse.status).toBe(200);
    const statusPayload = await statusResponse.json() as {
      runId: string;
      status: string;
      stale: boolean;
      activityKind?: string | null;
      waitReason?: string | null;
      lastUsefulProgressAt?: number | null;
      retrySince?: number | null;
      noProgressSeconds?: number | null;
    };
    expect(statusPayload.runId).toBe(runIdFromRegister);
    expect(statusPayload.status).toBe("running");
    expect(statusPayload.stale).toBe(false);
    expect(statusPayload.activityKind).toBe("model_retry");
    expect(statusPayload.waitReason).toBe("model_retry_no_output");
    expect(statusPayload.lastUsefulProgressAt).toBe(1_000);
    expect(statusPayload.retrySince).toBe(2_000);
    expect(statusPayload.noProgressSeconds).toBe(12);

    lifecycleStatus = "failed";
    lifecycleError = `Bearer secret-token authorization=secret-authorization ${"detail ".repeat(100)}`;
    const failedStatusResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs/latest`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    expect(failedStatusResponse.status).toBe(200);
    const failedStatusPayload = await failedStatusResponse.json() as Record<string, unknown>;
    expect(failedStatusPayload).toMatchObject({
      runId: runIdFromRegister,
      status: "failed",
      clientMessageId: "msg-lifecycle",
    });
    expect(String(failedStatusPayload.error)).toStartWith("Bearer [redacted] authorization=[redacted]");
    expect(String(failedStatusPayload.error).length).toBeLessThanOrEqual(500);
    expect(failedStatusPayload).not.toHaveProperty("origin");
    expect(failedStatusPayload).not.toHaveProperty("directory");
    expect(failedStatusPayload).not.toHaveProperty("body");
    expect(failedStatusPayload).not.toHaveProperty("runtimeAuthorizationActorTokenHash");

    lifecycleError = JSON.stringify({
      authorization: "json-authorization-secret",
      access_token: "json-token-secret",
      directory: workspaceRoot,
      body: { prompt: "private prompt", parts: [{ type: "text", text: "private body" }] },
      detail: "actionable failure detail",
    });
    const structuredFailureResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/runs/latest`,
      { headers: { Authorization: "Bearer client-token" } },
    );
    const structuredFailurePayload = await structuredFailureResponse.json() as { error?: string | null };
    expect(structuredFailureResponse.status).toBe(200);
    expect(structuredFailurePayload.error).toContain("actionable failure detail");
    expect(structuredFailurePayload.error).not.toContain("json-authorization-secret");
    expect(structuredFailurePayload.error).not.toContain("json-token-secret");
    expect(structuredFailurePayload.error).not.toContain(workspaceRoot);
    expect(structuredFailurePayload.error).not.toContain("private prompt");
    expect(structuredFailurePayload.error).not.toContain("private body");

    activeRunAvailable = true;
    const activeAbortResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(created.conversationId)}/abort`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory: workspaceRoot,
          mode: "active",
        }),
      },
    );
    expect(activeAbortResponse.status).toBe(200);
    const activeAbortPayload = await activeAbortResponse.json() as { runId: string };
    expect(activeAbortPayload.runId).toBe(runIdFromRegister);
    expect(events).toContain("orchestrator-active");
    activeRunAvailable = false;

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
    expect(events.indexOf("orchestrator-abort-requested")).toBeLessThan(events.indexOf("engine-abort"));
    expect(events.indexOf("engine-abort")).toBeLessThan(events.indexOf("orchestrator-mark-aborted"));

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

  test("managed prompt provider-start watchdog records diagnostics without failing accepted runs", async () => {
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
        if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
          return managedAiAccessBundleResponse();
        }
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
          return boundEngineResponse(request, {
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
          return boundEngineResponse(request, { ok: true });
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
    await primeAiGatewayRuntimeAuthorization(server);

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
    const runPayload = await runResponse.json() as { status?: string };
    expect(runPayload.status).toBe("submitted");

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

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(failedRequests).toEqual([]);
    expect(abortRequests).toEqual([]);
  });

  test("managed prompt provider-start watchdog does not resolve ambiguous same-workspace placeholder hits", async () => {
    setEnvVarForTest("VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS", "120");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-server-gateway-same-workspace-ambiguous-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir();

    let sessionIndex = 0;
    let serverPort = 0;
    const registeredRuns: Array<{ runId: string; conversationId: string; sessionId: string }> = [];
    const failedRequests: Array<Record<string, unknown> | null> = [];
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
        if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
          return managedAiAccessBundleResponse();
        }
        if (request.method === "POST" && url.pathname === "/providers/codex_oauth/v1/chat/completions") {
          const requestBody = await request.json().catch(() => null) as unknown;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            sessionId: request.headers.get("x-veslo-session-id"),
            workspaceId: request.headers.get("x-veslo-workspace-id"),
            body: requestBody,
          });
          return Response.json({
            id: "chatcmpl_ambiguous",
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
          sessionIndex += 1;
          return boundEngineResponse(request, {
            id: `sess-ambiguous-${sessionIndex}`,
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname.match(/^\/workspace\/ws_1\/opencode\/session\/sess-ambiguous-\d+\/prompt_async$/)) {
          return boundEngineResponse(request, { ok: true });
        }
        if (request.method === "POST" && url.pathname.endsWith("/abort")) {
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
          registeredRuns.push({
            runId: typeof body?.runId === "string" ? body.runId : "",
            conversationId: typeof body?.conversationId === "string" ? body.conversationId : "",
            sessionId: typeof body?.opencodeSessionId === "string" ? body.opencodeSessionId : "",
          });
          return Response.json({ ok: true, ...body, workspaceId: "ws_1", status: "running", stale: false });
        }
        const failedMatch = url.pathname.match(/^\/workspace\/ws_1\/runs\/([^/]+)\/failed$/);
        if (request.method === "POST" && failedMatch) {
          failedRequests.push(body);
          return Response.json({ ok: true, runId: decodeURIComponent(failedMatch[1] ?? ""), status: "failed" });
        }
        const activeMatch = url.pathname.match(/^\/workspace\/ws_1\/conversations\/([^/]+)\/runs\/([^/]+)$/);
        if (request.method === "GET" && activeMatch) {
          const conversationId = decodeURIComponent(activeMatch[1] ?? "");
          const runId = decodeURIComponent(activeMatch[2] ?? "");
          const match = registeredRuns.find((item) => item.conversationId === conversationId && item.runId === runId);
          return Response.json({
            ok: true,
            workspaceId: "ws_1",
            conversationId,
            runId,
            status: match ? "running" : "completed",
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
    await primeAiGatewayRuntimeAuthorization(server);

    const createConversation = async (title: string) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/conversations`, {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ directory: workspaceRoot, title }),
      });
      expect(response.status).toBe(201);
      return await response.json() as { conversationId: string };
    };

    const firstConversation = await createConversation("Ambiguous One");
    const secondConversation = await createConversation("Ambiguous Two");

    const startRun = async (conversationId: string, text: string) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/conversations/${encodeURIComponent(conversationId)}/runs`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer client-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            kind: "prompt_async",
            directory: workspaceRoot,
            parts: [{ type: "text", text }],
            expectAiGatewayStart: true,
          }),
        },
      );
      return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
    };

    const firstRunPromise = startRun(firstConversation.conversationId, "First");
    const secondRunPromise = startRun(secondConversation.conversationId, "Second");

    await waitForCondition(
      () => registeredRuns.length === 2,
      { timeoutMs: 1_000, message: "expected both same-workspace runs to register" },
    );

    const providerResponse = await fetch(`http://127.0.0.1:${serverPort}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
        "x-veslo-gateway-token": "gateway-access-token",
        "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
        "x-veslo-workspace-id": "ws_1",
      },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "Ambiguous" }] }),
    });
    expect(providerResponse.status).toBe(400);
    expect(await providerResponse.json()).toMatchObject({
      code: "gateway_session_unresolved",
    });
    // Two active runs in one workspace make the placeholder inherently
    // ambiguous. It must be rejected before it can be forwarded without a
    // concrete run correlation.
    expect(providerRequests).toEqual([]);

    const [firstRun, secondRun] = await Promise.all([firstRunPromise, secondRunPromise]);
    expect(firstRun.status).toBe(200);
    expect(secondRun.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(failedRequests).toEqual([]);
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
        if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
          return managedAiAccessBundleResponse();
        }
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
          return boundEngineResponse(request, {
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
          return boundEngineResponse(request, { ok: true });
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
    await primeAiGatewayRuntimeAuthorization(server);

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
        if (request.method === "GET" && url.pathname === "/api/me/ai-access") {
          return managedAiAccessBundleResponse();
        }
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
          return boundEngineResponse(request, {
            id: "sess-target",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_stale/opencode/session") {
          return boundEngineResponse(request, {
            id: "sess-stale",
            title: body?.title,
            directory: body?.directory,
            parentID: null,
            time: { created: 111, updated: 222 },
          });
        }
        if (request.method === "POST" && url.pathname === "/workspace/ws_stale/opencode/session/sess-stale/prompt_async") {
          stalePromptSubmitted = true;
          return boundEngineResponse(request, { ok: true });
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
          return boundEngineResponse(request, { ok: true });
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
    await primeAiGatewayRuntimeAuthorization(server);

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
    expect(staleRun.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(failedRequests.some((entry) => entry.workspaceId === "ws_stale")).toBe(false);
  });
});
