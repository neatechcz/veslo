import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { createSessionStore } from "../../context/session.js";
import { createWorkspaceRouting } from "../../context/workspace-routing.js";
import { deriveSessionRunPresentation } from "../../pages/session-run-presentation.js";

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

test("accepted run recovery hydrates an OpenCode snapshot under the materialized UI session", async () => {
  await createRoot(async (dispose) => {
    try {
      const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>("ses-ui");
      const store = createSessionStore({
        client: () => null,
        routing: makeTestRouting(() => null),
        activeWorkspaceRoot: () => "/tmp/project",
        selectedSessionId,
        setSelectedSessionId,
        developerMode: () => false,
        setError: () => {},
        setSseConnected: () => {},
        resolveConversationRunForSession: () => null,
        readConversationRunStatus: async () => ({
          runId: "run-a",
          status: "completed",
          stale: false,
          clientMessageId: "msg-client-a",
        }),
        recoverConversationTranscript: async () => ({
          workspaceId: "server-workspace",
          sessionId: "ses-open",
          opencodeSessionId: "ses-open",
          conversationId: "conv-a",
          limit: 140,
          messages: [{ ...makeMessageInfo(), sessionID: "ses-open" }],
          partsByMessageId: {
            "msg-1": [{ ...makeTextPart(), sessionID: "ses-open" }],
          },
          source: "sqlite",
        }),
      });
      store.setSessions([makeSession("ses-ui") as any]);

      assert.equal(store.admitAcceptedConversationRun({
        sessionId: "ses-ui",
        workspaceId: "test-workspace",
        conversationId: "conv-a",
        opencodeSessionId: "ses-open",
        directory: "/tmp/project",
        runId: "run-a",
        clientMessageId: "msg-client-a",
      }), true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(store.getCachedTranscriptMessageCount("ses-ui"), 1);
      assert.equal(store.getCachedTranscriptMessageCount("ses-open"), 0);
      assert.deepEqual(
        store.getCachedTranscriptMessages("ses-ui").map((message) => message.id),
        ["msg-1"],
      );

      const lifecycle = Object.values(store.conversationRunDiagnosticsBySessionKey())
        .find((diagnostic) => diagnostic.runId === "run-a");
      assert.ok(lifecycle);
      const presentation = deriveSessionRunPresentation({
        hasSessionScope: true,
        engineStatus: "idle",
        lifecycle,
        local: {
          started: true,
          hasBegun: true,
          optimisticSending: true,
          optimisticAccepted: true,
          acceptedRunId: "run-a",
          acceptedClientMessageId: "msg-client-a",
          responseStarted: false,
        },
      });
      assert.equal(presentation.phase, "idle");
      assert.equal(presentation.showIndicator, false);
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
    /prefetchSessionTranscripts:\s*async\s*\(workspaceId,\s*input,\s*clientOptions\)\s*=>/,
    "app should wrap prefetchSessionTranscripts so warm snapshots hydrate immediately",
  );
  assert.match(
    source,
    /for \(const item of result\.items\) \{[\s\S]*hydrateTranscriptSnapshot\(item\);/s,
    "prefetch responses should hydrate every returned transcript snapshot",
  );
  assert.match(
    source,
    /const appWorkspaceId = clientOptions\?\.appWorkspaceId\?\.trim\(\) \|\| "";[\s\S]*if \(appWorkspaceId\) \{[\s\S]*rememberConversationScopeFromTranscript\(appWorkspaceId,\s*undefined,\s*item\);/s,
    "prefetch responses should register scope sidecars only under their caller-provided app workspace",
  );
  assert.match(
    source,
    /getSessionTranscript:\s*async\s*\(workspaceId,\s*sessionId,\s*limit = 140,\s*directory,\s*options\)\s*=>/,
    "app should wrap getSessionTranscript through the same hydration path",
  );
  assert.match(
    source,
    /if \(!transcriptProjectionStore\.isReservedTranscriptSnapshot\(snapshot\)\) \{[\s\S]*hydrateTranscriptSnapshot\(snapshot\);[\s\S]*\}/s,
    "direct transcript fetches should not hydrate snapshots reserved for the selected transcript projection",
  );
  assert.match(
    source,
    /const appWorkspaceId = options\?\.appWorkspaceId\?\.trim\(\) \|\| "";[\s\S]*if \(appWorkspaceId\) \{[\s\S]*rememberConversationScopeFromTranscript\(appWorkspaceId,\s*directory,\s*snapshot\);/s,
    "direct transcript fetches should register scope sidecars only with an explicit app workspace",
  );
  assert.match(
    source,
    /readScopedSessionStatus\(readSessionStatusForTranscriptProjection\(\), appWorkspaceId, sessionId\)/,
    "projection activity guards must use the strict app-workspace scoped session status",
  );
  assert.doesNotMatch(
    source,
    /readSessionStatusForTranscriptProjection\(\)\[sessionId\]/,
    "projection activity guards must not read an unscoped session-status key directly",
  );
  assert.doesNotMatch(source, /appendTranscriptSnapshot|appendSessionTranscript/);
  assert.doesNotMatch(eventStreamSource, /scheduleTranscriptIngestion|scheduleBackgroundTranscriptIngestion/);
});
