import {
  createMemo,
  createSignal,
  type Accessor,
} from "solid-js";

import type {
  AutomationWorkspaceSummary,
  ScheduledJob,
  StartupPreference,
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationUpdatePayload,
  WorkspaceAutomationItem,
} from "../types";
import type { VesloServerCapabilities, VesloServerClient, VesloServerStatus } from "../lib/veslo-server";
import { createVesloServerClient as defaultCreateVesloServerClient } from "../lib/veslo-server";
import type { VesloServerInfo, WorkspaceInfo } from "../lib/tauri";
import { buildAutomationWorkspaceSummaries } from "../lib/automation-workspace-map";
import { resolveRunningVesloServerHostInfo } from "../lib/veslo-server-host";

type CheckVesloServerResult = {
  status: VesloServerStatus;
  capabilities: VesloServerCapabilities | null;
};

type CreateVesloServerClientOptions = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
};

export type ScheduledAutomationStoreDeps = {
  workspaces: Accessor<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceType: Accessor<"local" | "remote">;
  vesloServerClient: Accessor<VesloServerClient | null>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  startupPreference: Accessor<StartupPreference | null>;
  isTauriRuntime: () => boolean;
  ensureLocalVesloServerRunning: (options?: { ignoreStartupPreference?: boolean }) => Promise<boolean>;
  vesloServerInfo: () => Promise<VesloServerInfo | null>;
  setVesloServerHostInfoStable: (info: VesloServerInfo | null) => void;
  checkVesloServer: (
    baseUrl: string,
    clientToken?: string,
    hostToken?: string,
  ) => Promise<CheckVesloServerResult>;
  setVesloServerStatus: (status: VesloServerStatus) => void;
  setVesloServerCapabilitiesStable: (capabilities: VesloServerCapabilities | null) => void;
  setVesloServerCheckedAt: (checkedAt: number) => void;
  createVesloServerClient?: (options: CreateVesloServerClientOptions) => VesloServerClient;
  now?: () => number;
  reportError: (error: unknown, scope: string) => void;
};

export function createScheduledAutomationStore(deps: ScheduledAutomationStoreDeps) {
  const createClient = deps.createVesloServerClient ?? defaultCreateVesloServerClient;
  const now = deps.now ?? (() => Date.now());

  const [automationItems, setAutomationItems] = createSignal<WorkspaceAutomationItem[]>([]);
  const [automationWorkspaces, setAutomationWorkspaces] = createSignal<AutomationWorkspaceSummary[]>([]);
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);

  const automationItemKey = (workspaceId: string, automationId: string) => `${workspaceId}:${automationId}`;

  const automationWorkspaceName = (workspace: WorkspaceInfo) =>
    workspace.vesloWorkspaceName?.trim() ||
    workspace.displayName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    workspace.id;

  const activeAutomationWorkspace = createMemo(() => {
    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    if (!activeWorkspaceId) return null;
    return automationWorkspaces().find((workspace) =>
      workspace.appWorkspaceId === activeWorkspaceId &&
      workspace.status === "ready" &&
      Boolean(workspace.serverWorkspaceId)
    ) ?? null;
  });

  const scheduledJobsSource = createMemo<"local" | "remote">(() => {
    return deps.activeWorkspaceType() === "remote" ? "remote" : "local";
  });

  const scheduledJobsSourceReady = createMemo(() => {
    const client = deps.vesloServerClient();
    return deps.vesloServerStatus() === "connected" && Boolean(client);
  });

  const resolveAutomationWorkspaceMap = async (
    client = deps.vesloServerClient(),
  ): Promise<AutomationWorkspaceSummary[]> => {
    const appWorkspaces = deps.workspaces();

    if (deps.vesloServerStatus() !== "connected" || !client) {
      return appWorkspaces.map((workspace) => ({
        appWorkspaceId: workspace.id,
        serverWorkspaceId: null,
        name: automationWorkspaceName(workspace),
        path: workspace.directory ?? workspace.path ?? null,
        workspaceType: workspace.workspaceType,
        status: "unavailable",
        error: "Veslo server not ready.",
      }));
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    return buildAutomationWorkspaceSummaries({
      appWorkspaces,
      serverWorkspaces: items,
      connectedServerBaseUrl: client.baseUrl,
    });
  };

  const ensureScheduledJobsSourceReady = async () => {
    if (scheduledJobsSourceReady()) return true;
    if (scheduledJobsSource() !== "local" || !deps.isTauriRuntime() || deps.startupPreference() === "server") {
      return false;
    }
    return await deps.ensureLocalVesloServerRunning({ ignoreStartupPreference: true });
  };

  const ensureScheduledJobsClient = async (): Promise<VesloServerClient | null> => {
    const currentClient = deps.vesloServerClient();
    if (deps.vesloServerStatus() === "connected" && currentClient) {
      return currentClient;
    }

    if (scheduledJobsSource() !== "local" || !deps.isTauriRuntime() || deps.startupPreference() === "server") {
      return null;
    }

    await deps.ensureLocalVesloServerRunning({ ignoreStartupPreference: true });

    const ensuredClient = deps.vesloServerClient();
    if (deps.vesloServerStatus() === "connected" && ensuredClient) {
      return ensuredClient;
    }

    let liveInfo: VesloServerInfo | null = null;
    try {
      liveInfo = await deps.vesloServerInfo();
      deps.setVesloServerHostInfoStable(liveInfo);
    } catch {
      deps.setVesloServerHostInfoStable(null);
    }

    const runningInfo = resolveRunningVesloServerHostInfo(liveInfo);
    const baseUrl = runningInfo?.baseUrl?.trim() ?? "";
    if (!baseUrl) {
      return null;
    }

    const clientToken = runningInfo?.clientToken?.trim() || undefined;
    const hostToken = runningInfo?.hostToken?.trim() || undefined;
    const result = await deps.checkVesloServer(baseUrl, clientToken, hostToken);
    deps.setVesloServerStatus(result.status);
    deps.setVesloServerCapabilitiesStable(result.capabilities);
    deps.setVesloServerCheckedAt(now());

    if (result.status !== "connected") {
      return null;
    }

    return createClient({ baseUrl, token: clientToken, hostToken });
  };

  const refreshScheduledJobs = async (options?: { force?: boolean }) => {
    if (scheduledJobsBusy() && !options?.force) return;

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);

    const client = await ensureScheduledJobsClient().catch((error) => {
      deps.reportError(error, "scheduled.ensureSourceReady");
      return null;
    });

    const serverStatus = deps.vesloServerStatus();
    if (!client || serverStatus !== "connected") {
      setScheduledJobs([]);
      setAutomationItems([]);
      setAutomationWorkspaces([]);
      const statusMessage =
        serverStatus === "disconnected"
          ? "Veslo server unavailable. Connect to sync automations."
          : serverStatus === "limited"
            ? "Veslo server needs a token to load automations."
            : "Veslo server not ready.";
      setScheduledJobsStatus(statusMessage);
      setScheduledJobsBusy(false);
      return;
    }

    try {
      const workspaceMap = await resolveAutomationWorkspaceMap(client);
      const nextWorkspaces = [...workspaceMap];
      const readyWorkspaces = nextWorkspaces.filter((workspace) => workspace.status === "ready" && workspace.serverWorkspaceId);
      let partialFailure = false;

      const itemGroups = await Promise.all(
        readyWorkspaces.map(async (workspace) => {
          const serverWorkspaceId = workspace.serverWorkspaceId!;
          try {
            const response = await client.automations.list(serverWorkspaceId);
            const items = Array.isArray(response.items) ? response.items : [];
            const runEntries = await Promise.all(
              items.map(async (automation) => {
                try {
                  const runs = await client.automations.listRuns(serverWorkspaceId, automation.id);
                  return [automation.id, Array.isArray(runs.items) ? runs.items : []] as const;
                } catch {
                  return [automation.id, []] as const;
                }
              }),
            );
            const runsByAutomationId = Object.fromEntries(runEntries);
            return items.map((automation) => ({
              key: automationItemKey(serverWorkspaceId, automation.id),
              workspace,
              automation,
              runs: runsByAutomationId[automation.id] ?? [],
            }));
          } catch (error) {
            partialFailure = true;
            const message = error instanceof Error ? error.message : String(error);
            const index = nextWorkspaces.findIndex((item) => item.appWorkspaceId === workspace.appWorkspaceId);
            if (index >= 0) {
              nextWorkspaces[index] = { ...workspace, status: "error", error: message || "Failed to load automations." };
            }
            return [] as WorkspaceAutomationItem[];
          }
        }),
      );

      setScheduledJobs([]);
      setAutomationWorkspaces(nextWorkspaces);
      setAutomationItems(itemGroups.flat());
      setScheduledJobsUpdatedAt(now());
      setScheduledJobsStatus(partialFailure ? "Some workspaces could not load automations." : null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScheduledJobs([]);
      setAutomationItems([]);
      setAutomationWorkspaces([]);
      setScheduledJobsStatus(message || "Failed to load automations.");
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const reloadScheduledJobsSource = async () => {
    await ensureScheduledJobsSourceReady().catch((error) => {
      deps.reportError(error, "scheduled.reloadSource");
      return false;
    });
    await refreshScheduledJobs({ force: true });
  };

  const requireAutomationClient = (workspaceId: string) => {
    const client = deps.vesloServerClient();
    if (!client || deps.vesloServerStatus() !== "connected") {
      throw new Error("Veslo server unavailable. Connect to sync automations.");
    }
    if (!workspaceId) {
      throw new Error("Workspace is required to manage automations.");
    }
    return client;
  };

  const workspaceSummaryForServerId = (workspaceId: string): AutomationWorkspaceSummary => {
    return automationWorkspaces().find((workspace) => workspace.serverWorkspaceId === workspaceId) ?? {
      appWorkspaceId: workspaceId,
      serverWorkspaceId: workspaceId,
      name: workspaceId,
      path: null,
      workspaceType: "remote",
      status: "ready",
      error: null,
    };
  };

  const upsertAutomationItem = (workspaceId: string, automation: VesloAutomation) => {
    const key = automationItemKey(workspaceId, automation.id);
    setAutomationItems((current) => {
      const existing = current.find((item) => item.key === key);
      const nextItem: WorkspaceAutomationItem = {
        key,
        workspace: existing?.workspace ?? workspaceSummaryForServerId(workspaceId),
        automation,
        runs: existing?.runs ?? [],
      };
      return [nextItem, ...current.filter((item) => item.key !== key)];
    });
  };

  const createAutomation = async (workspaceId: string, payload: VesloAutomationCreatePayload) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.automations.create(workspaceId, payload);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(now());
  };

  const updateAutomation = async (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.automations.update(workspaceId, automationId, payload);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(now());
  };

  const deleteAutomation = async (workspaceId: string, automationId: string) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.automations.delete(workspaceId, automationId);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(now());
  };

  const runAutomation = async (workspaceId: string, automationId: string) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.automations.run(workspaceId, automationId);
    const key = automationItemKey(workspaceId, automationId);
    setAutomationItems((current) =>
      current.map((item) =>
        item.key === key
          ? {
              ...item,
              runs: [response.run, ...item.runs.filter((run) => run.id !== response.run.id)],
              automation: {
                ...item.automation,
                lastRunId: response.run.id,
                updatedAt: response.run.finishedAt ?? response.run.startedAt ?? item.automation.updatedAt,
              },
            }
          : item,
      ),
    );
    setScheduledJobsUpdatedAt(now());
  };

  return {
    automationItems,
    automationWorkspaces,
    activeAutomationWorkspace,
    defaultAutomationWorkspaceId: () => activeAutomationWorkspace()?.serverWorkspaceId ?? null,
    scheduledJobs,
    scheduledJobsSource,
    scheduledJobsSourceReady,
    scheduledJobsStatus,
    scheduledJobsBusy,
    scheduledJobsUpdatedAt,
    ensureScheduledJobsSourceReady,
    ensureScheduledJobsClient,
    refreshScheduledJobs,
    reloadScheduledJobsSource,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomation,
  };
}
