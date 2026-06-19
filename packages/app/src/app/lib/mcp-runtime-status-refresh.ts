import type { McpServerEntry, McpStatusMap } from "../types";

export type McpRuntimeStatusClient = {
  mcp: {
    status: (input: { directory: string }) => Promise<unknown>;
  };
};

export type McpRuntimeStatusRefreshEvent = (
  event: string,
  payload: Record<string, unknown>,
) => void;

export type McpRuntimeStatusRefresherOptions<
  Client extends McpRuntimeStatusClient = McpRuntimeStatusClient,
> = {
  activeWorkspaceId: () => string;
  activeRuntimeActivityId: () => string | null | undefined;
  activeWorkspaceRuntimeReady: () => boolean;
  workspaceProjectDir: () => string;
  client: () => Client | null | undefined;
  currentEntries: () => McpServerEntry[];
  loadStatus: (client: Client, directory: string) => Promise<McpStatusMap>;
  setStatuses: (statuses: McpStatusMap) => void;
  recordEvent?: McpRuntimeStatusRefreshEvent;
};

export function mcpRuntimeStatusEntriesKey(entries: McpServerEntry[]) {
  return entries.map((entry) => entry.name).join("\0");
}

export function filterConfiguredMcpStatuses(
  status: McpStatusMap,
  entries: McpServerEntry[],
) {
  const configured = new Set(entries.map((entry) => entry.name));
  return Object.fromEntries(
    Object.entries(status).filter(([name]) => configured.has(name)),
  ) as McpStatusMap;
}

export function createMcpRuntimeStatusRefresher<
  Client extends McpRuntimeStatusClient = McpRuntimeStatusClient,
>(options: McpRuntimeStatusRefresherOptions<Client>) {
  const inFlightByKey = new Map<string, Promise<void>>();

  const isCurrentTarget = (
    workspaceId: string,
    directory: string,
    entriesKey: string,
  ) =>
    options.activeWorkspaceId().trim() === workspaceId &&
    options.workspaceProjectDir().trim() === directory &&
    mcpRuntimeStatusEntriesKey(options.currentEntries()) === entriesKey;

  const schedule = (projectDir: string, entries: McpServerEntry[]) => {
    const directory = projectDir.trim();
    const workspaceId = options.activeWorkspaceId().trim();
    const activeClient = options.client();
    const activeRuntimeActivityId = options.activeRuntimeActivityId()?.trim();
    if (activeRuntimeActivityId) {
      options.recordEvent?.("runtime-status-skip-active-send", {
        activeWorkspaceId: workspaceId,
        activeSendTraceId: activeRuntimeActivityId,
        projectDir: directory,
      });
      return;
    }

    if (!entries.length || !directory || !options.activeWorkspaceRuntimeReady() || !activeClient) {
      options.setStatuses({});
      return;
    }

    const entriesKey = mcpRuntimeStatusEntriesKey(entries);
    const key = [workspaceId, directory, entriesKey].join("::");
    if (inFlightByKey.has(key)) return;

    const task = (async () => {
      try {
        const activeRuntimeActivityIdAtStart = options.activeRuntimeActivityId()?.trim();
        if (activeRuntimeActivityIdAtStart) {
          options.recordEvent?.("runtime-status-skip-active-send", {
            activeWorkspaceId: workspaceId,
            activeSendTraceId: activeRuntimeActivityIdAtStart,
            projectDir: directory,
            phase: "task-start",
          });
          return;
        }
        const status = await options.loadStatus(activeClient, directory);
        const activeRuntimeActivityIdAfterStatus = options.activeRuntimeActivityId()?.trim();
        if (activeRuntimeActivityIdAfterStatus) {
          options.recordEvent?.("runtime-status-result-skip-active-send", {
            activeWorkspaceId: workspaceId,
            activeSendTraceId: activeRuntimeActivityIdAfterStatus,
            projectDir: directory,
          });
          return;
        }
        if (!isCurrentTarget(workspaceId, directory, entriesKey)) return;
        options.setStatuses(filterConfiguredMcpStatuses(status, entries));
      } catch {
        if (isCurrentTarget(workspaceId, directory, entriesKey)) {
          options.setStatuses({});
        }
      } finally {
        inFlightByKey.delete(key);
      }
    })();
    inFlightByKey.set(key, task);
  };

  return {
    schedule,
  };
}
