import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServersRefresher, fingerprintMcpServerEntries } from "../../lib/mcp-server-refresh.js";
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

function createHarness(options: {
  activeWorkspaceId?: () => string;
  projectDir?: () => string;
  entries?: () => McpServerEntry[];
} = {}) {
  const scheduledRuntimeStatus: Array<{ projectDir: string; entries: McpServerEntry[] }> = [];
  const lastUpdatedAtUpdates: Array<number | null> = [];
  let servers: McpServerEntry[] = [];
  let statuses: McpStatusMap = { stale: { status: "connected" } };
  let status: string | null = "previous";
  let lastUpdatedAt: number | null = null;

  const vesloClient = {
    mcp: {
      list: async () => ({ items: options.entries?.() ?? [remoteEntry] }),
    },
  };

  const refresh = createMcpServersRefresher({
    projectDir: options.projectDir ?? (() => "/repo"),
    workspaceType: () => "local",
    activeWorkspaceId: options.activeWorkspaceId ?? (() => "ws-1"),
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
      lastUpdatedAtUpdates.push(value);
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
    get lastUpdatedAtUpdates() {
      return lastUpdatedAtUpdates;
    },
  };
}

test("MCP auto refresh loads persisted config without probing runtime status", async () => {
  const harness = createHarness();

  await harness.refresh();

  assert.deepEqual(harness.servers, [listedRemoteEntry]);
  assert.equal(harness.status, null);
  assert.equal(typeof harness.lastUpdatedAt, "number");
  assert.equal(harness.lastUpdatedAtUpdates.length, 1);
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

test("MCP refresh fingerprint is stable across entry and config key order", () => {
  const left: McpServerEntry[] = [
    {
      name: "b",
      source: "config.project",
      config: {
        type: "remote",
        headers: { Authorization: "Bearer token", "X-Team": "veslo" },
        url: "https://mcp.example/b",
      },
    },
    {
      name: "a",
      source: "config.global",
      config: {
        type: "local",
        command: ["node", "server.js"],
        environment: { ZED: "1", ALPHA: "2" },
      },
    },
  ];
  const right: McpServerEntry[] = [
    {
      name: "a",
      source: "config.global",
      config: {
        environment: { ALPHA: "2", ZED: "1" },
        command: ["node", "server.js"],
        type: "local",
      },
    },
    {
      name: "b",
      source: "config.project",
      config: {
        url: "https://mcp.example/b",
        type: "remote",
        headers: { "X-Team": "veslo", Authorization: "Bearer token" },
      },
    },
  ];

  assert.equal(fingerprintMcpServerEntries(left), fingerprintMcpServerEntries(right));
});

test("MCP refresh only bumps session capability fingerprint when entries materially change", async () => {
  const harness = createHarness();

  await harness.refresh();
  await harness.refresh();

  assert.equal(harness.lastUpdatedAtUpdates.length, 1);
  assert.deepEqual(harness.servers, [listedRemoteEntry]);
});

test("MCP refresh bumps session capability fingerprint when the target project changes", async () => {
  let projectDir = "/repo";
  const harness = createHarness({ projectDir: () => projectDir });

  await harness.refresh();
  projectDir = "/repo-two";
  await harness.refresh();

  assert.equal(harness.lastUpdatedAtUpdates.length, 2);
  assert.deepEqual(harness.servers, [listedRemoteEntry]);
});

test("MCP explicit refresh probes runtime status even when entries are unchanged", async () => {
  const harness = createHarness();

  await harness.refresh({ mode: "explicit", reason: "manual-test" });
  await harness.refresh({ mode: "explicit", reason: "manual-test-repeat" });

  assert.equal(harness.lastUpdatedAtUpdates.length, 1);
  assert.deepEqual(harness.scheduledRuntimeStatus, [
    { projectDir: "/repo", entries: [listedRemoteEntry] },
    { projectDir: "/repo", entries: [listedRemoteEntry] },
  ]);
});
