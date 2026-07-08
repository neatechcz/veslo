import { readEffectiveMcpServerEntries } from "../mcp";
import type { McpServerEntry, McpStatusMap } from "../types";
import type { VesloServerCapabilities, VesloServerClient } from "./veslo-server";
import { recordPerfLog } from "./perf-log";

type WorkspaceType = "local" | "remote" | string;
type McpRefreshMode = "auto" | "explicit";

export type McpServersRefreshOptions = {
  mode?: McpRefreshMode;
  reason?: string | null;
  probeRuntimeStatus?: boolean;
};

type McpRefreshInFlight = {
  mode: McpRefreshMode;
  promise: Promise<void>;
};

export type McpServersRefresherOptions = {
  projectDir: () => string;
  workspaceType: () => WorkspaceType;
  activeWorkspaceId: () => string;
  activeRuntimeActivityId?: () => string | null;
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
  const refreshInFlightByKey = new Map<string, McpRefreshInFlight>();

  const applyEmptyState = (status: string) => {
    options.setMcpStatus(status);
    options.setMcpServers([]);
    options.setMcpStatuses({});
  };

  const applyEntries = (projectDir: string, entries: McpServerEntry[], probeRuntimeStatus: boolean) => {
    options.setMcpServers(entries);
    options.setMcpLastUpdatedAt(Date.now());
    if (probeRuntimeStatus) {
      options.scheduleRuntimeStatusRefresh(projectDir, entries);
    } else if (entries.length) {
      recordPerfLog(options.developerMode(), "workspace.mcp", "runtime-status-skip-auto-refresh", {
        activeWorkspaceId: options.activeWorkspaceId().trim(),
        projectDir,
        entries: entries.map((entry) => entry.name),
      });
    }

    if (!entries.length) {
      options.setMcpStatus("No MCP servers configured yet.");
    }
  };

  const readFromVesloServer = async (client: VesloServerClient, workspaceId: string): Promise<McpServerEntry[]> => {
    const response = await client.mcp.list(workspaceId);
    return response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      owner: entry.owner,
      disabledByTools: entry.disabledByTools,
    }));
  };

  return async function refreshMcpServers(refreshOptions: McpServersRefreshOptions = {}) {
    const refreshMode = refreshOptions.mode ?? "auto";
    const refreshReason = refreshOptions.reason?.trim() || refreshMode;
    const probeRuntimeStatus = refreshOptions.probeRuntimeStatus ?? refreshMode === "explicit";
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
    const currentActiveRuntimeActivityId = () => options.activeRuntimeActivityId?.()?.trim() ?? "";
    const skipForActiveRuntimeActivity = (phase: string) => {
      if (refreshMode === "explicit") return false;
      const activeRuntimeActivityId = currentActiveRuntimeActivityId();
      if (!activeRuntimeActivityId) return false;
      recordPerfLog(options.developerMode(), "workspace.mcp", "refresh-skip-active-send", {
        activeWorkspaceId,
        activeSendTraceId: activeRuntimeActivityId,
        phase,
        projectDir,
        mode: refreshMode,
        reason: refreshReason,
      });
      return true;
    };
    if (skipForActiveRuntimeActivity("start")) {
      return;
    }
    const refreshKey = [
      activeWorkspaceId,
      workspaceType,
      projectDir,
      canUseVesloServer ? vesloWorkspaceId ?? "" : "",
    ].join("::");
    const isCurrentRefreshTarget = () =>
      options.activeWorkspaceId().trim() === activeWorkspaceId &&
      options.projectDir().trim() === projectDir;
    const skipStaleRefreshResult = (phase: string) => {
      recordPerfLog(options.developerMode(), "workspace.mcp", "refresh-stale-skip", {
        phase,
        activeWorkspaceId,
        projectDir,
        currentActiveWorkspaceId: options.activeWorkspaceId().trim(),
        currentProjectDir: options.projectDir().trim(),
      });
    };
    const applyEmptyStateForRun = (status: string, phase: string) => {
      if (skipForActiveRuntimeActivity(phase)) {
        return;
      }
      if (!isCurrentRefreshTarget()) {
        skipStaleRefreshResult(phase);
        return;
      }
      applyEmptyState(status);
    };
    const applyEntriesForRun = (entries: McpServerEntry[], phase: string) => {
      if (skipForActiveRuntimeActivity(phase)) {
        return;
      }
      if (!isCurrentRefreshTarget()) {
        skipStaleRefreshResult(phase);
        return;
      }
      options.setMcpStatus(null);
      applyEntries(projectDir, entries, probeRuntimeStatus);
    };
    const existingRefresh = refreshInFlightByKey.get(refreshKey);
    if (existingRefresh) {
      await existingRefresh.promise;
      recordPerfLog(options.developerMode(), "workspace.mcp", "refresh-joined", {
        activeWorkspaceId,
        projectDir,
        mode: refreshMode,
        reason: refreshReason,
        joinedMode: existingRefresh.mode,
      });
      if (refreshMode !== "explicit" || existingRefresh.mode === "explicit") {
        return;
      }
    }

    const run = (async () => {
      if (isRemoteWorkspace) {
        if (!canUseVesloServer) {
          applyEmptyStateForRun("Veslo server unavailable. MCP config is read-only.", "remote-unavailable");
          return;
        }

        try {
          applyEntriesForRun(await readFromVesloServer(vesloClient, vesloWorkspaceId), "remote-read");
        } catch (e) {
          applyEmptyStateForRun(e instanceof Error ? e.message : "Failed to load MCP servers", "remote-error");
        }
        return;
      }

      if (isLocalWorkspace && canUseVesloServer) {
        try {
          applyEntriesForRun(await readFromVesloServer(vesloClient, vesloWorkspaceId), "local-veslo-read");
        } catch (e) {
          applyEmptyStateForRun(e instanceof Error ? e.message : "Failed to load MCP servers", "local-veslo-error");
        }
        return;
      }

      if (!options.isTauriRuntime()) {
        applyEmptyStateForRun("MCP configuration is only available for local workspaces.", "non-tauri");
        return;
      }

      if (!projectDir) {
        applyEmptyStateForRun("Pick a workspace folder to load MCP servers.", "missing-project-dir");
        return;
      }

      try {
        applyEntriesForRun(await readEffectiveMcpServerEntries(projectDir), "local-read");
      } catch (e) {
        applyEmptyStateForRun(e instanceof Error ? e.message : "Failed to load MCP servers", "local-error");
      }
    })();
    refreshInFlightByKey.set(refreshKey, { mode: refreshMode, promise: run });
    try {
      await run;
    } finally {
      if (refreshInFlightByKey.get(refreshKey)?.promise === run) {
        refreshInFlightByKey.delete(refreshKey);
      }
    }
  };
}
