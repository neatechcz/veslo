import type { McpServerEntry, McpStatusMap, SkillInstance, SkillInventoryItem } from "../types";

export type SessionCapabilityScope = "workspace" | "global";

export type SessionSkillCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  description?: string;
  trigger?: string;
  path: string;
  enabled: boolean;
  disabledReason?: SkillInstance["disabledReason"];
};

export type SessionMcpCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  type: "remote" | "local";
  detail?: string;
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "disconnected";
  statusDetail?: string;
};

export type SessionCapabilitiesSnapshot = {
  directory: string;
  skills: SessionSkillCapabilityRow[];
  mcp: SessionMcpCapabilityRow[];
  loadedAt?: number;
};

export type SessionCapabilitiesScope = {
  directory: string;
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceType?: "local" | "remote";
};

export type SessionCapabilitySessionLike = {
  id: string;
  directory?: string | null;
};

export type SessionCapabilityWorkspaceGroupLike<TWorkspace = unknown> = {
  workspace: TWorkspace;
  sessions: SessionCapabilitySessionLike[];
};

export function normalizeSessionCapabilityDirectory(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function resolveSessionCapabilitySessionSource<TWorkspace>(input: {
  selectedSessionId?: string | null;
  selectedSession?: SessionCapabilitySessionLike | null;
  workspaceGroups: SessionCapabilityWorkspaceGroupLike<TWorkspace>[];
  resolveDirectory?: (session: SessionCapabilitySessionLike) => string;
}): { session: SessionCapabilitySessionLike; workspace?: TWorkspace } | null {
  const selectedSessionId = input.selectedSessionId?.trim() ?? "";
  const directoryFor = (session: SessionCapabilitySessionLike) =>
    normalizeSessionCapabilityDirectory(input.resolveDirectory?.(session) ?? session.directory ?? "");

  if (input.selectedSession && (!selectedSessionId || input.selectedSession.id === selectedSessionId)) {
    if (directoryFor(input.selectedSession)) return { session: input.selectedSession };
  }

  if (selectedSessionId) {
    for (const group of input.workspaceGroups) {
      const session = group.sessions.find((item) => item.id === selectedSessionId);
      if (session && directoryFor(session)) {
        return { session, workspace: group.workspace };
      }
    }

    const syntheticSession = { id: selectedSessionId, directory: "" };
    const syntheticDirectory = directoryFor(syntheticSession);
    if (syntheticDirectory) {
      return { session: { ...syntheticSession, directory: syntheticDirectory } };
    }
  }

  return input.selectedSession ? { session: input.selectedSession } : null;
}

function skillPathMatchesDirectory(path: string | null | undefined, directory: string) {
  if (!directory) return false;
  const normalizedPath = normalizeSessionCapabilityDirectory(path);
  return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
}

export function filterSessionSkillInventoryByScope(
  items: SkillInventoryItem[],
  scope: Pick<SessionCapabilitiesScope, "directory" | "workspaceId">,
): SkillInventoryItem[] {
  const workspaceId = scope.workspaceId?.trim() ?? "";
  const directory = normalizeSessionCapabilityDirectory(scope.directory);

  return items.flatMap((item) => {
    const workspaceInstances = item.workspaceInstances.filter((instance) => {
      if (workspaceId && instance.workspaceId === workspaceId) return true;
      return skillPathMatchesDirectory(instance.path, directory);
    });
    if (workspaceInstances.length > 0) return [{ ...item, workspaceInstances }];
    if (item.globalInstance) return [{ ...item, workspaceInstances: [] }];
    return [];
  });
}

export function createSessionCapabilitiesCache(
  loadFresh: (scope: SessionCapabilitiesScope) => Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">>,
) {
  const cache = new Map<string, SessionCapabilitiesSnapshot>();
  const generations = new Map<string, number>();
  let nextGeneration = 0;

  return {
    clear() {
      cache.clear();
      generations.clear();
      nextGeneration += 1;
    },
    peek(scope: SessionCapabilitiesScope) {
      const directory = normalizeSessionCapabilityDirectory(scope.directory);
      return directory ? cache.get(directory) ?? null : null;
    },
    async load(scope: SessionCapabilitiesScope, options?: { force?: boolean }) {
      const directory = normalizeSessionCapabilityDirectory(scope.directory);
      if (!directory) {
        throw new Error("Workspace directory for this chat is not loaded yet.");
      }
      if (!options?.force) {
        const cached = cache.get(directory);
        if (cached) return cached;
      }

      const generation = nextGeneration + 1;
      nextGeneration = generation;
      generations.set(directory, generation);
      const fresh = await loadFresh({ ...scope, directory });
      const snapshot = { ...fresh, directory, loadedAt: Date.now() };
      if (generations.get(directory) === generation) {
        cache.set(directory, snapshot);
      }
      return snapshot;
    },
  };
}

function rowFromSkillInstance(instance: SkillInstance): SessionSkillCapabilityRow {
  return {
    id: instance.id,
    name: instance.name,
    scope: instance.scope === "workspace" ? "workspace" : "global",
    description: instance.description,
    trigger: instance.trigger,
    path: instance.path,
    enabled: instance.enabled !== false,
    disabledReason: instance.disabledReason,
  };
}

export function buildSessionSkillRows(items: SkillInventoryItem[]): SessionSkillCapabilityRow[] {
  // Input inventory must already be scoped to the selected chat workspace.
  return items.flatMap((item) => {
    if (item.workspaceInstances.length > 0) return item.workspaceInstances.map(rowFromSkillInstance);
    if (item.globalInstance) return [rowFromSkillInstance(item.globalInstance)];
    return [];
  });
}

function statusDetailFor(status: McpStatusMap[string] | undefined) {
  if (status?.status === "failed" || status?.status === "needs_client_registration") return status.error;
  return undefined;
}

export function buildSessionMcpRows(entries: McpServerEntry[], statuses: McpStatusMap): SessionMcpCapabilityRow[] {
  return entries.map((entry) => {
    const runtimeStatus = statuses[entry.name];
    return {
      id: entry.name,
      name: entry.name,
      scope: entry.source === "config.global" ? "global" : "workspace",
      type: entry.config.type,
      detail: entry.config.type === "remote" ? entry.config.url : entry.config.command?.join(" "),
      status:
        entry.config.enabled === false || entry.disabledByTools
          ? "disabled"
          : runtimeStatus?.status ?? "disconnected",
      statusDetail: statusDetailFor(runtimeStatus),
    };
  });
}
