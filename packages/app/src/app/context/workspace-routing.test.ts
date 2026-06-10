import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";

import { createWorkspaceRouting } from "./workspace-routing.js";

function createTestRouting() {
  const fallbackClient = { marker: "fallback", health: () => "fallback" };
  let activeWorkspaceId = "";
  const routing = createWorkspaceRouting({
    clientSource: () => fallbackClient as any,
    activeWorkspaceId: () => activeWorkspaceId,
    createClient: (baseUrl) => ({ marker: baseUrl, health: () => baseUrl } as any),
    waitForHealthy: async () => ({ healthy: true }),
  });
  return {
    routing,
    setActiveWorkspaceId: (id: string) => {
      activeWorkspaceId = id;
    },
  };
}

test("workspace routing does not fall back to a stale global client when active workspace has no route", async () => {
  await createRoot(async (dispose) => {
    try {
      const { routing, setActiveWorkspaceId } = createTestRouting();

      setActiveWorkspaceId("ws-old");
      await routing.ensure("ws-old", "old-base-url");
      assert.equal((routing.active() as any)?.marker, "old-base-url");

      setActiveWorkspaceId("ws-new");

      assert.equal(routing.active(), null);
      assert.equal(routing.client(), null);
      assert.equal(routing.client("ws-new"), null);
    } finally {
      dispose();
    }
  });
});

test("workspace routing keeps fallback client only for pre-workspace bootstrap", () => {
  createRoot((dispose) => {
    try {
      const { routing } = createTestRouting();
      assert.equal((routing.active() as any)?.marker, "fallback");
      assert.equal((routing.client() as any)?.marker, "fallback");
    } finally {
      dispose();
    }
  });
});
