import type { Accessor } from "solid-js";

import type { WorkspaceBusyMap } from "./workspace-debug";
import type { RoutingClient, WorkspaceRouting } from "./workspace-routing";

export type RuntimeOwnerReason =
  | "orchestrator-ready"
  | "routed-client"
  | "active-legacy-engine-ready"
  | "not-ready";

export type RuntimeOwnerDecision = {
  owner: {
    type: "workspace-runtime";
    workspaceId: string;
  } | null;
  workspaceId: string;
  ready: boolean;
  reason: RuntimeOwnerReason;
  activeWorkspace: boolean;
  orchestratorReady: boolean;
  routedClientReady: boolean;
  activeLegacyEngineReady: boolean;
  busy: boolean;
};

export type RuntimeOwnerOptions = {
  activeWorkspaceId: Accessor<string>;
  activeLegacyEngineReady: Accessor<boolean>;
  readyEngineWorkspaceIds: Accessor<ReadonlySet<string>>;
  requiresOrchestratorReadiness?: (workspaceId: string) => boolean;
  workspaceBusy?: Accessor<WorkspaceBusyMap>;
  routing: Pick<WorkspaceRouting, "client" | "entry" | "entryIds">;
};

export type RuntimeOwner = {
  client: (workspaceId?: string) => RoutingClient | null;
  resolveWorkspace: (workspaceId?: string | null) => RuntimeOwnerDecision;
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  activeWorkspaceRuntimeReady: () => boolean;
  anyWorkspaceRuntimeReady: () => boolean;
  shouldSyncConversationReadForWorkspace: (workspaceId: string) => boolean;
};

export function createRuntimeOwnedRouting(
  routing: WorkspaceRouting,
  owner: Pick<RuntimeOwner, "client">,
): WorkspaceRouting {
  return {
    client: (workspaceId?: string) => owner.client(workspaceId),
    active: () => owner.client(),
    activeWorkspaceId: () => routing.activeWorkspaceId(),
    entry: (workspaceId: string) => routing.entry(workspaceId),
    ensure: (workspaceId, baseUrl, options) =>
      routing.ensure(workspaceId, baseUrl, options),
    lastEnsureError: (workspaceId: string) => routing.lastEnsureError(workspaceId),
    release: (workspaceId: string) => routing.release(workspaceId),
    forEach: (cb) => routing.forEach(cb),
    entryIds: () => routing.entryIds(),
  };
}

const normalizeId = (value?: string | null) => value?.trim() ?? "";

const uniqueNonEmpty = (values: Iterable<string>) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = normalizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

export function createRuntimeOwner(options: RuntimeOwnerOptions): RuntimeOwner {
  const activeWorkspaceId = () => normalizeId(options.activeWorkspaceId());

  const resolveWorkspace = (workspaceId?: string | null): RuntimeOwnerDecision => {
    const id = normalizeId(workspaceId) || activeWorkspaceId();
    if (!id) {
      return {
        owner: null,
        workspaceId: "",
        ready: false,
        reason: "not-ready",
        activeWorkspace: false,
        orchestratorReady: false,
        routedClientReady: false,
        activeLegacyEngineReady: false,
        busy: false,
      };
    }

    const activeWorkspace = id === activeWorkspaceId();
    const orchestratorReady = options.readyEngineWorkspaceIds().has(id);
    const routedClientReady = Boolean(options.routing.entry(id));
    const routedClientCountsAsReady =
      routedClientReady && !options.requiresOrchestratorReadiness?.(id);
    const activeLegacyEngineReady = activeWorkspace && options.activeLegacyEngineReady();
    const busy = Object.keys(options.workspaceBusy?.()[id] ?? {}).length > 0;
    const ready = orchestratorReady || routedClientCountsAsReady || activeLegacyEngineReady;
    const reason: RuntimeOwnerReason = orchestratorReady
      ? "orchestrator-ready"
      : routedClientCountsAsReady
        ? "routed-client"
        : activeLegacyEngineReady
          ? "active-legacy-engine-ready"
          : "not-ready";

    return {
      owner: ready ? { type: "workspace-runtime", workspaceId: id } : null,
      workspaceId: id,
      ready,
      reason,
      activeWorkspace,
      orchestratorReady,
      routedClientReady,
      activeLegacyEngineReady,
      busy,
    };
  };

  const isWorkspaceRuntimeReady = (workspaceId?: string | null) =>
    resolveWorkspace(workspaceId).ready;

  const activeWorkspaceRuntimeReady = () =>
    isWorkspaceRuntimeReady(activeWorkspaceId());

  const anyWorkspaceRuntimeReady = () => {
    const candidates = uniqueNonEmpty([
      activeWorkspaceId(),
      ...Array.from(options.readyEngineWorkspaceIds()),
      ...options.routing.entryIds(),
    ]);
    return candidates.some((workspaceId) => isWorkspaceRuntimeReady(workspaceId));
  };

  const shouldSyncConversationReadForWorkspace = (workspaceId: string) => {
    const decision = resolveWorkspace(workspaceId);
    return decision.ready || decision.busy;
  };

  const client = (workspaceId?: string) => {
    const id = normalizeId(workspaceId);
    if (id && !isWorkspaceRuntimeReady(id)) return null;
    if (!id && activeWorkspaceId() && !activeWorkspaceRuntimeReady()) return null;
    return options.routing.client(workspaceId);
  };

  return {
    client,
    resolveWorkspace,
    isWorkspaceRuntimeReady,
    activeWorkspaceRuntimeReady,
    anyWorkspaceRuntimeReady,
    shouldSyncConversationReadForWorkspace,
  };
}
