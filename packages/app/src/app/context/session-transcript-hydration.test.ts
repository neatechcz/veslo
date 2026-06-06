import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { createSessionStore } from "./session.js";
import { createWorkspaceRouting } from "./workspace-routing.js";

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

test("app hydrates transcript snapshots returned by veslo prefetch calls", () => {
  const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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
});
