import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpRuntimeStatusRefresher,
  mcpRuntimeTokenRefreshCandidates,
  mcpRuntimeStatusEntriesKey,
} from "../../lib/mcp-runtime-status-refresh.js";
import type { McpServerEntry, McpStatusMap } from "../../types.js";

const entry = (name: string): McpServerEntry => ({
  name,
  config: { type: "remote", url: `https://mcp.example/${name}` },
});

const connectorEntry = (name: string): McpServerEntry => ({
  name,
  config: {
    type: "remote",
    url: `https://mcp.example/${name}`,
    headers: { "X-Veslo-Connector-Token": "old-token" },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("MCP runtime status refresh starts a new request when entries change during an in-flight refresh", async () => {
  const first = deferred<McpStatusMap>();
  const second = deferred<McpStatusMap>();
  const requests = [first, second];
  const calls: string[] = [];
  const applied: McpStatusMap[] = [];
  let currentEntries = [entry("alpha")];

  const refresher = createMcpRuntimeStatusRefresher({
    activeWorkspaceId: () => "ws-1",
    activeRuntimeActivityId: () => null,
    activeWorkspaceRuntimeReady: () => true,
    workspaceProjectDir: () => "/repo",
    client: () => ({ mcp: { status: async () => ({}) } }),
    currentEntries: () => currentEntries,
    loadStatus: async (_client, directory) => {
      calls.push(directory);
      const next = requests.shift();
      assert.ok(next, "unexpected extra status request");
      return next.promise;
    },
    setStatuses: (statuses) => {
      applied.push(statuses);
    },
  });

  refresher.schedule("/repo", currentEntries);
  await tick();
  assert.equal(calls.length, 1);

  currentEntries = [entry("alpha"), entry("beta")];
  refresher.schedule("/repo", currentEntries);
  await tick();
  assert.equal(calls.length, 2, "entries change should not be swallowed by the older in-flight request");

  second.resolve({
    alpha: { status: "connected" },
    beta: { status: "needs_auth" },
    stale: { status: "connected" },
  });
  await tick();
  assert.deepEqual(applied, [
    {
      alpha: { status: "connected" },
      beta: { status: "needs_auth" },
    },
  ]);

  first.resolve({ alpha: { status: "disabled" } });
  await tick();
  assert.deepEqual(
    applied,
    [
      {
        alpha: { status: "connected" },
        beta: { status: "needs_auth" },
      },
    ],
    "stale first result must not overwrite the newer entries status",
  );
});

test("MCP runtime status refresh joins duplicate requests for the same entries key", async () => {
  const status = deferred<McpStatusMap>();
  const calls: string[] = [];
  const entries = [entry("alpha")];
  const refresher = createMcpRuntimeStatusRefresher({
    activeWorkspaceId: () => "ws-1",
    activeRuntimeActivityId: () => null,
    activeWorkspaceRuntimeReady: () => true,
    workspaceProjectDir: () => "/repo",
    client: () => ({ mcp: { status: async () => ({}) } }),
    currentEntries: () => entries,
    loadStatus: async (_client, directory) => {
      calls.push(directory);
      return status.promise;
    },
    setStatuses: () => undefined,
  });

  refresher.schedule("/repo", entries);
  refresher.schedule("/repo", entries);
  await tick();

  assert.equal(calls.length, 1);
  status.resolve({ alpha: { status: "connected" } });
  await tick();
});

test("stale MCP runtime status failures do not clear statuses for the current entries", async () => {
  const first = deferred<McpStatusMap>();
  const second = deferred<McpStatusMap>();
  const requests = [first, second];
  const applied: McpStatusMap[] = [];
  let currentEntries = [entry("alpha")];

  const refresher = createMcpRuntimeStatusRefresher({
    activeWorkspaceId: () => "ws-1",
    activeRuntimeActivityId: () => null,
    activeWorkspaceRuntimeReady: () => true,
    workspaceProjectDir: () => "/repo",
    client: () => ({ mcp: { status: async () => ({}) } }),
    currentEntries: () => currentEntries,
    loadStatus: async () => {
      const next = requests.shift();
      assert.ok(next, "unexpected extra status request");
      return next.promise;
    },
    setStatuses: (statuses) => {
      applied.push(statuses);
    },
  });

  refresher.schedule("/repo", currentEntries);
  await tick();

  currentEntries = [entry("alpha"), entry("beta")];
  refresher.schedule("/repo", currentEntries);
  await tick();

  second.resolve({ alpha: { status: "connected" }, beta: { status: "connected" } });
  await tick();
  first.reject(new Error("old status failed"));
  await tick();

  assert.deepEqual(applied, [
    { alpha: { status: "connected" }, beta: { status: "connected" } },
  ]);
});

test("MCP runtime status entries key reflects entry list changes", () => {
  assert.notEqual(
    mcpRuntimeStatusEntriesKey([entry("alpha")]),
    mcpRuntimeStatusEntriesKey([entry("alpha"), entry("beta")]),
  );
});

test("MCP runtime token refresh candidates require connector token header and auth-like failure", () => {
  assert.deepEqual(
    mcpRuntimeTokenRefreshCandidates(
      {
        google: { status: "failed", error: "401 Unauthorized" },
        plain: { status: "failed", error: "401 Unauthorized" },
        flaky: { status: "failed", error: "socket closed" },
      },
      [
        connectorEntry("google"),
        entry("plain"),
        connectorEntry("flaky"),
      ],
    ),
    ["google"],
  );
});

test("MCP runtime status refresh refreshes connector token once and retries status", async () => {
  const entries = [connectorEntry("google")];
  const applied: McpStatusMap[] = [];
  const loadCalls: string[] = [];
  const refreshCalls: string[] = [];

  const refresher = createMcpRuntimeStatusRefresher({
    activeWorkspaceId: () => "ws-1",
    activeRuntimeActivityId: () => null,
    activeWorkspaceRuntimeReady: () => true,
    workspaceProjectDir: () => "/repo",
    client: () => ({ mcp: { status: async () => ({}) } }),
    currentEntries: () => entries,
    loadStatus: async (_client, directory) => {
      loadCalls.push(directory);
      return loadCalls.length === 1
        ? { google: { status: "failed", error: "expired token: 401" } }
        : { google: { status: "connected" } };
    },
    refreshRuntimeTokens: async ({ status }) => {
      refreshCalls.push(JSON.stringify(status));
      return true;
    },
    setStatuses: (statuses) => {
      applied.push(statuses);
    },
  });

  refresher.schedule("/repo", entries);
  await tick();
  await tick();

  assert.equal(loadCalls.length, 2);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(applied, [{ google: { status: "connected" } }]);
});
