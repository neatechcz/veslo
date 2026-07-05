import { createEffect, createSignal, type Accessor } from "solid-js";

import {
  type VesloServerClient,
  type VesloServerStatus,
  type VesloSoulAuthContext,
  type VesloSoulOverviewResponse,
} from "../lib/veslo-server";
import { buildSoulWorkspaceIdMap, type SoulWorkspaceIdMap } from "../lib/soul-workspace-map";

export type SoulDataStoreWorkspace = {
  id: string;
  workspaceType?: string | null;
  remoteType?: string | null;
  path?: string | null;
  directory?: string | null;
  vesloWorkspaceId?: string | null;
  vesloHostUrl?: string | null;
  baseUrl?: string | null;
};

export type SoulDataStoreDeps = {
  vesloServerClient: Accessor<VesloServerClient | null>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  workspaces: Accessor<SoulDataStoreWorkspace[]>;
  activeWorkspaceId: Accessor<string>;
  soulAuthContext: Accessor<VesloSoulAuthContext>;
  authRevision?: Accessor<unknown>;
  reportError?: (error: unknown, scope: string) => void;
  effect?: (callback: () => void) => void;
};

export function createSoulDataStore(deps: SoulDataStoreDeps) {
  const effect = deps.effect ?? createEffect;
  const [soulOverview, setSoulOverview] = createSignal<VesloSoulOverviewResponse | null>(null);
  const [soulOverviewError, setSoulOverviewError] = createSignal<string | null>(null);
  const [soulOverviewBusy, setSoulOverviewBusy] = createSignal(false);
  const [soulWorkspaceMap, setSoulWorkspaceMap] = createSignal<SoulWorkspaceIdMap>({});
  const [soulError, setSoulError] = createSignal<string | null>(null);
  let soulOverviewRefreshSeq = 0;
  let lastSoulRefreshKey = "";

  const resolveSoulWorkspaceMap = async () => {
    const client = deps.vesloServerClient();
    if (!client || deps.vesloServerStatus() !== "connected") {
      return {} as SoulWorkspaceIdMap;
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    return buildSoulWorkspaceIdMap({ appWorkspaces: deps.workspaces(), serverWorkspaces: items });
  };

  const refreshSoulOverview = async (client: VesloServerClient) => {
    const requestSeq = ++soulOverviewRefreshSeq;
    setSoulOverviewBusy(true);
    const isCurrentRequest = () =>
      requestSeq === soulOverviewRefreshSeq &&
      deps.vesloServerClient() === client &&
      deps.vesloServerStatus() === "connected";
    try {
      const overview = await client.getSoulOverview(deps.soulAuthContext());
      if (!isCurrentRequest()) {
        return;
      }
      setSoulOverview(overview);
      setSoulOverviewError(null);
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to load Soul overview.";
      setSoulOverview(null);
      setSoulOverviewError(message);
    } finally {
      if (isCurrentRequest()) {
        setSoulOverviewBusy(false);
      }
    }
  };

  const refreshSoulData = async (options?: { force?: boolean }) => {
    const client = deps.vesloServerClient();
    if (!client || deps.vesloServerStatus() !== "connected") {
      soulOverviewRefreshSeq += 1;
      setSoulOverview(null);
      setSoulOverviewError(null);
      setSoulOverviewBusy(false);
      setSoulWorkspaceMap({});
      setSoulError(null);
      return;
    }

    void refreshSoulOverview(client);
    void options;
    setSoulError(null);
    try {
      const workspaceMap = await resolveSoulWorkspaceMap();
      setSoulWorkspaceMap(workspaceMap);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to map Soul workspaces.";
      setSoulWorkspaceMap({});
      setSoulError(message);
    }
  };

  effect(() => {
    const status = deps.vesloServerStatus();
    const hasClient = Boolean(deps.vesloServerClient());
    const activeWorkspaceId = deps.activeWorkspaceId();
    const authRevision = deps.authRevision?.();
    const workspacesKey = deps
      .workspaces()
      .map((workspace) => {
        const root = workspace.workspaceType === "local"
          ? workspace.path?.trim() ?? ""
          : workspace.directory?.trim() ?? workspace.path?.trim() ?? "";
        return [
          workspace.id,
          workspace.workspaceType,
          workspace.remoteType ?? "",
          root,
          workspace.vesloWorkspaceId ?? "",
          workspace.vesloHostUrl ?? "",
          workspace.baseUrl ?? "",
        ].join("|");
      })
      .join(";");
    const key = [status, hasClient ? "1" : "0", activeWorkspaceId, workspacesKey, authRevision].join("::");
    if (key === lastSoulRefreshKey) return;
    lastSoulRefreshKey = key;
    void refreshSoulData().catch(e => deps.reportError?.(e, "soul.refresh"));
  });

  return {
    soulOverview,
    soulOverviewError,
    soulOverviewBusy,
    soulClient: deps.vesloServerClient,
    soulServerConnected: () => deps.vesloServerStatus() === "connected",
    soulAuthContext: deps.soulAuthContext,
    soulWorkspaceMap,
    soulError,
    refreshSoulData,
  };
}
