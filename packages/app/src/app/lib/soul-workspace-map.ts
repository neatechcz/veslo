import {
  parseVesloWorkspaceIdFromUrl,
  type VesloSoulAnyMaterializationResult,
  type VesloSoulMaterializationResult,
  type VesloWorkspaceInfo,
} from "./veslo-server";

export type SoulWorkspaceMapWorkspace = {
  id: string;
  workspaceType?: string | null;
  remoteType?: string | null;
  path?: string | null;
  directory?: string | null;
  vesloWorkspaceId?: string | null;
  vesloHostUrl?: string | null;
  baseUrl?: string | null;
};

export type SoulWorkspaceIdMap = Record<string, string>;

export type SoulActiveWorkspaceGuard = {
  activeWorkspaceIds: string[];
  activeRun: boolean;
  unresolvedAppWorkspaceIds: string[];
};

export type PendingSoulMaterializationReplay = {
  appWorkspaceId: string | null;
  serverWorkspaceId: string;
};

const normalizedText = (value: string | null | undefined): string => value?.trim() ?? "";

export function buildSoulWorkspaceIdMap(input: {
  appWorkspaces: SoulWorkspaceMapWorkspace[];
  serverWorkspaces: VesloWorkspaceInfo[];
}): SoulWorkspaceIdMap {
  const map: SoulWorkspaceIdMap = {};
  const listedServerWorkspaceIds = new Set(input.serverWorkspaces.map((item) => item.id));

  for (const workspace of input.appWorkspaces) {
    if (workspace.workspaceType === "local") {
      const explicitId = workspace.vesloWorkspaceId?.trim() ?? "";
      if (explicitId && listedServerWorkspaceIds.has(explicitId)) {
        map[workspace.id] = explicitId;
      }
      continue;
    }

    if (workspace.remoteType !== "veslo") {
      continue;
    }

    const explicitId =
      workspace.vesloWorkspaceId?.trim() ||
      parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
      parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "");
    if (explicitId && listedServerWorkspaceIds.has(explicitId)) {
      map[workspace.id] = explicitId;
    }
  }

  return map;
}

export function resolveSoulServerWorkspaceId(
  workspace: SoulWorkspaceMapWorkspace | undefined,
  soulWorkspaceMap: SoulWorkspaceIdMap,
): string | null {
  if (!workspace) return null;
  const appWorkspaceId = normalizedText(workspace.id);
  return (
    normalizedText(appWorkspaceId ? soulWorkspaceMap[appWorkspaceId] : undefined) ||
    normalizedText(workspace.vesloWorkspaceId) ||
    normalizedText(workspace.remoteType === "veslo" ? parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") : null) ||
    normalizedText(workspace.remoteType === "veslo" ? parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") : null) ||
    null
  );
}

export function buildSoulAppWorkspaceIdByServerWorkspaceId(
  appWorkspaces: SoulWorkspaceMapWorkspace[],
  soulWorkspaceMap: SoulWorkspaceIdMap,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const workspace of appWorkspaces) {
    const appWorkspaceId = normalizedText(workspace.id);
    if (!appWorkspaceId) continue;
    const serverWorkspaceId = resolveSoulServerWorkspaceId(workspace, soulWorkspaceMap);
    if (serverWorkspaceId) map.set(serverWorkspaceId, appWorkspaceId);
  }
  return map;
}

const workspaceCanAffectSoulMaterialization = (workspace: SoulWorkspaceMapWorkspace | undefined): boolean => {
  if (!workspace) return true;
  return !(workspace.workspaceType === "remote" && workspace.remoteType !== "veslo");
};

export function resolveSoulActiveWorkspaceGuard(input: {
  appWorkspaces: SoulWorkspaceMapWorkspace[];
  soulWorkspaceMap: SoulWorkspaceIdMap;
  busyWorkspaceIds: string[];
}): SoulActiveWorkspaceGuard {
  const workspaceByAppId = new Map(
    input.appWorkspaces
      .map((workspace) => [normalizedText(workspace.id), workspace] as const)
      .filter(([workspaceId]) => Boolean(workspaceId)),
  );
  const activeWorkspaceIds = new Set<string>();
  const unresolvedAppWorkspaceIds: string[] = [];

  for (const rawWorkspaceId of input.busyWorkspaceIds) {
    const appWorkspaceId = normalizedText(rawWorkspaceId);
    if (!appWorkspaceId) continue;
    const workspace = workspaceByAppId.get(appWorkspaceId);
    if (!workspaceCanAffectSoulMaterialization(workspace)) continue;
    const serverWorkspaceId = resolveSoulServerWorkspaceId(workspace, input.soulWorkspaceMap);
    if (serverWorkspaceId) {
      activeWorkspaceIds.add(serverWorkspaceId);
    } else {
      unresolvedAppWorkspaceIds.push(appWorkspaceId);
    }
  }

  return {
    activeWorkspaceIds: [...activeWorkspaceIds],
    activeRun: unresolvedAppWorkspaceIds.length > 0,
    unresolvedAppWorkspaceIds,
  };
}

export function canReplaySoulMaterialization(input: {
  replay: PendingSoulMaterializationReplay;
  busyWorkspaceIds: string[];
}): boolean {
  const busyWorkspaceIds = new Set(input.busyWorkspaceIds.map(normalizedText).filter(Boolean));
  const appWorkspaceId = normalizedText(input.replay.appWorkspaceId);
  return appWorkspaceId ? !busyWorkspaceIds.has(appWorkspaceId) : busyWorkspaceIds.size === 0;
}

export function soulReplayRequiresActiveRun(input: {
  replay: PendingSoulMaterializationReplay;
  busyWorkspaceIds: string[];
}): boolean {
  const busyWorkspaceIds = new Set(input.busyWorkspaceIds.map(normalizedText).filter(Boolean));
  const appWorkspaceId = normalizedText(input.replay.appWorkspaceId);
  return appWorkspaceId ? busyWorkspaceIds.has(appWorkspaceId) : busyWorkspaceIds.size > 0;
}

const materializationResultNeedsRuntimeReload = (
  result: VesloSoulMaterializationResult | null | undefined,
): boolean => result?.ok === true && result.pending !== true && result.reloadRequired === true;

export function soulMaterializationRequiresActiveRuntimeReload(input: {
  activeServerWorkspaceId: string | null | undefined;
  materialization: VesloSoulAnyMaterializationResult | null | undefined;
  sourceWorkspaceId?: string | null | undefined;
}): boolean {
  const activeServerWorkspaceId = normalizedText(input.activeServerWorkspaceId);
  if (!activeServerWorkspaceId || !input.materialization) return false;

  if ("workspaces" in input.materialization) {
    return input.materialization.workspaces.some((item) =>
      normalizedText(item.workspaceId) === activeServerWorkspaceId &&
      materializationResultNeedsRuntimeReload(item.result)
    );
  }

  if (input.sourceWorkspaceId !== undefined && normalizedText(input.sourceWorkspaceId) !== activeServerWorkspaceId) {
    return false;
  }

  return materializationResultNeedsRuntimeReload(input.materialization);
}
