import assert from "node:assert/strict";
import test from "node:test";

import { createVesloServerClient } from "../../lib/veslo-server.js";

test("veslo server client exposes transcript prefetch methods", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });

    return new Response(
      JSON.stringify({
        workspaceId: "ws_1",
        queuedSessionIds: [],
        items: [],
        sessionId: "sess-a",
        limit: 12,
        messages: [],
        partsByMessageId: {},
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "token-123",
    });

    assert.equal(typeof (client as { prefetchSessionTranscripts?: unknown }).prefetchSessionTranscripts, "function");
    assert.equal(typeof (client as { listConversations?: unknown }).listConversations, "function");
    assert.equal(typeof (client as { runConversation?: unknown }).runConversation, "function");
    assert.equal(typeof (client as { abortConversation?: unknown }).abortConversation, "function");
    assert.equal(typeof (client as { getSessionTranscript?: unknown }).getSessionTranscript, "function");
    assert.equal(typeof (client as { appendSessionTranscript?: unknown }).appendSessionTranscript, "function");
    assert.equal(typeof (client as { getSessionLatestRunArtifacts?: unknown }).getSessionLatestRunArtifacts, "function");

    const prefetch = await (client as {
      prefetchSessionTranscripts: (
        workspaceId: string,
        input: {
          clickedSessionId?: string | null;
          selectedSessionId?: string | null;
          loadedTopLevelSessionIds: string[];
          expandedSubagentSessionIds: string[];
          directory?: string | null;
          sessionDirectoriesById?: Record<string, string | null | undefined>;
          limit?: number;
        },
      ) => Promise<unknown>;
    }).prefetchSessionTranscripts("ws 1", {
      clickedSessionId: "sess-clicked",
      selectedSessionId: "sess-a",
      loadedTopLevelSessionIds: ["sess-a", "sess-b"],
      expandedSubagentSessionIds: ["sub-2", "sub-1"],
      directory: "/tmp/work space",
      sessionDirectoriesById: {
        "sess-a": "/tmp/work space",
        "sess-b": "/tmp/work space",
        "sub-2": "/tmp/work space/sub",
        "sub-1": "/tmp/work space/sub",
      },
      limit: 12,
    });
    const conversations = await (client as {
      listConversations: (workspaceId: string, directory?: string) => Promise<unknown>;
    }).listConversations("ws 1", "/tmp/work space");
    const run = await (client as {
      runConversation: (
        workspaceId: string,
        conversationId: string,
        input: {
          kind: "prompt_async";
          directory?: string | null;
          parts?: Array<{ type: "text"; text: string }>;
        },
      ) => Promise<unknown>;
    }).runConversation("ws 1", "conv/a", {
      kind: "prompt_async",
      directory: "/tmp/work space",
      parts: [{ type: "text", text: "Hello" }],
    });
    const abort = await (client as {
      abortConversation: (
        workspaceId: string,
        conversationId: string,
        input: { directory?: string | null; runId?: string | null; mode?: "active" | "run" | null },
      ) => Promise<unknown>;
    }).abortConversation("ws 1", "conv/a", {
      directory: "/tmp/work space",
      runId: "run-123",
    });
    const transcript = await (client as {
      getSessionTranscript: (workspaceId: string, sessionId: string, limit?: number, directory?: string) => Promise<unknown>;
    }).getSessionTranscript("ws 1", "sess/a", 12, "/tmp/work space");
    const appendTranscript = await client.appendSessionTranscript("ws 1", "sess/a", {
      directory: "/tmp/work space",
      limit: 12,
      messages: [{ id: "msg-1", sessionID: "sess/a", role: "user" } as any],
      partsByMessageId: { "msg-1": [{ id: "part-1", type: "text", text: "Hello" } as any] },
    });
    const latestArtifacts = await (client as {
      getSessionLatestRunArtifacts: (workspaceId: string, sessionId: string, directory?: string | null) => Promise<unknown>;
    }).getSessionLatestRunArtifacts("ws 1", "sess/a", "/tmp/work space");

    assert.equal(calls.length, 7);

    assert.equal(calls[0]?.url, "http://127.0.0.1:8787/workspace/ws%201/sessions/transcript-prefetch");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      clickedSessionId: "sess-clicked",
      selectedSessionId: "sess-a",
      loadedTopLevelSessionIds: ["sess-a", "sess-b"],
      expandedSubagentSessionIds: ["sub-2", "sub-1"],
      directory: "/tmp/work space",
      sessionDirectoriesById: {
        "sess-a": "/tmp/work space",
        "sess-b": "/tmp/work space",
        "sub-2": "/tmp/work space/sub",
        "sub-1": "/tmp/work space/sub",
      },
      limit: 12,
    });

    assert.equal(calls[1]?.url, "http://127.0.0.1:8787/workspace/ws%201/conversations?directory=%2Ftmp%2Fwork+space");
    assert.equal(calls[1]?.method, "GET");
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[1]?.body, null);

    assert.equal(calls[2]?.url, "http://127.0.0.1:8787/workspace/ws%201/conversations/conv%2Fa/runs");
    assert.equal(calls[2]?.method, "POST");
    assert.equal(calls[2]?.headers.get("authorization"), "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), {
      kind: "prompt_async",
      directory: "/tmp/work space",
      parts: [{ type: "text", text: "Hello" }],
    });

    assert.equal(calls[3]?.url, "http://127.0.0.1:8787/workspace/ws%201/conversations/conv%2Fa/abort");
    assert.equal(calls[3]?.method, "POST");
    assert.equal(calls[3]?.headers.get("authorization"), "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[3]?.body ?? "{}"), {
      directory: "/tmp/work space",
      runId: "run-123",
    });

    assert.equal(calls[4]?.url, "http://127.0.0.1:8787/workspace/ws%201/sessions/sess%2Fa/transcript?limit=12&directory=%2Ftmp%2Fwork+space");
    assert.equal(calls[4]?.method, "GET");
    assert.equal(calls[4]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[4]?.body, null);

    assert.equal(calls[5]?.url, "http://127.0.0.1:8787/workspace/ws%201/sessions/sess%2Fa/transcript");
    assert.equal(calls[5]?.method, "POST");
    assert.equal(calls[5]?.headers.get("authorization"), "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[5]?.body ?? "{}"), {
      directory: "/tmp/work space",
      limit: 12,
      messages: [{ id: "msg-1", sessionID: "sess/a", role: "user" }],
      partsByMessageId: { "msg-1": [{ id: "part-1", type: "text", text: "Hello" }] },
    });

    assert.equal(calls[6]?.url, "http://127.0.0.1:8787/workspace/ws%201/sessions/sess%2Fa/artifacts/latest-run?directory=%2Ftmp%2Fwork+space");
    assert.equal(calls[6]?.method, "GET");
    assert.equal(calls[6]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[6]?.body, null);

    assert.equal(typeof prefetch, "object");
    assert.equal(typeof conversations, "object");
    assert.equal(typeof run, "object");
    assert.equal(typeof abort, "object");
    assert.equal(typeof transcript, "object");
    assert.equal(typeof appendTranscript, "object");
    assert.equal(typeof latestArtifacts, "object");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("veslo server client can request active conversation abort", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        workspaceId: "ws 1",
        conversationId: "conv/a",
        opencodeSessionId: "open-a",
        runId: "run-active",
        status: "submitted",
        kind: "abort",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "token-123",
    });

    await client.abortConversation("ws 1", "conv/a", {
      directory: "/tmp/work space",
      mode: "active",
    });

    assert.equal(calls[0]?.url, "http://127.0.0.1:8787/workspace/ws%201/conversations/conv%2Fa/abort");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      directory: "/tmp/work space",
      mode: "active",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("veslo server client can request active conversation sync explicitly", async () => {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ workspaceId: "ws_1", source: "sqlite", items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "token-123",
    });

    await client.listConversations("ws 1", "/tmp/work space", { sync: true });

    assert.equal(
      calls[0],
      "http://127.0.0.1:8787/workspace/ws%201/conversations?directory=%2Ftmp%2Fwork+space&sync=true",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
