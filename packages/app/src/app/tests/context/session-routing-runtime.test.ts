import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import { createSessionStore } from "../../context/session.js";

const eventStreamSource = readFileSync(new URL("../../context/session-event-stream.ts", import.meta.url), "utf8");

function ok<T>(data: T) {
  return {
    data,
    request: new Request("http://localhost.test"),
    response: new Response(),
  };
}

function createRuntimeStore(options: { routing: any; client?: () => any; setSseConnected?: (connected: boolean) => void }) {
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  return createSessionStore({
    client: options.client ?? (() => null),
    routing: options.routing,
    activeWorkspaceRoot: () => "",
    selectedSessionId,
    setSelectedSessionId,
    developerMode: () => false,
    setError: () => {},
    setSseConnected: options.setSseConnected ?? (() => {}),
    engineReady: () => true,
  });
}

test("session SSE subscription passes workspace routing auth to the Rust proxy", () => {
  assert.match(
    eventStreamSource,
    /engineSseSubscribe\(\{[\s\S]*baseUrl: entry\?\.baseUrl \?\? "",[\s\S]*directory: entry\?\.directory \?\? null,[\s\S]*\.\.\.engineSseAuthOptions\(entry\?\.auth\),[\s\S]*signal: controller\.signal,/,
    "per-workspace desktop SSE must use the same auth as the SDK client",
  );
});

test("session SSE records SDK fallback as degraded transport", () => {
  assert.match(
    eventStreamSource,
    /recordSendWorkflowTrace\([\s\S]*"session-sse"[\s\S]*useRustSse \? "session-sse:rust-proxy" : "session-sse:sdk-fallback"[\s\S]*transport: useRustSse \? "rust-proxy" : "sdk-sse-fallback"/,
    "desktop SDK SSE fallback should be visible in send workflow diagnostics",
  );
});

test("session SSE releases stale non-active workspace routes before reconnecting", () => {
  assert.match(
    eventStreamSource,
    /const activeWs = deps\.routing\.activeWorkspaceId\(\);[\s\S]*if \(shouldReleaseStaleWorkspaceRoute\(sourceWsId, activeWs, message\)\) \{[\s\S]*setStreamSseConnected\(streamConnectionKey, false\);[\s\S]*deps\.routing\.release\(sourceWsId\);[\s\S]*deps\.sessionWarn\("sse:released-stale-route"[\s\S]*return;[\s\S]*\}[\s\S]*setStreamSseConnected\(streamConnectionKey, false\);[\s\S]*recordPerfLog\(deps\.sessionDebugEnabled\(\), "session\.sse", "stream-error"/,
    "stale background SSE failures should release the route without resetting unrelated connected streams",
  );
});

test("permission refresh releases stale non-active workspace routes on runtime failures", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        const activeClient = {
          permission: {
            list: async () => ok([]),
          },
        };
        const staleClient = {
          permission: {
            list: async () => {
              throw new Error('{"error":"engine_not_running","workspaceId":"ws-stale"}');
            },
          },
        };
        const released: string[] = [];
        const routing = {
          active: () => activeClient,
          client: () => null,
          activeWorkspaceId: () => "ws-active",
          entry: () => null,
          entryIds: () => [],
          forEach: (cb: (workspaceId: string, client: any) => void) => {
            cb("ws-active", activeClient);
            cb("ws-stale", staleClient);
          },
          release: (workspaceId: string) => {
            released.push(workspaceId);
          },
        };

        try {
          const store = createRuntimeStore({ routing });
          await store.refreshPendingPermissions();

          assert.deepEqual(released, ["ws-stale"]);
          assert.deepEqual(Object.keys(store.pendingPermissionsByWs()).sort(), ["ws-active"]);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});

test("permission refresh keeps active workspace runtime failures visible", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        const activeClient = {
          permission: {
            list: async () => {
              throw new Error('{"error":"engine_not_running","workspaceId":"ws-active"}');
            },
          },
        };
        const released: string[] = [];
        const routing = {
          active: () => activeClient,
          client: () => null,
          activeWorkspaceId: () => "ws-active",
          entry: () => null,
          entryIds: () => [],
          forEach: (cb: (workspaceId: string, client: any) => void) => {
            cb("ws-active", activeClient);
          },
          release: (workspaceId: string) => {
            released.push(workspaceId);
          },
        };

        try {
          const store = createRuntimeStore({ routing });
          await store.refreshPendingPermissions();

          assert.deepEqual(released, []);
          assert.deepEqual(Object.keys(store.pendingPermissionsByWs()).sort(), ["ws-active"]);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          dispose();
        }
      })();
    });
  });
});
