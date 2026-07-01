import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import { createSessionCapabilitiesStore } from "../../context/session-capabilities-store.js";
import type { WorkspaceSessionGroup } from "../../types.js";
import type { McpServerEntry, McpStatusMap, SkillInventoryItem } from "../../types.js";
import type { WorkspaceInfo } from "../../lib/tauri.js";
import type { VesloServerCapabilities, VesloServerStatus } from "../../lib/veslo-server.js";

function localWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws-local",
    name: "Local Workspace",
    path: "/workspaces/local",
    preset: "opencode",
    workspaceType: "local",
    directory: "/workspaces/local",
    displayName: "Local Workspace",
    ...overrides,
  };
}

function remoteWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws-remote-ui",
    name: "Remote Workspace",
    path: "/workspaces/remote",
    preset: "opencode",
    workspaceType: "remote",
    remoteType: "veslo",
    directory: "/workspaces/remote",
    displayName: "Remote Workspace",
    vesloHostUrl: "https://veslo.example/workspace/server-ws/opencode",
    vesloWorkspaceId: "server-ws",
    ...overrides,
  };
}

function workspaceGroup(workspace: WorkspaceInfo, sessionId = "sess-a"): WorkspaceSessionGroup {
  return {
    workspace,
    status: "ready",
    error: null,
    sessions: [{ id: sessionId, title: "Session", directory: workspace.directory ?? workspace.path }],
  };
}

function localInventory(description = "Workspace research"): SkillInventoryItem[] {
  return [
    {
      name: "global-helper",
      status: "global",
      globalInstance: {
        id: "global:global-helper",
        name: "global-helper",
        scope: "user-global",
        path: "/home/user/.config/opencode/skills/global-helper/SKILL.md",
        source: "opencode",
        enabled: true,
        readable: true,
        writable: true,
      },
      workspaceInstances: [],
    },
    {
      name: "research",
      status: "workspace-only",
      workspaceInstances: [
        {
          id: "workspace:ws-local:research",
          name: "research",
          scope: "workspace",
          workspaceId: "ws-local",
          workspaceLabel: "Local Workspace",
          path: "/workspaces/local/.opencode/skills/research/SKILL.md",
          description,
          source: "opencode",
          enabled: true,
          readable: true,
          writable: true,
        },
      ],
    },
  ];
}

function capabilities(): VesloServerCapabilities {
  return {
    skills: { read: true, write: true, source: "veslo" },
    plugins: { read: true, write: true },
    mcp: { read: true, write: true },
    commands: { read: true, write: true },
    config: { read: true, write: true },
  };
}

function createManualEffectRunner() {
  const effects: Array<() => void> = [];

  return {
    effect: (fn: () => void) => {
      effects.push(fn);
      fn();
    },
    flush: async () => {
      for (let index = 0; index < 4; index += 1) {
        await settle();
        for (const fn of effects) fn();
      }
      await settle();
    },
  };
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  const workspace = localWorkspace();
  return {
    selectedSessionId: () => "sess-a",
    selectedSession: () => null,
    sidebarWorkspaceGroups: () => [workspaceGroup(workspace)],
    resolveSessionDirectory: (session: { directory?: string | null }) => session.directory ?? "",
    workspaces: () => [workspace],
    activeWorkspaceId: () => "ws-local",
    activeWorkspaceDisplay: () => workspace,
    activeWorkspaceRoot: () => "/workspaces/local",
    workspaceProjectDir: () => "/workspaces/local",
    baseUrl: () => "http://runtime.test",
    connectedVersion: () => "1.0.0",
    client: () => null,
    activeWorkspaceRuntimeReady: () => false,
    activeVisibleRuntimeActivityId: () => null,
    developerMode: () => true,
    vesloServerClient: () => null,
    vesloServerStatus: () => "disconnected" as VesloServerStatus,
    vesloServerBaseUrl: () => "",
    vesloServerWorkspaceId: () => null,
    vesloCapabilities: () => null,
    skillInventory: () => localInventory(),
    refreshSkillInventory: async () => {},
    readEffectiveMcpServerEntries: async () => [] as McpServerEntry[],
    recordPerfLog: () => {},
    ...overrides,
  };
}

test("session capabilities store loads local skills and MCP statuses for the selected session workspace", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const entries: McpServerEntry[] = [
        { name: "browser", config: { type: "remote", url: "https://mcp.example" }, source: "config.global" },
        { name: "local-tools", config: { type: "local", command: ["node", "server.js"] }, source: "config.project" },
      ];
      const runtimeCalls: string[] = [];
      let refreshCalls = 0;
      const store = createSessionCapabilitiesStore(baseDeps({
        client: () => ({
          mcp: {
            status: async ({ directory }: { directory: string }) => {
              runtimeCalls.push(directory);
              return { data: { browser: { status: "connected" } } satisfies McpStatusMap };
            },
          },
        }),
        activeWorkspaceRuntimeReady: () => true,
        refreshSkillInventory: async () => {
          refreshCalls += 1;
        },
        readEffectiveMcpServerEntries: async (directory: string) => {
          assert.equal(directory, "/workspaces/local");
          return entries;
        },
        effect: effects.effect,
      }));

      await effects.flush();

      assert.equal(store.sessionCapabilitiesStatus(), "ready");
      assert.equal(store.sessionCapabilitiesError(), null);
      assert.deepEqual(store.sessionCapabilities()?.skills.map((row) => `${row.name}:${row.scope}`), [
        "global-helper:global",
        "research:workspace",
      ]);
      assert.deepEqual(store.sessionCapabilities()?.mcp.map((row) => `${row.name}:${row.status}`), [
        "browser:connected",
        "local-tools:disconnected",
      ]);
      assert.deepEqual(runtimeCalls, ["/workspaces/local"]);
      assert.equal(refreshCalls, 1);
      assert.deepEqual(store.skillInventoryWorkspaces(), [
        { id: "ws-local", label: "Local Workspace", path: "/workspaces/local" },
      ]);
    } finally {
      dispose();
    }
  });
});

test("session capabilities store loads remote Veslo workspace skills and MCP entries", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const workspace = remoteWorkspace();
      const calls: string[] = [];
      const store = createSessionCapabilitiesStore(baseDeps({
        sidebarWorkspaceGroups: () => [workspaceGroup(workspace)],
        workspaces: () => [workspace],
        activeWorkspaceId: () => "ws-remote-ui",
        activeWorkspaceDisplay: () => workspace,
        activeWorkspaceRoot: () => "/workspaces/remote",
        workspaceProjectDir: () => "/workspaces/remote",
        vesloServerStatus: () => "connected",
        vesloServerBaseUrl: () => "https://veslo.example",
        vesloServerWorkspaceId: () => "server-ws",
        vesloCapabilities: () => capabilities(),
        vesloServerClient: () => ({
          listSkills: async (workspaceId: string, options?: { includeGlobal?: boolean }) => {
            calls.push(`skills:${workspaceId}:${String(options?.includeGlobal)}`);
            return {
              items: [
                {
                  name: "global-remote",
                  path: "/global/SKILL.md",
                  description: "Global remote",
                  scope: "global",
                },
                {
                  name: "workspace-remote",
                  path: "/workspace/SKILL.md",
                  description: "Workspace remote",
                  scope: "project",
                },
              ],
            };
          },
          mcp: {
            list: async (workspaceId: string) => {
              calls.push(`mcp:${workspaceId}`);
              return {
                items: [
                  {
                    name: "remote-mcp",
                    config: { type: "remote", url: "https://remote.mcp" },
                    source: "config.remote",
                  },
                ],
              };
            },
          },
        }),
        effect: effects.effect,
      }));

      await effects.flush();

      assert.equal(store.sessionCapabilitiesStatus(), "ready");
      assert.deepEqual(calls, ["skills:server-ws:true", "mcp:server-ws"]);
      assert.deepEqual(store.sessionCapabilities()?.skills.map((row) => `${row.name}:${row.scope}`), [
        "global-remote:global",
        "workspace-remote:workspace",
      ]);
      assert.deepEqual(store.sessionCapabilities()?.mcp.map((row) => `${row.name}:${row.type}`), [
        "remote-mcp:remote",
      ]);
      assert.deepEqual(store.skillInventoryWorkspaces(), []);
    } finally {
      dispose();
    }
  });
});

test("session capabilities store skips runtime MCP status while an active send owns the runtime", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const perfEvents: string[] = [];
      let runtimeCalls = 0;
      const store = createSessionCapabilitiesStore(baseDeps({
        client: () => ({
          mcp: {
            status: async () => {
              runtimeCalls += 1;
              return { data: {} };
            },
          },
        }),
        activeWorkspaceRuntimeReady: () => true,
        activeVisibleRuntimeActivityId: () => "send-trace-1",
        readEffectiveMcpServerEntries: async () => [
          { name: "browser", config: { type: "remote", url: "https://mcp.example" }, source: "config.global" },
        ],
        recordPerfLog: (_enabled: boolean, scope: string, event: string) => {
          perfEvents.push(`${scope}:${event}`);
        },
        effect: effects.effect,
      }));

      await effects.flush();

      assert.equal(store.sessionCapabilitiesStatus(), "ready");
      assert.equal(runtimeCalls, 0);
      assert.deepEqual(store.sessionCapabilities()?.mcp.map((row) => `${row.name}:${row.status}`), [
        "browser:disconnected",
      ]);
      assert.deepEqual(perfEvents, ["workspace.mcp:session-capabilities-skip-active-send"]);
    } finally {
      dispose();
    }
  });
});

test("session capabilities store force reloads when inventory or remote context changes", async () => {
  await createRoot(async (dispose) => {
    try {
      const effects = createManualEffectRunner();
      const [inventory, setInventory] = createSignal(localInventory("first"));
      const [serverStatus, setServerStatus] = createSignal<VesloServerStatus>("connected");
      let mcpReads = 0;
      const store = createSessionCapabilitiesStore(baseDeps({
        skillInventory: inventory,
        vesloServerStatus: serverStatus,
        readEffectiveMcpServerEntries: async () => {
          mcpReads += 1;
          return [];
        },
        effect: effects.effect,
      }));

      await effects.flush();
      assert.equal(mcpReads, 1);
      assert.equal(store.sessionCapabilities()?.skills.find((row) => row.name === "research")?.description, "first");

      await effects.flush();
      assert.equal(mcpReads, 1, "unchanged context should use the selected directory cache");

      const nextInventory = localInventory("second");
      nextInventory[1] = {
        ...nextInventory[1]!,
        workspaceInstances: [
          {
            ...nextInventory[1]!.workspaceInstances[0]!,
            id: "workspace:ws-local:research-v2",
            path: "/workspaces/local/.opencode/skills/research-v2/SKILL.md",
          },
        ],
      };
      setInventory(nextInventory);
      await effects.flush();
      assert.equal(mcpReads, 2);
      assert.equal(store.sessionCapabilities()?.skills.find((row) => row.name === "research")?.description, "second");

      setServerStatus("limited");
      await effects.flush();
      assert.equal(mcpReads, 3);
    } finally {
      dispose();
    }
  });
});
