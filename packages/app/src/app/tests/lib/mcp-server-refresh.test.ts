import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServersRefresher } from "../../lib/mcp-server-refresh.js";
import type { McpServerEntry, McpStatusMap } from "../../types.js";

const remoteEntry: McpServerEntry = {
  name: "github",
  source: "config.project",
  owner: {
    kind: "workspace",
    id: "ws-1",
    label: "Workspace",
    root: "/repo",
  },
  config: {
    type: "remote",
    url: "https://mcp.example/github",
  },
};
const listedRemoteEntry: McpServerEntry = {
  ...remoteEntry,
  disabledByTools: undefined,
};

function createHarness() {
  const scheduledRuntimeStatus: Array<{ projectDir: string; entries: McpServerEntry[] }> = [];
  let servers: McpServerEntry[] = [];
  let statuses: McpStatusMap = { stale: { status: "connected" } };
  let status: string | null = "previous";
  let lastUpdatedAt: number | null = null;

  const vesloClient = {
    mcp: {
      list: async () => ({ items: [remoteEntry] }),
    },
  };

  const refresh = createMcpServersRefresher({
    projectDir: () => "/repo",
    workspaceType: () => "local",
    activeWorkspaceId: () => "ws-1",
    activeRuntimeActivityId: () => null,
    isTauriRuntime: () => true,
    developerMode: () => false,
    vesloServerStatus: () => "connected",
    vesloServerClient: () => vesloClient as never,
    vesloServerWorkspaceId: () => "ws-1",
    vesloCapabilities: () => ({ mcp: { read: true, write: true } }) as never,
    setMcpStatus: (value) => {
      status = value;
    },
    setMcpServers: (value) => {
      servers = value;
    },
    setMcpStatuses: (value) => {
      statuses = value;
    },
    setMcpLastUpdatedAt: (value) => {
      lastUpdatedAt = value;
    },
    scheduleRuntimeStatusRefresh: (projectDir, entries) => {
      scheduledRuntimeStatus.push({ projectDir, entries });
    },
  });

  return {
    refresh,
    scheduledRuntimeStatus,
    get servers() {
      return servers;
    },
    get statuses() {
      return statuses;
    },
    get status() {
      return status;
    },
    get lastUpdatedAt() {
      return lastUpdatedAt;
    },
  };
}

test("MCP auto refresh loads persisted config without probing runtime status", async () => {
  const harness = createHarness();

  await harness.refresh();

  assert.deepEqual(harness.servers, [listedRemoteEntry]);
  assert.equal(harness.status, null);
  assert.equal(typeof harness.lastUpdatedAt, "number");
  assert.deepEqual(harness.statuses, { stale: { status: "connected" } });
  assert.deepEqual(harness.scheduledRuntimeStatus, []);
});

test("MCP explicit refresh probes runtime status for user-visible activation checks", async () => {
  const harness = createHarness();

  await harness.refresh({ mode: "explicit", reason: "manual-test" });

  assert.deepEqual(harness.servers, [listedRemoteEntry]);
  assert.deepEqual(harness.scheduledRuntimeStatus, [
    { projectDir: "/repo", entries: [listedRemoteEntry] },
  ]);
});
