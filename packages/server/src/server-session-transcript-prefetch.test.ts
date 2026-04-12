import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

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

const buildMessages = (sessionId: string, limit: number) =>
  Array.from({ length: limit }, (_, index) => {
    const messageId = `msg-${sessionId}-${index + 1}`;
    const partId = `part-${sessionId}-${index + 1}`;
    return {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
      },
      parts: [
        {
          id: partId,
          messageID: messageId,
          sessionID: sessionId,
          type: "text",
          text: `message-${index + 1}`,
        },
      ],
    };
  });

describe("session transcript prefetch routes", () => {
  test("POST prefetch accepts loaded sidebar payload and GET transcript returns warm snapshot", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-route-"));
    tempDirs.push(workspaceRoot);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/session\/([^/]+)\/message$/);
        if (!match) return new Response("not found", { status: 404 });
        const sessionId = decodeURIComponent(match[1] ?? "").trim();
        if (!sessionId) return new Response("bad session", { status: 400 });
        const limitRaw = Number(url.searchParams.get("limit") ?? "140");
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 140;
        return new Response(JSON.stringify(buildMessages(sessionId, limit)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
          baseUrl: `http://127.0.0.1:${upstream.port}`,
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
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const prefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: "sess-clicked",
          selectedSessionId: "sess-a",
          loadedTopLevelSessionIds: ["sess-a", "sess-b"],
          expandedSubagentSessionIds: ["sub-2", "sub-1"],
          limit: 12,
        }),
      },
    );

    expect(prefetchResponse.status).toBe(200);
    const prefetchPayload = await prefetchResponse.json() as {
      workspaceId: string;
      queuedSessionIds: string[];
      items: Array<{ sessionId: string; limit: number; messages: unknown[] }>;
    };
    expect(prefetchPayload.workspaceId).toBe("ws_1");
    expect(Array.isArray(prefetchPayload.queuedSessionIds)).toBe(true);
    expect(Array.isArray(prefetchPayload.items)).toBe(true);

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/sess-a/transcript?limit=12`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );

    expect(transcriptResponse.status).toBe(200);
    const transcriptPayload = await transcriptResponse.json() as {
      workspaceId: string;
      sessionId: string;
      limit: number;
      messages: unknown[];
      partsByMessageId: Record<string, unknown[]>;
    };
    expect(transcriptPayload.workspaceId).toBe("ws_1");
    expect(transcriptPayload.sessionId).toBe("sess-a");
    expect(transcriptPayload.limit).toBe(12);
    expect(transcriptPayload.messages.length).toBe(12);
    expect(Object.keys(transcriptPayload.partsByMessageId).length).toBe(12);

    const warmPrefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: "sess-a",
          selectedSessionId: "sess-a",
          loadedTopLevelSessionIds: ["sess-a"],
          expandedSubagentSessionIds: [],
          limit: 12,
        }),
      },
    );

    expect(warmPrefetchResponse.status).toBe(200);
    const warmPrefetchPayload = await warmPrefetchResponse.json() as {
      queuedSessionIds: string[];
      items: Array<{ sessionId: string; limit: number; messages: unknown[] }>;
    };
    expect(warmPrefetchPayload.queuedSessionIds).toEqual([]);
    expect(warmPrefetchPayload.items.length).toBe(1);
    expect(warmPrefetchPayload.items[0]?.sessionId).toBe("sess-a");
    expect(warmPrefetchPayload.items[0]?.limit).toBe(12);
    expect(warmPrefetchPayload.items[0]?.messages.length).toBe(12);
  });

  test("routes require client authentication", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-auth-"));
    tempDirs.push(workspaceRoot);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
          baseUrl: `http://127.0.0.1:${upstream.port}`,
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
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const prefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: "sess-a",
          selectedSessionId: "sess-a",
          loadedTopLevelSessionIds: ["sess-a"],
          expandedSubagentSessionIds: [],
          limit: 12,
        }),
      },
    );
    expect(prefetchResponse.status).toBe(401);

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/sess-a/transcript?limit=12`,
    );
    expect(transcriptResponse.status).toBe(401);
  });

  test("rejects non-string loaded top-level session ids", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-invalid-visible-"));
    tempDirs.push(workspaceRoot);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
          baseUrl: `http://127.0.0.1:${upstream.port}`,
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
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: "sess-a",
          selectedSessionId: null,
          loadedTopLevelSessionIds: ["sess-a", 123, null],
          expandedSubagentSessionIds: [],
          limit: 12,
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("rejects non-string expanded subagent ids", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-invalid-expanded-"));
    tempDirs.push(workspaceRoot);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
          baseUrl: `http://127.0.0.1:${upstream.port}`,
        },
      ],
      authorizedRoots: [workspaceRoot],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const response = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: "sess-a",
          selectedSessionId: null,
          loadedTopLevelSessionIds: ["sess-a"],
          expandedSubagentSessionIds: ["sub-a", 123, null],
          limit: 12,
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("caps oversized transcript limits before upstream fetch", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-limit-cap-"));
    tempDirs.push(workspaceRoot);
    const seenLimits: number[] = [];

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/session\/([^/]+)\/message$/);
        if (!match) return new Response("not found", { status: 404 });
        const sessionId = decodeURIComponent(match[1] ?? "").trim();
        if (!sessionId) return new Response("bad session", { status: 400 });
        const limitRaw = Number(url.searchParams.get("limit") ?? "140");
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 140;
        seenLimits.push(limit);
        return new Response(JSON.stringify(buildMessages(sessionId, limit)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
          baseUrl: `http://127.0.0.1:${upstream.port}`,
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
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/sess-a/transcript?limit=999`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );

    expect(transcriptResponse.status).toBe(200);
    const transcriptPayload = await transcriptResponse.json() as {
      limit: number;
      messages: unknown[];
    };
    expect(transcriptPayload.limit).toBe(200);
    expect(transcriptPayload.messages.length).toBe(200);
    expect(seenLimits).toEqual([200]);
  });
});
