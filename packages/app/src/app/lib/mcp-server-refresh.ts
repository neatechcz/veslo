import { readEffectiveMcpServerEntries } from "../mcp";
import type { McpServerEntry, McpStatusMap } from "../types";
import type { VesloServerCapabilities, VesloServerClient } from "./veslo-server";
import { recordPerfLog } from "./perf-log";

type WorkspaceType = "local" | "remote" | string;

export type McpServersRefresherOptions = {
  projectDir: () => string;
  workspaceType: () => WorkspaceType;
  activeWorkspaceId: () => string;
  isTauriRuntime: () => boolean;
  developerMode: () => boolean;
  vesloServerStatus: () => string;
  vesloServerClient: () => VesloServerClient | null | undefined;
  vesloServerWorkspaceId: () => string | null | undefined;
  vesloCapabilities: () => VesloServerCapabilities | null | undefined;
  setMcpStatus: (status: string | null) => void;
  setMcpServers: (servers: McpServerEntry[]) => void;
  setMcpStatuses: (statuses: McpStatusMap) => void;
  setMcpLastUpdatedAt: (updatedAt: number | null) => void;
  scheduleRuntimeStatusRefresh: (projectDir: string, entries: McpServerEntry[]) => void;
};

export function createMcpServersRefresher(options: McpServersRefresherOptions) {
  const refreshInFlightByKey = new Map<string, Promise<void>>();

  const applyEmptyState = (status: string) => {
    options.setMcpStatus(status);
    options.setMcpServers([]);
    options.setMcpStatuses({});
  };

  const applyEntries = (projectDir: string, entries: McpServerEntry[]) => {
    options.setMcpServers(entries);
    options.setMcpLastUpdatedAt(Date.now());
    options.scheduleRuntimeStatusRefresh(projectDir, entries);

    if (!entries.length) {
      options.setMcpStatus("No MCP servers configured yet.");
    }
  };

  const readFromVesloServer = async (client: VesloServerClient, workspaceId: string): Promise<McpServerEntry[]> => {
    const response = await client.listMcp(workspaceId);
    return response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      disabledByTools: entry.disabledByTools,
    }));
  };

  return async function refreshMcpServers() {
    const projectDir = options.projectDir().trim();
    const workspaceType = options.workspaceType();
    const isRemoteWorkspace = workspaceType === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      options.vesloCapabilities()?.mcp?.read;
    const activeWorkspaceId = options.activeWorkspaceId().trim();
    const refreshKey = [
      activeWorkspaceId,
      workspaceType,
      projectDir,
      canUseVesloServer ? vesloWorkspaceId ?? "" : "",
    ].join("::");
    const existingRefresh = refreshInFlightByKey.get(refreshKey);
    if (existingRefresh) {
      await existingRefresh;
      recordPerfLog(options.developerMode(), "workspace.mcp", "refresh-joined", {
        activeWorkspaceId,
        projectDir,
      });
      return;
    }

    const run = (async () => {
      if (isRemoteWorkspace) {
        if (!canUseVesloServer) {
          applyEmptyState("Veslo server unavailable. MCP config is read-only.");
          return;
        }

        try {
          options.setMcpStatus(null);
          applyEntries(projectDir, await readFromVesloServer(vesloClient, vesloWorkspaceId));
        } catch (e) {
          applyEmptyState(e instanceof Error ? e.message : "Failed to load MCP servers");
        }
        return;
      }

      if (isLocalWorkspace && canUseVesloServer) {
        try {
          options.setMcpStatus(null);
          applyEntries(projectDir, await readFromVesloServer(vesloClient, vesloWorkspaceId));
        } catch (e) {
          applyEmptyState(e instanceof Error ? e.message : "Failed to load MCP servers");
        }
        return;
      }

      if (!options.isTauriRuntime()) {
        applyEmptyState("MCP configuration is only available for local workspaces.");
        return;
      }

      if (!projectDir) {
        applyEmptyState("Pick a workspace folder to load MCP servers.");
        return;
      }

      try {
        options.setMcpStatus(null);
        applyEntries(projectDir, await readEffectiveMcpServerEntries(projectDir));
      } catch (e) {
        applyEmptyState(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
    })();
    refreshInFlightByKey.set(refreshKey, run);
    try {
      await run;
    } finally {
      if (refreshInFlightByKey.get(refreshKey) === run) {
        refreshInFlightByKey.delete(refreshKey);
      }
    }
  };
}
