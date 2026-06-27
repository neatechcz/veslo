import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { createSessionStore } from "../../context/session.js";
import { createWorkspaceRouting } from "../../context/workspace-routing.js";

function makeTestRouting(client: () => any) {
  return createWorkspaceRouting({
    clientSource: client,
    activeWorkspaceId: () => "test-workspace",
    createClient: () => client() as any,
    waitForHealthy: async () => ({ healthy: true }),
  });
}

const makeTextPart = (): Part => ({
  id: "part-1",
  sessionID: "sess-a",
  messageID: "msg-1",
  type: "text",
  text: "Hi",
  synthetic: false,
  ignored: false,
});

const makeMessageInfo = () => ({
  id: "msg-1",
  sessionID: "sess-a",
  role: "assistant" as const,
  time: { created: 1 },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const makeSession = (id: string) => ({
  id,
  title: id,
  directory: `/tmp/${id}`,
  time: { created: 1, updated: 1 },
});

test("hydrateTranscriptSnapshot stores messages and keeps the current selection unchanged", () => {
  createRoot((dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("sess-b");

      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
      });

      store.hydrateTranscriptSnapshot({
        workspaceId: "ws_local",
        sessionId: "sess-a",
        limit: 140,
        messages: [makeMessageInfo()],
        partsByMessageId: { "msg-1": [makeTextPart()] },
        fetchedAt: 1,
        staleAt: 2,
      });

      assert.equal(store.getCachedTranscriptMessageCount("sess-a"), 1);
      assert.equal(store.messages().length, 0);

      assert.equal(store.hasWarmTranscript("sess-a"), true);
    } finally {
      dispose();
    }
  });
});

test("hydrateTranscriptSnapshot keeps messages in creation order", () => {
  createRoot((dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("sess-a");

      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
      });

      store.setSessions([makeSession("sess-a") as any]);
      store.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        limit: 140,
        messages: [
          { ...makeMessageInfo(), id: "msg-a", time: { created: 20 } },
          { ...makeMessageInfo(), id: "msg-z", time: { created: 10 } },
        ],
        partsByMessageId: {
          "msg-a": [{ ...makeTextPart(), id: "part-a", messageID: "msg-a" }],
          "msg-z": [{ ...makeTextPart(), id: "part-z", messageID: "msg-z" }],
        },
        fetchedAt: 1,
        staleAt: 2,
      });

      assert.deepEqual(store.getCachedTranscriptMessages("sess-a").map((message) => message.id), ["msg-z", "msg-a"]);
    } finally {
      dispose();
    }
  });
});

test("workspace snapshots restore transcript freshness and evict old workspace snapshots", () => {
  createRoot((dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);

      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
      });

      store.setSessions([makeSession("sess-a") as any]);
      setSelectedSessionId("sess-a");
      store.hydrateTranscriptSnapshot({
        workspaceId: "ws-a",
        sessionId: "sess-a",
        limit: 140,
        messages: [makeMessageInfo()],
        partsByMessageId: { "msg-1": [makeTextPart()] },
        fetchedAt: 10,
        staleAt: 20,
      });
      store.saveWorkspaceSnapshot("ws-a");

      const messageB = { ...makeMessageInfo(), id: "msg-b", sessionID: "sess-b" };
      const partB = { ...makeTextPart(), id: "part-b", sessionID: "sess-b", messageID: "msg-b" };
      store.setSessions([makeSession("sess-b") as any]);
      setSelectedSessionId("sess-b");
      store.hydrateTranscriptSnapshot({
        workspaceId: "ws-b",
        sessionId: "sess-b",
        limit: 140,
        messages: [messageB],
        partsByMessageId: { "msg-b": [partB] },
        fetchedAt: 30,
        staleAt: 40,
      });
      store.saveWorkspaceSnapshot("ws-b");

      assert.equal(store.loadWorkspaceSnapshot("ws-b"), true);
      assert.equal(store.getTranscriptFreshness("sess-a"), null);
      assert.deepEqual(store.getTranscriptFreshness("sess-b"), { fetchedAt: 30, staleAt: 40 });

      assert.equal(store.loadWorkspaceSnapshot("ws-a"), true);
      assert.equal(selectedSessionId(), "sess-a");
      assert.equal(store.getCachedTranscriptMessageCount("sess-a"), 1);
      assert.deepEqual(store.getTranscriptFreshness("sess-a"), { fetchedAt: 10, staleAt: 20 });
      assert.equal(store.getTranscriptFreshness("sess-b"), null);

      for (let index = 2; index <= 7; index += 1) {
        const sessionId = `sess-${index}`;
        store.setSessions([makeSession(sessionId) as any]);
        setSelectedSessionId(sessionId);
        store.saveWorkspaceSnapshot(`ws-${index}`);
      }

      assert.equal(store.loadWorkspaceSnapshot("ws-b"), false);
      assert.equal(store.loadWorkspaceSnapshot("ws-7"), true);
    } finally {
      dispose();
    }
  });
});

test("app hydrates transcript snapshots returned by veslo prefetch calls", () => {
  const source = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
  const eventStreamSource = readFileSync(new URL("../../context/session-event-stream.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /prefetchSessionTranscripts:\s*async\s*\(workspaceId,\s*input\)\s*=>/,
    "app should wrap prefetchSessionTranscripts so warm snapshots hydrate immediately",
  );
  assert.match(
    source,
    /for \(const item of result\.items\) \{[\s\S]*hydrateTranscriptSnapshot\(item\);/s,
    "prefetch responses should hydrate every returned transcript snapshot",
  );
  assert.match(
    source,
    /rememberConversationScopeFromTranscript\(workspaceId,\s*undefined,\s*item\);/s,
    "prefetch responses should register conversation scope sidecars before hydration",
  );
  assert.match(
    source,
    /getSessionTranscript:\s*async\s*\(workspaceId,\s*sessionId,\s*limit = 140,\s*directory\)\s*=>/,
    "app should wrap getSessionTranscript through the same hydration path",
  );
  assert.match(
    source,
    /hydrateTranscriptSnapshot\(snapshot\);/,
    "direct transcript fetches should hydrate before returning",
  );
  assert.match(
    source,
    /rememberConversationScopeFromTranscript\(workspaceId,\s*directory,\s*snapshot\);/s,
    "direct transcript fetches should register conversation scope sidecars",
  );
  assert.match(
    source,
    /appendTranscriptSnapshot:\s*async\s*\(input\)\s*=>/s,
    "session store should receive a live transcript writer",
  );
  assert.match(
    source,
    /appendSessionTranscript\(serverWorkspaceId,\s*sessionId,\s*\{/s,
    "live transcript writer should append to the host-side Veslo server transcript endpoint",
  );
  assert.match(
    source,
    /appendSessionTranscript:\s*async\s*\(workspaceId,\s*sessionId,\s*input\)\s*=>/s,
    "hydrated Veslo client should wrap appendSessionTranscript",
  );
  assert.match(
    source,
    /appendSessionTranscript:\s*async\s*\(workspaceId,\s*sessionId,\s*input\)\s*=>[\s\S]*hydrateTranscriptSnapshot\(snapshot,\s*\{ allowShorter: true \}\);/s,
    "authoritative append transcript snapshots should be allowed to apply shorter deletion results",
  );
  assert.match(
    eventStreamSource,
    /deps\.scheduleTranscriptIngestion\(info\.sessionID,\s*sourceWsId,\s*"message\.updated"\);/s,
    "message updates should schedule live transcript ingestion",
  );
  assert.match(
    eventStreamSource,
    /deps\.scheduleTranscriptIngestion\(part\.sessionID,\s*sourceWsId,\s*"message\.part\.updated"\);/s,
    "part updates should schedule live transcript ingestion",
  );
  assert.match(
    eventStreamSource,
    /deps\.scheduleTranscriptIngestion\(sessionID,\s*sourceWsId,\s*"session\.idle",\s*0\);/s,
    "idle events should flush live transcript ingestion immediately",
  );
});
