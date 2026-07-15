import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { normalizeConversationDirectoryKey } from "../conversation-binding-store.js";
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

const useOpenCodeDbPath = (dbPath: string) => {
  const previous = process.env.VESLO_OPENCODE_DB_PATH;
  process.env.VESLO_OPENCODE_DB_PATH = dbPath;
  envRestores.push(() => {
    if (previous === undefined) {
      delete process.env.VESLO_OPENCODE_DB_PATH;
    } else {
      process.env.VESLO_OPENCODE_DB_PATH = previous;
    }
  });
};

const useTempVesloDataDir = async (prefix: string) => {
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
};

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(options.message ?? "condition was not met before timeout");
}

const seedOpenCodeDb = (dbPath: string, directory: string, transcriptLimit: number) => {
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

    const seedRows = db.transaction(() => {
      const insertSession = db.query(
        "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      );
      insertSession.run("sess-clicked", "Clicked", directory, null, 10, 500);
      insertSession.run("sess-a", "Session A", directory, null, 10, 400);
      insertSession.run("sess-b", "Session B", directory, null, 10, 300);
      insertSession.run("sub-2", "Sub 2", directory, "sess-a", 10, 200);
      insertSession.run("sub-1", "Sub 1", directory, "sess-a", 10, 100);

      const insertMessage = db.query("INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)");
      const insertPart = db.query("INSERT INTO part (id, session_id, message_id, data) VALUES (?1, ?2, ?3, ?4)");
      for (const sessionId of ["sess-clicked", "sess-a", "sess-b", "sub-2", "sub-1"]) {
        for (const message of buildMessages(sessionId, transcriptLimit)) {
          insertMessage.run(message.info.id, sessionId, JSON.stringify(message.info));
          for (const part of message.parts) {
            insertPart.run(part.id, sessionId, part.messageID, JSON.stringify(part));
          }
        }
      }
    });
    seedRows();
  } finally {
    db.close();
  }
};

describe("session transcript prefetch routes", () => {
  test("raw legacy transcript, prefetch, and artifacts reads materialize canonical identity", async () => {
    const workspaceId = "ws_legacy_identity";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-legacy-identity-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir("veslo-session-transcript-legacy-data-");
    const dbPath = join(workspaceRoot, "opencode.db");
    seedOpenCodeDb(dbPath, workspaceRoot, 12);
    useOpenCodeDbPath(dbPath);

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => new Response("passive identity reads must not hit OpenCode", { status: 500 }),
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
          id: workspaceId,
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
        flushIntervalMs: 5000,
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const authHeaders = { Authorization: "Bearer client-token" };
    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sess-a/transcript?limit=12&directory=${encodeURIComponent(workspaceRoot)}`,
      { headers: authHeaders },
    );
    expect(transcriptResponse.status).toBe(200);
    const transcriptPayload = await transcriptResponse.json() as {
      sessionId: string;
      conversationId?: string;
      opencodeSessionId?: string;
      messages: unknown[];
    };
    expect(transcriptPayload.sessionId).toBe("sess-a");
    expect(transcriptPayload.opencodeSessionId).toBe("sess-a");
    expect(transcriptPayload.conversationId).toMatch(/^conv-/);
    expect(transcriptPayload.messages.length).toBe(12);

    type WarmPrefetchPayload = {
      queuedSessionIds: string[];
      items: Array<{ sessionId: string; conversationId?: string; opencodeSessionId?: string; messages: unknown[] }>;
    };
    const postPrefetch = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/transcript-prefetch`,
        {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            clickedSessionId: "sess-b",
            selectedSessionId: "sess-b",
            loadedTopLevelSessionIds: ["sess-b"],
            expandedSubagentSessionIds: [],
            directory: workspaceRoot,
            sessionDirectoriesById: {
              "sess-b": workspaceRoot,
            },
            limit: 12,
          }),
        },
      );
      expect(response.status).toBe(200);
      return await response.json() as WarmPrefetchPayload;
    };
    await postPrefetch();
    await waitForCondition(async () => {
      const payload = await postPrefetch();
      return Boolean(
        payload.items[0]?.conversationId?.startsWith("conv-") &&
          payload.items[0]?.opencodeSessionId === "sess-b",
      );
    }, { timeoutMs: 1_000, message: "expected prefetch to return canonical legacy identity" });
    const warmPrefetchPayload = await postPrefetch();
    expect(warmPrefetchPayload.queuedSessionIds).toEqual([]);
    expect(warmPrefetchPayload.items[0]?.sessionId).toBe("sess-b");
    expect(warmPrefetchPayload.items[0]?.messages.length).toBe(12);

    const artifactsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sub-1/artifacts/latest-run?directory=${encodeURIComponent(workspaceRoot)}`,
      { headers: authHeaders },
    );
    expect(artifactsResponse.status).toBe(200);
    const artifactsPayload = await artifactsResponse.json() as {
      sessionId: string;
      conversationId?: string;
      opencodeSessionId?: string;
      items: unknown[];
    };
    expect(artifactsPayload.sessionId).toBe("sub-1");
    expect(artifactsPayload.opencodeSessionId).toBe("sub-1");
    expect(artifactsPayload.conversationId).toMatch(/^conv-/);
    expect(Array.isArray(artifactsPayload.items)).toBe(true);

    const missingTranscriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sess-missing/transcript?limit=12&directory=${encodeURIComponent(workspaceRoot)}`,
      { headers: authHeaders },
    );
    expect(missingTranscriptResponse.status).toBe(404);

    const missingArtifactsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sess-missing/artifacts/latest-run?directory=${encodeURIComponent(workspaceRoot)}`,
      { headers: authHeaders },
    );
    expect(missingArtifactsResponse.status).toBe(404);
  }, 20_000);

  test("POST prefetch accepts loaded sidebar payload and GET transcript reads from SQLite without upstream", async () => {
    const workspaceId = "ws_prefetch_route";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-route-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir("veslo-session-transcript-data-");
    const dbPath = join(workspaceRoot, "opencode.db");
    seedOpenCodeDb(dbPath, workspaceRoot, 12);
    useOpenCodeDbPath(dbPath);

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return new Response("passive transcript read must not hit OpenCode", { status: 500 });
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
          id: workspaceId,
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
        flushIntervalMs: 5000,
      },
    });
    runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

    const authHeaders = { Authorization: "Bearer client-token" };

    const conversationsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/conversations`,
      {
        headers: authHeaders,
      },
    );
    expect(conversationsResponse.status).toBe(200);
    const conversationsPayload = await conversationsResponse.json() as {
      workspaceId: string;
      source: string;
      items: Array<{
        id: string;
        conversationId?: string;
        opencodeSessionId?: string;
        directory: string;
        parentID: string | null;
        parentConversationId?: string | null;
      }>;
    };
    expect(conversationsPayload.workspaceId).toBe(workspaceId);
    expect(conversationsPayload.source).toBe("sqlite");
    expect(conversationsPayload.items.map((item) => item.id)).toEqual([
      "sess-clicked",
      "sess-a",
      "sess-b",
      "sub-2",
      "sub-1",
    ]);
    expect(conversationsPayload.items[3]?.parentID).toBe("sess-a");
    const sessionA = conversationsPayload.items.find((item) => item.id === "sess-a");
    const sub2 = conversationsPayload.items.find((item) => item.id === "sub-2");
    expect(sessionA?.conversationId).toMatch(/^conv-/);
    expect(sessionA?.opencodeSessionId).toBe("sess-a");
    expect(sub2?.parentConversationId).toBe(sessionA?.conversationId);

    const scopedConversationsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/conversations?directory=${encodeURIComponent(join(workspaceRoot, "nested"))}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(scopedConversationsResponse.status).toBe(200);
    const scopedConversationsPayload = await scopedConversationsResponse.json() as {
      source: string;
      items: unknown[];
    };
    expect(scopedConversationsPayload.source).toBe("sqlite");
    expect(scopedConversationsPayload.items).toEqual([]);

    const rejectedConversationsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/conversations?directory=${encodeURIComponent(join(tmpdir(), "veslo-outside"))}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(rejectedConversationsResponse.status).toBe(403);

    const rejectedPrefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/transcript-prefetch`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clickedSessionId: null,
          selectedSessionId: "sess-a",
          loadedTopLevelSessionIds: ["sess-a"],
          expandedSubagentSessionIds: [],
          sessionDirectoriesById: {
            "sess-a": join(tmpdir(), "veslo-outside"),
          },
          limit: 12,
        }),
      },
    );
    expect(rejectedPrefetchResponse.status).toBe(403);

    const prefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/transcript-prefetch`,
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
          directory: workspaceRoot,
          sessionDirectoriesById: {
            "sess-clicked": workspaceRoot,
            "sess-a": workspaceRoot,
            "sess-b": workspaceRoot,
            "sub-2": workspaceRoot,
            "sub-1": workspaceRoot,
          },
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
    expect(prefetchPayload.workspaceId).toBe(workspaceId);
    expect(Array.isArray(prefetchPayload.queuedSessionIds)).toBe(true);
    expect(Array.isArray(prefetchPayload.items)).toBe(true);

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sess-a/transcript?limit=12`,
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
      source?: string;
    };
    expect(transcriptPayload.workspaceId).toBe(workspaceId);
    expect(transcriptPayload.sessionId).toBe("sess-a");
    expect(transcriptPayload.limit).toBe(12);
    expect(transcriptPayload.messages.length).toBe(12);
    expect(Object.keys(transcriptPayload.partsByMessageId).length).toBe(12);
    expect(transcriptPayload.source).toBe("sqlite");

    const conversationTranscriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/${encodeURIComponent(sessionA?.conversationId ?? "")}/transcript?limit=12`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );

    expect(conversationTranscriptResponse.status).toBe(200);
    const conversationTranscriptPayload = await conversationTranscriptResponse.json() as {
      sessionId: string;
      conversationId?: string;
      opencodeSessionId?: string;
      messages: unknown[];
    };
    expect(conversationTranscriptPayload.sessionId).toBe("sess-a");
    expect(conversationTranscriptPayload.conversationId).toBe(sessionA?.conversationId);
    expect(conversationTranscriptPayload.opencodeSessionId).toBe("sess-a");
    expect(conversationTranscriptPayload.messages.length).toBe(12);

    const rejectedTranscriptResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/sess-a/transcript?limit=12&directory=${encodeURIComponent(join(tmpdir(), "veslo-outside"))}`,
      {
        headers: {
          Authorization: "Bearer client-token",
        },
      },
    );
    expect(rejectedTranscriptResponse.status).toBe(403);

    const warmPrefetchResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/${workspaceId}/sessions/transcript-prefetch`,
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
          directory: workspaceRoot,
          sessionDirectoriesById: {
            "sess-a": workspaceRoot,
          },
          limit: 12,
        }),
      },
    );

    expect(warmPrefetchResponse.status).toBe(200);
    const warmPrefetchPayload = await warmPrefetchResponse.json() as {
      queuedSessionIds: string[];
      items: Array<{
        sessionId: string;
        directory?: string;
        conversationId?: string;
        opencodeSessionId?: string;
        limit: number;
        messages: unknown[];
      }>;
    };
    expect(warmPrefetchPayload.queuedSessionIds).toEqual([]);
    expect(warmPrefetchPayload.items.length).toBe(1);
    expect(warmPrefetchPayload.items[0]?.sessionId).toBe("sess-a");
    expect(warmPrefetchPayload.items[0]?.directory).toBe(normalizeConversationDirectoryKey(workspaceRoot));
    expect(warmPrefetchPayload.items[0]?.conversationId).toBe(sessionA?.conversationId);
    expect(warmPrefetchPayload.items[0]?.opencodeSessionId).toBe("sess-a");
    expect(warmPrefetchPayload.items[0]?.limit).toBe(12);
    expect(warmPrefetchPayload.items[0]?.messages.length).toBe(12);
    expect(upstreamHits).toBe(0);
  }, 20_000);

  test("routes require client authentication", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-auth-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir("veslo-session-transcript-auth-data-");

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
        flushIntervalMs: 5000,
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

    const conversationsResponse = await fetch(
      `http://127.0.0.1:${server.port}/workspace/ws_1/conversations`,
    );
    expect(conversationsResponse.status).toBe(401);
  });

  test("rejects non-string loaded top-level session ids", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-invalid-visible-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir("veslo-session-transcript-invalid-visible-data-");

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
        flushIntervalMs: 5000,
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
    await useTempVesloDataDir("veslo-session-transcript-invalid-expanded-data-");

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
        flushIntervalMs: 5000,
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
          loadedTopLevelSessionIds: ["sess-a"],
          expandedSubagentSessionIds: ["sub-a", 123, null],
          limit: 12,
        }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("caps oversized transcript limits before passive SQLite read", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-transcript-limit-cap-"));
    tempDirs.push(workspaceRoot);
    await useTempVesloDataDir("veslo-session-transcript-limit-data-");
    const dbPath = join(workspaceRoot, "opencode.db");
    seedOpenCodeDb(dbPath, workspaceRoot, 200);
    useOpenCodeDbPath(dbPath);

    let upstreamHits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        upstreamHits += 1;
        return new Response("passive transcript read must not hit OpenCode", { status: 500 });
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
        flushIntervalMs: 5000,
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
    expect(upstreamHits).toBe(0);
  }, 20_000);
});
