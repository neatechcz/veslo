import { createEffect, createSignal, type Accessor } from "solid-js";

import { readEffectiveMcpServerEntries as defaultReadEffectiveMcpServerEntries } from "../mcp";
import type { WorkspaceInfo } from "../lib/tauri";
import { buildSkillInventory, type BuildSkillInventoryInput } from "../lib/skill-inventory";
import {
  buildSessionMcpRows,
  buildSessionSkillRows,
  createSessionCapabilitiesCache,
  filterSessionSkillInventoryByScope,
  normalizeSessionCapabilityDirectory,
  resolveSessionCapabilitySessionSource,
  type SessionCapabilitiesScope,
  type SessionCapabilitiesSnapshot,
  type SessionCapabilitySessionLike,
} from "../lib/session-capabilities";
import { unwrap } from "../lib/opencode";
import {
  normalizeVesloServerUrl,
  parseVesloWorkspaceIdFromUrl,
  type VesloServerCapabilities,
  type VesloServerStatus,
} from "../lib/veslo-server";
import type { McpServerEntry, McpStatusMap, ResourceOwner, SkillInventoryItem, WorkspaceSessionGroup } from "../types";
import {
  normalizeDirectoryPath,
  safeStringify,
  sessionDirectoryMatchesRoot,
} from "../utils";

export type SessionCapabilitiesLoadStatus = "idle" | "loading" | "ready" | "error";

export type SessionCapabilitiesRuntimeClient = {
  mcp: {
    status: (input: { directory: string }) => Promise<unknown>;
  };
};

export type SessionCapabilitiesVesloClient = {
  listSkills: (
    workspaceId: string,
    options?: { includeGlobal?: boolean },
  ) => Promise<{
    items?: Array<{
      name: string;
      path: string;
      description?: string;
      trigger?: string;
      scope?: string;
    }>;
  }>;
  mcp: {
    list: (workspaceId: string) => Promise<{
      items?: Array<{
        name: string;
        config: unknown;
        source?: string;
        owner?: ResourceOwner;
        disabledByTools?: boolean;
      }>;
    }>;
  };
};

export type SessionCapabilitiesWorkspaceDisplay = {
  path?: string | null;
  directory?: string | null;
  workspaceType?: string | null;
};

export type SessionCapabilityInventoryWorkspace = {
  id: string;
  label: string;
  path: string;
};

export type SessionCapabilitiesStoreDeps = {
  selectedSessionId: Accessor<string | null | undefined>;
  selectedSession: Accessor<SessionCapabilitySessionLike | null | undefined>;
  sidebarWorkspaceGroups: Accessor<WorkspaceSessionGroup[]>;
  resolveSessionDirectory: (session: SessionCapabilitySessionLike) => string;
  workspaces: Accessor<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceDisplay: Accessor<SessionCapabilitiesWorkspaceDisplay>;
  activeWorkspaceRoot: Accessor<string>;
  workspaceProjectDir: Accessor<string>;
  baseUrl: Accessor<string>;
  connectedVersion: Accessor<string | null | undefined>;
  client: Accessor<SessionCapabilitiesRuntimeClient | null | undefined>;
  activeWorkspaceRuntimeReady: Accessor<boolean>;
  activeVisibleRuntimeActivityId: Accessor<string | null | undefined>;
  mcpRefreshFingerprint?: Accessor<string | number | null | undefined>;
  developerMode: Accessor<boolean>;
  vesloServerClient: Accessor<SessionCapabilitiesVesloClient | null | undefined>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  vesloServerBaseUrl: Accessor<string>;
  vesloServerWorkspaceId: Accessor<string | null | undefined>;
  vesloCapabilities: Accessor<VesloServerCapabilities | null | undefined>;
  skillInventory: Accessor<SkillInventoryItem[]>;
  readEffectiveMcpServerEntries?: (directory: string) => Promise<McpServerEntry[]>;
  recordPerfLog?: (
    enabled: boolean,
    scope: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  effect?: (fn: () => void) => void;
};

export type SessionCapabilitiesStore = {
  sessionCapabilities: Accessor<SessionCapabilitiesSnapshot | null>;
  sessionCapabilitiesStatus: Accessor<SessionCapabilitiesLoadStatus>;
  sessionCapabilitiesError: Accessor<string | null>;
  skillInventoryWorkspaces: Accessor<SessionCapabilityInventoryWorkspace[]>;
};

const normalizeCapabilityDirectoryForMatch = (value?: string | null) =>
  normalizeSessionCapabilityDirectory(normalizeDirectoryPath(value ?? ""));

const workspaceLabelForSessionCapabilities = (workspace: WorkspaceInfo | null | undefined, fallback: string) =>
  workspace?.displayName?.trim() ||
  workspace?.name?.trim() ||
  workspace?.vesloWorkspaceName?.trim() ||
  workspace?.id ||
  fallback;

const filterSessionMcpStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
  const configured = new Set(entries.map((entry) => entry.name));
  return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
};

const failedSessionMcpStatuses = (entries: McpServerEntry[], error: unknown): McpStatusMap => {
  const message = error instanceof Error ? error.message : safeStringify(error);
  return Object.fromEntries(
    entries.map((entry) => [entry.name, { status: "failed", error: message }]),
  ) as McpStatusMap;
};

export function createSessionCapabilitiesStore(deps: SessionCapabilitiesStoreDeps): SessionCapabilitiesStore {
  const effect = deps.effect ?? ((fn: () => void) => createEffect(fn));
  const readEffectiveMcpServerEntries = deps.readEffectiveMcpServerEntries ?? defaultReadEffectiveMcpServerEntries;
  const recordPerfLog = deps.recordPerfLog ?? (() => {});
  const [sessionCapabilitiesSnapshot, setSessionCapabilitiesSnapshot] =
    createSignal<SessionCapabilitiesSnapshot | null>(null);
  const [sessionCapabilitiesStatus, setSessionCapabilitiesStatus] =
    createSignal<SessionCapabilitiesLoadStatus>("idle");
  const [sessionCapabilitiesError, setSessionCapabilitiesError] = createSignal<string | null>(null);

  const findWorkspaceForSessionCapabilityDirectory = (directory: string): WorkspaceInfo | null => {
    const normalizedDirectory = normalizeCapabilityDirectoryForMatch(directory);
    if (!normalizedDirectory) return null;

    return (
      deps
        .workspaces()
        .find((workspace) =>
          [workspace.path, workspace.directory]
            .filter((candidate): candidate is string => Boolean(candidate?.trim()))
            .some((candidate) =>
              normalizeCapabilityDirectoryForMatch(candidate) === normalizedDirectory ||
              sessionDirectoryMatchesRoot(directory, candidate),
            ),
        ) ?? null
    );
  };

  const selectedSessionCapabilitySource = () =>
    resolveSessionCapabilitySessionSource({
      selectedSessionId: deps.selectedSessionId(),
      selectedSession: deps.selectedSession(),
      workspaceGroups: deps.sidebarWorkspaceGroups(),
      resolveDirectory: (session) => deps.resolveSessionDirectory(session),
    });

  const selectedSessionCapabilityDirectory = () => {
    const session = selectedSessionCapabilitySource()?.session;
    return session
      ? normalizeSessionCapabilityDirectory(deps.resolveSessionDirectory(session))
      : "";
  };

  const selectedSessionCapabilityWorkspace = () =>
    selectedSessionCapabilitySource()?.workspace ??
    findWorkspaceForSessionCapabilityDirectory(selectedSessionCapabilityDirectory());

  const selectedSessionCapabilitiesScope = (): SessionCapabilitiesScope | null => {
    const session = selectedSessionCapabilitySource()?.session;
    if (!session) return null;

    const directory = selectedSessionCapabilityDirectory();
    const workspace = selectedSessionCapabilityWorkspace();
    return {
      directory,
      workspaceId: workspace?.id,
      workspaceLabel: workspaceLabelForSessionCapabilities(workspace, directory),
      workspaceType: workspace?.workspaceType,
    };
  };

  const skillInventoryWorkspaces = () => {
    const directory = selectedSessionCapabilityDirectory();
    if (!directory) return [];
    const workspace = selectedSessionCapabilityWorkspace();
    if (workspace?.workspaceType === "remote") return [];
    return [{
      id: workspace?.id || `session:${directory}`,
      label: workspaceLabelForSessionCapabilities(workspace, directory),
      path: directory,
    }];
  };

  const localSessionSkillRows = (scope: SessionCapabilitiesScope) => {
    const inventory = filterSessionSkillInventoryByScope(deps.skillInventory(), {
      directory: scope.directory,
      workspaceId: scope.workspaceId,
    });
    return buildSessionSkillRows(inventory);
  };

  const matchingRuntimeClientForSessionCapabilities = (directory: string, workspace: WorkspaceInfo | null) => {
    const runtimeClient = deps.client();
    if (!runtimeClient) return null;

    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    if (workspace?.id && activeWorkspaceId && workspace.id !== activeWorkspaceId) return null;

    if (workspace?.id && workspace.id === activeWorkspaceId) return runtimeClient;

    const active = deps.activeWorkspaceDisplay();
    const normalizedDirectory = normalizeCapabilityDirectoryForMatch(directory);
    const activeCandidates = [
      active.path,
      active.directory,
      deps.activeWorkspaceRoot(),
      deps.workspaceProjectDir(),
    ].map((candidate) => normalizeCapabilityDirectoryForMatch(candidate));
    return activeCandidates.includes(normalizedDirectory) ? runtimeClient : null;
  };

  const runtimeMatchContextForSessionCapabilities = () => {
    const active = deps.activeWorkspaceDisplay();
    return {
      activeWorkspaceId: deps.activeWorkspaceId().trim(),
      activeWorkspacePath: normalizeCapabilityDirectoryForMatch(active.path),
      activeWorkspaceDirectory: normalizeCapabilityDirectoryForMatch(active.directory),
      activeWorkspaceRoot: normalizeCapabilityDirectoryForMatch(deps.activeWorkspaceRoot()),
      workspaceProjectDir: normalizeCapabilityDirectoryForMatch(deps.workspaceProjectDir()),
    };
  };

  const loadSessionMcpStatuses = async (
    directory: string,
    entries: McpServerEntry[],
    workspace: WorkspaceInfo | null,
  ): Promise<McpStatusMap> => {
    if (!entries.length) return {};
    if (!deps.activeWorkspaceRuntimeReady()) return {};
    const runtimeClient = matchingRuntimeClientForSessionCapabilities(directory, workspace);
    if (!runtimeClient) return {};
    const activeRuntimeActivityId = deps.activeVisibleRuntimeActivityId()?.trim();
    if (activeRuntimeActivityId) {
      recordPerfLog(deps.developerMode(), "workspace.mcp", "session-capabilities-skip-active-send", {
        activeWorkspaceId: deps.activeWorkspaceId().trim(),
        activeSendTraceId: activeRuntimeActivityId,
        directory,
        workspaceId: workspace?.id ?? null,
      });
      return {};
    }

    try {
      const status = unwrap(await runtimeClient.mcp.status({ directory }) as never);
      const nextActiveRuntimeActivityId = deps.activeVisibleRuntimeActivityId()?.trim();
      if (nextActiveRuntimeActivityId) {
        recordPerfLog(deps.developerMode(), "workspace.mcp", "session-capabilities-result-skip-active-send", {
          activeWorkspaceId: deps.activeWorkspaceId().trim(),
          activeSendTraceId: nextActiveRuntimeActivityId,
          directory,
          workspaceId: workspace?.id ?? null,
        });
        return {};
      }
      return filterSessionMcpStatuses(status as McpStatusMap, entries);
    } catch (error) {
      recordPerfLog(deps.developerMode(), "workspace.mcp", "session-capabilities-status-error", {
        activeWorkspaceId: deps.activeWorkspaceId().trim(),
        directory,
        workspaceId: workspace?.id ?? null,
        entries: entries.map((entry) => entry.name),
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      return failedSessionMcpStatuses(entries, error);
    }
  };

  const remoteWorkspaceContextForSessionCapabilities = (workspace: WorkspaceInfo | null) => {
    if (!workspace || workspace.workspaceType !== "remote" || workspace.remoteType !== "veslo") return null;
    const vesloClient = deps.vesloServerClient();
    if (deps.vesloServerStatus() !== "connected" || !vesloClient) return null;

    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    const selectedHost = normalizeVesloServerUrl(workspace.vesloHostUrl ?? "") ?? "";
    const connectedHost = normalizeVesloServerUrl(deps.vesloServerBaseUrl()) ?? "";
    if (selectedHost && connectedHost && selectedHost !== connectedHost && workspace.id !== activeWorkspaceId) {
      return null;
    }

    const inferredWorkspaceId =
      workspace.vesloWorkspaceId?.trim() ||
      parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
      parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
      (workspace.id === activeWorkspaceId ? deps.vesloServerWorkspaceId()?.trim() ?? "" : "");
    if (!inferredWorkspaceId) return null;

    return { vesloClient, workspaceId: inferredWorkspaceId };
  };

  const loadLocalSessionCapabilities = async (
    scope: SessionCapabilitiesScope,
    workspace: WorkspaceInfo | null,
  ): Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">> => {
    const directory = scope.directory;
    const mcpEntries = await readEffectiveMcpServerEntries(directory);
    const statuses = await loadSessionMcpStatuses(directory, mcpEntries, workspace);
    return {
      directory,
      skills: localSessionSkillRows(scope),
      mcp: buildSessionMcpRows(mcpEntries, statuses),
    };
  };

  const loadRemoteSessionCapabilities = async (
    scope: SessionCapabilitiesScope,
    workspace: WorkspaceInfo,
  ): Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">> => {
    const directory = scope.directory;
    const remoteContext = remoteWorkspaceContextForSessionCapabilities(workspace);
    if (!remoteContext) {
      return { directory, skills: [], mcp: [] };
    }

    const [skillsResponse, mcpResponse] = await Promise.all([
      remoteContext.vesloClient.listSkills(remoteContext.workspaceId, { includeGlobal: true }),
      remoteContext.vesloClient.mcp.list(remoteContext.workspaceId),
    ]);
    const skillItems = Array.isArray(skillsResponse.items) ? skillsResponse.items : [];
    const workspaceId = scope.workspaceId || workspace.id || directory;
    const workspaceLabel = scope.workspaceLabel || workspaceLabelForSessionCapabilities(workspace, directory);
    const workspaceSkillsByWorkspaceId: BuildSkillInventoryInput["workspaceSkillsByWorkspaceId"] = {
      [workspaceId]: {
        workspace: {
          id: workspaceId,
          label: workspaceLabel,
          path: directory,
          kind: "remote",
        },
        skills: skillItems
          .filter((entry) => entry.scope !== "global")
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            description: entry.description,
            trigger: entry.trigger,
          })),
      },
    };
    const inventory = buildSkillInventory({
      globalSkills: skillItems
        .filter((entry) => entry.scope === "global")
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          description: entry.description,
          trigger: entry.trigger,
        })),
      workspaceSkillsByWorkspaceId,
      hubSkills: [],
    });
    const mcpEntries: McpServerEntry[] = (Array.isArray(mcpResponse.items) ? mcpResponse.items : []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source as McpServerEntry["source"],
      owner: entry.owner,
      disabledByTools: entry.disabledByTools,
    }));
    const statuses = await loadSessionMcpStatuses(directory, mcpEntries, workspace);
    return {
      directory,
      skills: buildSessionSkillRows(inventory),
      mcp: buildSessionMcpRows(mcpEntries, statuses),
    };
  };

  const sessionCapabilitiesCache = createSessionCapabilitiesCache(async (scope) => {
    const workspace = findWorkspaceForSessionCapabilityDirectory(scope.directory);
    if (workspace?.workspaceType === "remote") {
      return loadRemoteSessionCapabilities(scope, workspace);
    }
    return loadLocalSessionCapabilities(scope, workspace);
  });
  const sessionCapabilitiesLoadContextByDirectory = new Map<string, string>();
  const sessionCapabilitiesDeferredRefreshByDirectory = new Set<string>();
  let sessionCapabilitiesRequestVersion = 0;

  const sessionCapabilities = (): SessionCapabilitiesSnapshot | null => {
    const snapshot = sessionCapabilitiesSnapshot();
    if (!snapshot) return null;
    const scope = selectedSessionCapabilitiesScope();
    if (!scope || normalizeSessionCapabilityDirectory(scope.directory) !== snapshot.directory) return snapshot;
    if (scope.workspaceType === "remote") return snapshot;
    return {
      ...snapshot,
      skills: localSessionSkillRows(scope),
    };
  };

  const sessionCapabilitiesLoadContext = (
    scope: SessionCapabilitiesScope,
    workspace: WorkspaceInfo | null,
    serverCapabilities: VesloServerCapabilities | null | undefined,
  ) => {
    const common = {
      directory: scope.directory,
      workspaceId: scope.workspaceId ?? "",
      workspaceType: scope.workspaceType ?? "",
      runtimeBaseUrl: deps.baseUrl().trim(),
      runtimeVersion: deps.connectedVersion() ?? "",
      hasRuntimeClient: Boolean(deps.client()),
      mcpRefreshFingerprint: deps.mcpRefreshFingerprint?.() ?? "",
      runtimeMatch: runtimeMatchContextForSessionCapabilities(),
      matchedWorkspaceId: workspace?.id ?? "",
    };

    if (scope.workspaceType !== "remote") return JSON.stringify(common);

    return JSON.stringify({
      ...common,
      remoteStatus: deps.vesloServerStatus(),
      remoteBaseUrl: deps.vesloServerBaseUrl(),
      remoteWorkspaceId: deps.vesloServerWorkspaceId() ?? "",
      hasRemoteClient: Boolean(deps.vesloServerClient()),
      remoteSkillsRead: Boolean(serverCapabilities?.skills?.read),
      remoteMcpRead: Boolean(serverCapabilities?.mcp?.read),
    });
  };

  effect(() => {
    const scope = selectedSessionCapabilitiesScope();
    const workspace = selectedSessionCapabilityWorkspace();
    const serverCapabilities = scope?.workspaceType === "remote" ? deps.vesloCapabilities() : null;
    const activeRuntimeActivityId = deps.activeVisibleRuntimeActivityId()?.trim() ?? "";
    const loadContext = scope ? sessionCapabilitiesLoadContext(scope, workspace, serverCapabilities) : "";

    const requestVersion = ++sessionCapabilitiesRequestVersion;
    if (!scope) {
      setSessionCapabilitiesSnapshot(null);
      setSessionCapabilitiesStatus("idle");
      setSessionCapabilitiesError(null);
      return;
    }

    if (activeRuntimeActivityId) {
      sessionCapabilitiesDeferredRefreshByDirectory.add(scope.directory);
      const cached = sessionCapabilitiesCache.peek(scope);
      if (cached) {
        setSessionCapabilitiesSnapshot(cached);
        setSessionCapabilitiesStatus("ready");
        setSessionCapabilitiesError(null);
      } else if (sessionCapabilitiesSnapshot()?.directory === scope.directory) {
        setSessionCapabilitiesStatus("ready");
        setSessionCapabilitiesError(null);
      } else {
        setSessionCapabilitiesStatus("idle");
        setSessionCapabilitiesError(null);
      }
      return;
    }

    const currentSnapshot = sessionCapabilitiesSnapshot();
    const hasCurrentScopeSnapshot =
      currentSnapshot?.directory === scope.directory;
    // Keep already-rendered capabilities visible during a refresh. Replacing
    // them with the generic loading state makes ordinary session updates look
    // like a right-sidebar remount.
    setSessionCapabilitiesStatus(hasCurrentScopeSnapshot ? "ready" : "loading");
    setSessionCapabilitiesError(null);

    const previousContext = scope.directory ? sessionCapabilitiesLoadContextByDirectory.get(scope.directory) : undefined;
    const force =
      sessionCapabilitiesDeferredRefreshByDirectory.delete(scope.directory) ||
      (previousContext !== undefined && previousContext !== loadContext);
    void sessionCapabilitiesCache
      .load(scope, { force })
      .then((snapshot) => {
        if (requestVersion !== sessionCapabilitiesRequestVersion) return;
        sessionCapabilitiesLoadContextByDirectory.set(snapshot.directory, loadContext);
        setSessionCapabilitiesSnapshot(snapshot);
        setSessionCapabilitiesStatus("ready");
        setSessionCapabilitiesError(null);
      })
      .catch((error) => {
        if (requestVersion !== sessionCapabilitiesRequestVersion) return;
        setSessionCapabilitiesSnapshot(null);
        setSessionCapabilitiesStatus("error");
        setSessionCapabilitiesError(error instanceof Error ? error.message : safeStringify(error));
      });
  });

  return {
    sessionCapabilities,
    sessionCapabilitiesStatus,
    sessionCapabilitiesError,
    skillInventoryWorkspaces,
  };
}
