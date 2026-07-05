import assert from "node:assert/strict";
import test from "node:test";

import type { McpDirectoryInfo } from "../../constants.js";
import type { McpServerEntry, McpStatusMap } from "../../types.js";
import { createMcpConnectionWorkflow } from "../../context/mcp-connection-workflow.js";

type Call = {
  name: string;
  args: unknown[];
};

const remoteEntry = (overrides: Partial<McpDirectoryInfo> = {}): McpDirectoryInfo => ({
  id: "github",
  name: "GitHub",
  description: "GitHub MCP",
  type: "remote",
  url: "https://mcp.example/github",
  oauth: true,
  ...overrides,
});

function createHarness(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let mcpStatus: string | null = "previous";
  let mcpConnectingName: string | null = null;
  let mcpStatuses: McpStatusMap = {};
  let authModalOpen = false;
  let authEntry: McpDirectoryInfo | null = null;
  let authNeedsReload = false;
  let selectedMcp: string | null = "github";
  let projectDir = "/repo";
  let workspaceType = "local";
  let tauriRuntime = true;
  let vesloStatus = "disconnected";
  let vesloWorkspaceId: string | null = "ws_1";
  let vesloCapabilities = { mcp: { read: true, write: false } };
  let readConfigContent = "";
  let mcpServers: McpServerEntry[] = [
    {
      name: "github",
      source: "config.project",
      config: { type: "remote", url: "https://mcp.example/github", oauth: {} },
    },
  ];
  const hubEntries: McpDirectoryInfo[] = [];
  const runtimeClient = {
    path: {
      get: async () => ({ directory: projectDir }),
    },
    mcp: {
      add: async (...args: unknown[]) => {
        calls.push({ name: "runtime.mcp.add", args });
        return { github: { status: "connected" } };
      },
      status: async (...args: unknown[]) => {
        calls.push({ name: "runtime.mcp.status", args });
        return { github: { status: "connected" } };
      },
      disconnect: async (...args: unknown[]) => {
        calls.push({ name: "runtime.mcp.disconnect", args });
        return {};
      },
      auth: {
        remove: async (...args: unknown[]) => {
          calls.push({ name: "runtime.mcp.auth.remove", args });
          return {};
        },
      },
    },
  };
  const vesloClient = {
    listWorkspaces: async () => ({ items: [{ id: "ws_1" }] }),
    mcp: {
      add: async (...args: unknown[]) => {
        calls.push({ name: "veslo.mcp.add", args });
        return {};
      },
      remove: async (...args: unknown[]) => {
        calls.push({ name: "veslo.mcp.remove", args });
        return {};
      },
      logoutAuth: async (...args: unknown[]) => {
        calls.push({ name: "veslo.mcp.logoutAuth", args });
        return {};
      },
      refreshRuntimeToken: async (...args: unknown[]) => {
        calls.push({ name: "veslo.mcp.refreshRuntimeToken", args });
        return {};
      },
    },
  };

  const deps = {
    workspaceType: () => workspaceType,
    workspaceProjectDir: () => projectDir,
    setWorkspaceProjectDir: (value: string) => {
      projectDir = value;
    },
    isTauriRuntime: () => tauriRuntime,
    routedClient: () => runtimeClient,
    createClient: (...args: unknown[]) => {
      calls.push({ name: "createClient", args });
      return runtimeClient;
    },
    setClient: (...args: unknown[]) => {
      calls.push({ name: "setClient", args });
    },
    vesloServerStatus: () => vesloStatus,
    vesloServerClient: () => vesloClient,
    vesloServerWorkspaceId: () => vesloWorkspaceId,
    setVesloServerWorkspaceId: (value: string | null) => {
      vesloWorkspaceId = value;
    },
    vesloCapabilities: () => vesloCapabilities,
    vesloServerBaseUrl: () => "https://worker.example",
    vesloServerAuth: () => ({ token: "worker-token" }),
    mcpServers: () => mcpServers,
    selectedMcp: () => selectedMcp,
    setSelectedMcp: (value: string | null) => {
      selectedMcp = value;
    },
    setMcpStatus: (value: string | null) => {
      calls.push({ name: "setMcpStatus", args: [value] });
      mcpStatus = value;
    },
    setMcpConnectingName: (value: string | null) => {
      mcpConnectingName = value;
    },
    setMcpStatuses: (value: McpStatusMap) => {
      mcpStatuses = value;
    },
    setMcpAuthEntry: (value: McpDirectoryInfo | null) => {
      authEntry = value;
    },
    setMcpAuthNeedsReload: (value: boolean) => {
      authNeedsReload = value;
    },
    setMcpAuthModalOpen: (value: boolean) => {
      authModalOpen = value;
    },
    localizedMcpQuickConnect: () => [remoteEntry()],
    hubMcpCards: () => hubEntries,
    refreshMcpServers: async (...args: unknown[]) => {
      calls.push({ name: "refreshMcpServers", args });
    },
    installHubMcp: async (...args: unknown[]) => {
      calls.push({ name: "installHubMcp", args });
      return { ok: true, message: "installed", entry: hubEntries[0] };
    },
    readOpencodeConfig: async (...args: unknown[]) => {
      calls.push({ name: "readOpencodeConfig", args });
      return { exists: Boolean(readConfigContent.trim()), content: readConfigContent };
    },
    writeOpencodeConfig: async (...args: unknown[]) => {
      calls.push({ name: "writeOpencodeConfig", args });
      readConfigContent = String(args[2]);
      return { ok: true, stdout: "", stderr: "" };
    },
    removeMcpFromConfig: async (...args: unknown[]) => {
      calls.push({ name: "removeMcpFromConfig", args });
    },
    canRemoveMcpFromProjectConfig: (entry: McpServerEntry | undefined) => Boolean(entry && entry.source !== "config.global"),
    quickConnectEntryKey: (entry: Pick<McpDirectoryInfo, "id" | "name">) => entry.id ?? entry.name.toLowerCase(),
    validateMcpServerName: (name: string) => name.trim(),
    readDenAuth: () => ({
      denApiBase: "https://den.example",
      token: "den-token",
      orgId: "org_1",
    }),
    fetch: async (...args: unknown[]) => {
      calls.push({ name: "fetch", args });
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ authorizeUrl: "https://auth.example/start" }),
      };
    },
    openDesktopAuthUrl: async (...args: unknown[]) => {
      calls.push({ name: "openDesktopAuthUrl", args });
    },
    unwrap: (value: unknown) => value,
    currentLocale: () => "en",
    translate: (key: string) => key,
    normalizeDirectoryQueryPath: (value: string) => value,
    recordPerfLog: (...args: unknown[]) => {
      calls.push({ name: "recordPerfLog", args });
    },
    finishPerf: (...args: unknown[]) => {
      calls.push({ name: "finishPerf", args });
    },
    developerMode: () => false,
    perfNow: () => 100,
    safeStringify: String,
    ...overrides,
  };

  const workflow = createMcpConnectionWorkflow(deps as never);
  return {
    workflow,
    calls,
    hubEntries,
    set readConfigContent(value: string) {
      readConfigContent = value;
    },
    set workspaceType(value: string) {
      workspaceType = value;
    },
    set tauriRuntime(value: boolean) {
      tauriRuntime = value;
    },
    set vesloStatus(value: string) {
      vesloStatus = value;
    },
    set vesloCapabilitiesValue(value: { mcp: { read: boolean; write: boolean } }) {
      vesloCapabilities = value;
    },
    set vesloWorkspaceId(value: string | null) {
      vesloWorkspaceId = value;
    },
    set mcpServersValue(value: McpServerEntry[]) {
      mcpServers = value;
    },
    get mcpStatus() {
      return mcpStatus;
    },
    get mcpConnectingName() {
      return mcpConnectingName;
    },
    get mcpStatuses() {
      return mcpStatuses;
    },
    get authModalOpen() {
      return authModalOpen;
    },
    get authEntry() {
      return authEntry;
    },
    get authNeedsReload() {
      return authNeedsReload;
    },
    get selectedMcp() {
      return selectedMcp;
    },
    get writtenConfig() {
      return readConfigContent;
    },
  };
}

test("MCP connection workflow writes local project config before activating runtime MCP", async () => {
  const harness = createHarness();
  harness.readConfigContent = '{ "$schema": "https://opencode.ai/config.json", "mcp": { "old": { "type": "remote", "url": "https://old.example" } } }';

  await harness.workflow.connectMcp(remoteEntry());

  const written = JSON.parse(harness.writtenConfig);
  assert.deepEqual(written.mcp.github, {
    type: "remote",
    enabled: true,
    url: "https://mcp.example/github",
    oauth: {},
  });
  assert.equal(harness.calls.some((call) => call.name === "runtime.mcp.add"), true);
  assert.equal(harness.authModalOpen, true);
  assert.equal(harness.authNeedsReload, true);
  assert.equal(harness.mcpConnectingName, null);
});

test("MCP connection workflow uses the Veslo server MCP facade before runtime activation when writable", async () => {
  const harness = createHarness();
  harness.vesloStatus = "connected";
  harness.vesloCapabilitiesValue = { mcp: { read: true, write: true } };

  await harness.workflow.connectMcp(remoteEntry({ oauth: false }));

  const addCall = harness.calls.find((call) => call.name === "veslo.mcp.add");
  assert.deepEqual(addCall?.args, [
    "ws_1",
    {
      name: "github",
      config: {
        type: "remote",
        enabled: true,
        url: "https://mcp.example/github",
      },
    },
  ]);
  assert.equal(harness.calls.some((call) => call.name === "readOpencodeConfig"), false);
  assert.equal(harness.calls.some((call) => call.name === "runtime.mcp.add"), true);
  assert.equal(harness.mcpStatus, "mcp.connected");
});

test("hub MCP install starts Veslo-managed OAuth in the browser without local runtime activation", async () => {
  const harness = createHarness();
  harness.hubEntries.push(remoteEntry({
    id: "linear",
    name: "Linear",
    authorization: {
      type: "veslo-server-oauth",
      provider: "linear",
      connectorId: "linear",
      scopes: ["read"],
      startPath: "/v1/connectors/linear/oauth/start",
      runtimeTokenPath: "/v1/connectors/linear/runtime-token",
      statusPath: "/v1/connectors/linear/status",
      disconnectPath: "/v1/connectors/linear/disconnect",
    },
  }));

  const result = await harness.workflow.installHubMcpAndActivate("linear");

  assert.deepEqual(result, { ok: true, message: "installed", entry: harness.hubEntries[0] });
  assert.equal(harness.calls.some((call) => call.name === "runtime.mcp.add"), false);
  assert.deepEqual(harness.calls.filter((call) => call.name === "refreshMcpServers").map((call) => call.args[0]), [
    { mode: "explicit", reason: "hub-mcp-server-oauth-installed" },
    { mode: "explicit", reason: "hub-mcp-server-oauth-started" },
  ]);
  assert.deepEqual(harness.calls.find((call) => call.name === "fetch")?.args[0], "https://den.example/v1/connectors/linear/oauth/start");
  assert.deepEqual(harness.calls.find((call) => call.name === "openDesktopAuthUrl")?.args, ["https://auth.example/start"]);
  assert.equal(harness.mcpStatus, "mcp.auth.follow_browser_steps");
});

test("installed hub MCP row can start Veslo-managed OAuth from catalog metadata", async () => {
  const harness = createHarness();
  harness.hubEntries.push(remoteEntry({
    id: "microsoft-sharepoint",
    name: "Microsoft SharePoint",
    oauth: false,
    authorization: {
      type: "veslo-server-oauth",
      provider: "microsoft",
      connectorId: "microsoft-sharepoint",
      scopes: ["Sites.Read.All", "Files.Read.All"],
      startPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start",
      runtimeTokenPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/runtime-token",
      statusPath: "/v1/orgs/org_1/integrations/microsoft/connections",
      disconnectPath: "/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/connection",
    },
  }));
  const installedEntry: McpServerEntry = {
    name: "microsoft-sharepoint",
    source: "config.project",
    config: {
      type: "remote",
      url: "https://api.veslo.work/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/mcp",
      oauth: false,
      headers: {
        "X-Veslo-Connector": "microsoft-sharepoint",
        "X-Veslo-Connector-Token": "runtime-token",
      },
    },
  };
  harness.mcpServersValue = [installedEntry];

  await harness.workflow.authorizeMcp(installedEntry);

  assert.deepEqual(
    harness.calls.find((call) => call.name === "fetch")?.args[0],
    "https://den.example/v1/orgs/org_1/integrations/microsoft/microsoft-sharepoint/oauth/start",
  );
  assert.deepEqual(harness.calls.find((call) => call.name === "openDesktopAuthUrl")?.args, ["https://auth.example/start"]);
  assert.equal(harness.authModalOpen, false);
  assert.equal(harness.mcpStatus, "mcp.auth.follow_browser_steps");
  assert.equal(
    harness.calls.findIndex((call) => call.name === "setMcpStatus" && call.args[0] === "mcp.auth.follow_browser_steps") <
      harness.calls.findIndex((call) => call.name === "openDesktopAuthUrl"),
    true,
  );
});

test("removing an MCP refreshes the list and clears the selected server", async () => {
  const harness = createHarness();

  await harness.workflow.removeMcp("github");

  assert.deepEqual(harness.calls.find((call) => call.name === "removeMcpFromConfig")?.args, ["/repo", "github"]);
  assert.equal(
    harness.calls.some((call) => call.name === "refreshMcpServers" && JSON.stringify(call.args[0]) === JSON.stringify({ mode: "explicit", reason: "mcp-remove" })),
    true,
  );
  assert.equal(harness.selectedMcp, null);
  assert.equal(harness.mcpStatus, null);
});
