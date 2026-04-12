import assert from "node:assert/strict";
import test from "node:test";

import { createVesloServerClient } from "./veslo-server.js";

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
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    assert.equal(typeof (client as { prefetchSessionTranscripts?: unknown }).prefetchSessionTranscripts, "function");
    assert.equal(typeof (client as { getSessionTranscript?: unknown }).getSessionTranscript, "function");

    const prefetch = await (client as {
      prefetchSessionTranscripts: (
        workspaceId: string,
        input: {
          clickedSessionId?: string | null;
          selectedSessionId?: string | null;
          loadedTopLevelSessionIds: string[];
          expandedSubagentSessionIds: string[];
          limit?: number;
        },
      ) => Promise<unknown>;
    }).prefetchSessionTranscripts("ws 1", {
      clickedSessionId: "sess-clicked",
      selectedSessionId: "sess-a",
      loadedTopLevelSessionIds: ["sess-a", "sess-b"],
      expandedSubagentSessionIds: ["sub-2", "sub-1"],
      limit: 12,
    });
    const transcript = await (client as {
      getSessionTranscript: (workspaceId: string, sessionId: string, limit?: number) => Promise<unknown>;
    }).getSessionTranscript("ws 1", "sess/a", 12);

    assert.equal(calls.length, 2);

    assert.equal(calls[0]?.url, "https://veslo.example/workspace/ws%201/sessions/transcript-prefetch");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      clickedSessionId: "sess-clicked",
      selectedSessionId: "sess-a",
      loadedTopLevelSessionIds: ["sess-a", "sess-b"],
      expandedSubagentSessionIds: ["sub-2", "sub-1"],
      limit: 12,
    });

    assert.equal(calls[1]?.url, "https://veslo.example/workspace/ws%201/sessions/sess%2Fa/transcript?limit=12");
    assert.equal(calls[1]?.method, "GET");
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[1]?.body, null);

    assert.equal(typeof prefetch, "object");
    assert.equal(typeof transcript, "object");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
