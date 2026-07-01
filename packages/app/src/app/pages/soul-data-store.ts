import { createEffect, createSignal, type Accessor } from "solid-js";

import { createSessionClientMessageId as defaultCreateSessionClientMessageId } from "../lib/session-send-contract";
import {
  type VesloServerClient,
  type VesloServerStatus,
  type VesloSoulAuthContext,
  type VesloSoulHeartbeatEntry,
  type VesloSoulOverviewResponse,
  type VesloSoulStatus,
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

export type SoulPromptPayload = {
  mode: "prompt";
  text: string;
  resolvedText: string;
  parts: Array<{ type: "text"; text: string }>;
  attachments: [];
};

export type SoulPromptOptions = {
  targetSessionId: string;
  clientMessageId: string;
  origin: "app:soul-prompt";
};

export type SoulDataStoreDeps = {
  vesloServerClient: Accessor<VesloServerClient | null>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  workspaces: Accessor<SoulDataStoreWorkspace[]>;
  activeWorkspaceId: Accessor<string>;
  soulAuthContext: Accessor<VesloSoulAuthContext>;
  authRevision?: Accessor<unknown>;
  createSessionAndOpen: () => Promise<string | null | undefined> | string | null | undefined;
  sendPrompt: (payload: SoulPromptPayload, options: SoulPromptOptions) => Promise<unknown> | unknown;
  setPrompt: (value: string) => void;
  createClientMessageId?: () => string;
  reportError?: (error: unknown, scope: string) => void;
  effect?: (callback: () => void) => void;
};

export function createSoulDataStore(deps: SoulDataStoreDeps) {
  const effect = deps.effect ?? createEffect;
  const createClientMessageId = deps.createClientMessageId ?? defaultCreateSessionClientMessageId;
  const [soulStatusByWorkspaceId, setSoulStatusByWorkspaceId] = createSignal<
    Record<string, VesloSoulStatus | null>
  >({});
  const [soulOverview, setSoulOverview] = createSignal<VesloSoulOverviewResponse | null>(null);
  const [soulOverviewError, setSoulOverviewError] = createSignal<string | null>(null);
  const [soulOverviewBusy, setSoulOverviewBusy] = createSignal(false);
  const [soulWorkspaceMap, setSoulWorkspaceMap] = createSignal<SoulWorkspaceIdMap>({});
  const [activeSoulHeartbeats, setActiveSoulHeartbeats] = createSignal<VesloSoulHeartbeatEntry[]>([]);
  const [soulStatusBusy, setSoulStatusBusy] = createSignal(false);
  const [soulHeartbeatsBusy, setSoulHeartbeatsBusy] = createSignal(false);
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
      setSoulStatusByWorkspaceId({});
      setSoulWorkspaceMap({});
      setActiveSoulHeartbeats([]);
      setSoulHeartbeatsBusy(false);
      setSoulError(null);
      return;
    }

    void refreshSoulOverview(client);
    if (soulStatusBusy() && !options?.force) return;

    setSoulStatusBusy(true);
    setSoulError(null);
    try {
      const workspaceMap = await resolveSoulWorkspaceMap();
      setSoulWorkspaceMap(workspaceMap);
      const workspaceIds = Object.entries(workspaceMap);

      const nextStatusByWorkspace: Record<string, VesloSoulStatus | null> = {};
      for (const workspace of deps.workspaces()) {
        nextStatusByWorkspace[workspace.id] = null;
      }

      let hadStatusError = false;
      await Promise.all(
        workspaceIds.map(async ([workspaceId, vesloId]) => {
          try {
            const status = await client.getSoulStatus(vesloId);
            nextStatusByWorkspace[workspaceId] = status;
          } catch {
            hadStatusError = true;
            nextStatusByWorkspace[workspaceId] = null;
          }
        }),
      );
      setSoulStatusByWorkspaceId(nextStatusByWorkspace);

      const activeWorkspaceId = deps.activeWorkspaceId();
      const activeVesloId = workspaceMap[activeWorkspaceId];
      if (!activeVesloId) {
        setActiveSoulHeartbeats([]);
        setSoulHeartbeatsBusy(false);
        if (hadStatusError) {
          setSoulError("Soul status is partially unavailable.");
        }
        return;
      }

      setSoulHeartbeatsBusy(true);
      try {
        const response = await client.listSoulHeartbeats(activeVesloId, 30);
        setActiveSoulHeartbeats(Array.isArray(response.items) ? response.items : []);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load soul heartbeats.";
        setActiveSoulHeartbeats([]);
        setSoulError(message);
      } finally {
        setSoulHeartbeatsBusy(false);
      }

      if (hadStatusError && !soulError()) {
        setSoulError("Soul status is partially unavailable.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load soul status.";
      setSoulOverview(null);
      setSoulStatusByWorkspaceId({});
      setSoulWorkspaceMap({});
      setActiveSoulHeartbeats([]);
      setSoulHeartbeatsBusy(false);
      setSoulError(message);
    } finally {
      setSoulStatusBusy(false);
    }
  };

  const activeSoulStatus = () => {
    const id = deps.activeWorkspaceId();
    if (!id) return null;
    return soulStatusByWorkspaceId()[id] ?? null;
  };

  function runSoulPrompt(promptText: string) {
    const text = promptText.trim();
    if (!text) return;
    void (async () => {
      const sessionId = await deps.createSessionAndOpen();
      if (!sessionId) {
        deps.setPrompt(text);
        return;
      }

      await deps.sendPrompt({
        mode: "prompt",
        text,
        resolvedText: text,
        parts: [{ type: "text", text }],
        attachments: [],
      }, {
        targetSessionId: sessionId,
        clientMessageId: createClientMessageId(),
        origin: "app:soul-prompt",
      });
    })();
  }

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
    soulStatusByWorkspaceId,
    soulWorkspaceMap,
    activeSoulStatus,
    activeSoulHeartbeats,
    soulStatusBusy,
    soulHeartbeatsBusy,
    soulError,
    refreshSoulData,
    runSoulPrompt,
  };
}
