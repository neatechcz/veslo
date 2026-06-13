import type { WorkspaceConnectionState } from "../types";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
  normalizeDirectoryPath,
  safeStringify,
} from "../utils";
import { t, currentLocale } from "../../i18n";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";
import type { OpencodeAuth } from "../lib/opencode";
import type {
  ConnectToServer,
  WorkspaceActivationOptions,
} from "../context/workspace-types";
import {
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  normalizeVesloServerUrl,
  VesloServerError,
  type VesloServerSettings,
  type VesloServerClient,
  type VesloWorkspaceInfo,
} from "../lib/veslo-server";
import { createClient, waitForHealthy } from "../lib/opencode";
import {
  workspaceCreateRemote as invokeWorkspaceCreateRemote,
  workspaceUpdateRemote,
  type WorkspaceInfo,
} from "../lib/tauri";

export interface RemoteStoreDeps {
  // Workspace state accessors
  getWorkspaces: () => WorkspaceInfo[];
  setWorkspaces: (ws: WorkspaceInfo[] | ((prev: WorkspaceInfo[]) => WorkspaceInfo[])) => void;
  getActiveWorkspaceId: () => string;
  getActiveWorkspaceInfo: () => WorkspaceInfo | null;
  getActiveWorkspaceRoot: () => string;
  getActiveWorkspacePath: () => string;
  getProjectDir: () => string;
  setProjectDir: (dir: string) => void;
  syncActiveWorkspaceId: (id: string | undefined) => void;

  // Workspace connection state
  updateWorkspaceConnectionState: (workspaceId: string, next: Partial<WorkspaceConnectionState>) => void;
  getConnectingWorkspaceId: () => string | null;
  setConnectingWorkspaceId: (id: string | null | ((prev: string | null) => string | null)) => void;

  // Workspace config
  setWorkspaceConfig: (config: any) => void;
  setWorkspaceConfigLoaded: (loaded: boolean) => void;
  setAuthorizedDirs: (dirs: string[]) => void;

  // Modal / UI state
  setCreateWorkspaceOpen: (open: boolean) => void;
  setCreateRemoteWorkspaceOpen: (open: boolean) => void;

  // Veslo server settings
  getVesloServerSettings: () => VesloServerSettings;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  getClientDirectory: () => string;

  // Server connection
  connectToServer: ConnectToServer;

  // Workspace activation & testing
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean>;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean>;
  openEmptySession: (scopeRoot?: string) => Promise<void>;

  // UI setters
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setStartupPreference: (value: any) => void;
  setClient: (value: any) => void;
  setConnectedVersion: (value: string | null) => void;
  setSseConnected: (value: boolean) => void;

  // Workspace activate guard
  wsActivateGuard: {
    enter: (workspaceId: string) => number;
    isSuperseded: (version: number) => boolean;
    exit: (version: number, clearConnecting: (updater: (current: string | null) => string | null) => void) => void;
  };

  // Utility
  markOnboardingComplete: () => void;
  blockLocalAction: (code: string, detail: string) => boolean;
  resolveWorkspacePath: (input: string) => Promise<string>;
  wsDebug: (label: string, payload?: unknown) => void;
  makeRunId: () => string;
}

export function createRemoteStore(deps: RemoteStoreDeps) {
  // ---------------------------------------------------------------------------
  // In-flight guard for createRemoteWorkspaceFlow
  // ---------------------------------------------------------------------------
  let createRemoteInFlight: Promise<boolean> | null = null;

  // ---------------------------------------------------------------------------
  // resolveVesloHost
  // ---------------------------------------------------------------------------
  const resolveVesloHost = async (input: {
    hostUrl: string;
    token?: string | null;
    workspaceId?: string | null;
    directoryHint?: string | null;
  }) => {
    let normalizedHostUrl = normalizeVesloServerUrl(input.hostUrl) ?? "";
    if (!normalizedHostUrl) {
      return { kind: "fallback" as const };
    }

    let inferredWorkspaceId: string | null = null;
    try {
      const url = new URL(normalizedHostUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] ?? "";
      const prev = segments[segments.length - 2] ?? "";
      const alreadyMounted = prev === "w" && Boolean(last);
      if (alreadyMounted) {
        inferredWorkspaceId = decodeURIComponent(last);
        const baseSegments = segments.slice(0, -2);
        url.pathname = `/${baseSegments.join("/")}`;
        normalizedHostUrl = url.toString().replace(/\/+$/, "");
      }
    } catch {
      // ignore
    }

    const requestedWorkspaceId = (input.workspaceId?.trim() || inferredWorkspaceId || "").trim();
    const workspaceBaseUrl = buildVesloWorkspaceBaseUrl(normalizedHostUrl, requestedWorkspaceId) ?? normalizedHostUrl;

    const client = createVesloServerClient({ baseUrl: workspaceBaseUrl, token: input.token ?? undefined });

    const trimmedToken = input.token?.trim() ?? "";
    const fallbackDirectory = input.directoryHint?.trim() ?? "";
    const tokenlessFallback = () => ({
      kind: "veslo" as const,
      hostUrl: normalizedHostUrl,
      workspace: requestedWorkspaceId
        ? ({
            id: requestedWorkspaceId,
            name: requestedWorkspaceId,
            path: fallbackDirectory,
            workspaceType: "remote",
          } as VesloWorkspaceInfo)
        : null,
      opencodeBaseUrl: `${workspaceBaseUrl.replace(/\/+$/, "")}/opencode`,
      directory: fallbackDirectory,
      auth: undefined as OpencodeAuth | undefined,
    });

    const canReachDirectOpencode = async () => {
      try {
        const directClient = createClient(
          `${workspaceBaseUrl.replace(/\/+$/, "")}/opencode`,
          fallbackDirectory || undefined,
        );
        await waitForHealthy(directClient, { timeoutMs: 6_000 });
        return true;
      } catch {
        return false;
      }
    };

    try {
      const health = await client.health();
      if (!health?.ok) {
        return { kind: "fallback" as const };
      }
    } catch (error) {
      if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
        if (!trimmedToken) {
          if (await canReachDirectOpencode()) {
            return tokenlessFallback();
          }
          throw new Error("Access token required for Veslo server.");
        }
        throw new Error("Veslo server rejected the access token.");
      }
      return { kind: "fallback" as const };
    }
    let response: Awaited<ReturnType<typeof client.listWorkspaces>>;
    try {
      response = await client.listWorkspaces();
    } catch (error) {
      if (!trimmedToken) {
        if (await canReachDirectOpencode()) {
          return tokenlessFallback();
        }
        if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
          throw new Error("Access token required for Veslo server.");
        }
      }
      throw error;
    }
    const items = Array.isArray(response.items) ? response.items : [];
    const hint = normalizeDirectoryPath(input.directoryHint ?? "");
    const selectByHint = (entry: VesloWorkspaceInfo) => {
      if (!hint) return false;
      const entryPath = normalizeDirectoryPath(
        (entry.opencode?.directory as string | undefined) ?? (entry.path as string | undefined) ?? "",
      );
      return Boolean(entryPath && entryPath === hint);
    };
    const selectById = (entry: VesloWorkspaceInfo) => Boolean(requestedWorkspaceId && entry?.id === requestedWorkspaceId);

    const workspaceById = requestedWorkspaceId
      ? (items.find((item) => item?.id && selectById(item as any)) as VesloWorkspaceInfo | undefined)
      : undefined;
    if (requestedWorkspaceId && !workspaceById) {
      throw new Error("Veslo worker not found on that host.");
    }

    const workspaceByHint = hint
      ? (items.find((item) => item?.id && selectByHint(item as any)) as VesloWorkspaceInfo | undefined)
      : undefined;

    const workspace = (workspaceById ?? workspaceByHint ?? items[0]) as VesloWorkspaceInfo | undefined;
    if (!workspace?.id) {
      throw new Error("Veslo server did not return a worker.");
    }
    const opencodeUpstreamBaseUrl = workspace.opencode?.baseUrl?.trim() ?? workspace.baseUrl?.trim() ?? "";
    if (!opencodeUpstreamBaseUrl) {
      throw new Error("Veslo server did not provide an OpenCode URL.");
    }

    const workspaceScopedBaseUrl =
      buildVesloWorkspaceBaseUrl(normalizedHostUrl, workspace.id) ?? workspaceBaseUrl;
    const opencodeBaseUrl = `${workspaceScopedBaseUrl.replace(/\/+$/, "")}/opencode`;
    const opencodeAuth: OpencodeAuth | undefined = trimmedToken
      ? { token: trimmedToken, mode: "veslo" }
      : undefined;

    return {
      kind: "veslo" as const,
      hostUrl: normalizedHostUrl,
      workspace,
      opencodeBaseUrl,
      directory: workspace.opencode?.directory?.trim() ?? workspace.directory?.trim() ?? "",
      auth: opencodeAuth,
    };
  };

  // ---------------------------------------------------------------------------
  // createRemoteWorkspaceFlow
  // ---------------------------------------------------------------------------
  async function createRemoteWorkspaceFlow(input: {
    vesloHostUrl?: string | null;
    vesloToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
    manageBusy?: boolean;
    closeModal?: boolean;
  }) {
    if (createRemoteInFlight) {
      deps.wsDebug("create-remote:dedupe", {
        hostUrl: input.vesloHostUrl ?? null,
        directory: input.directory ?? null,
      });
      return createRemoteInFlight;
    }

    const run = (async () => {
    const hostUrl = normalizeVesloServerUrl(input.vesloHostUrl ?? "") ?? "";
    const token = input.vesloToken?.trim() ?? "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      deps.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    deps.setError(null);
    console.log("[workspace] create remote request", {
      hostUrl: hostUrl || null,
      directory: directory || null,
      displayName,
    });

    deps.setStartupPreference("server");

    let remoteType: "veslo" = "veslo";
    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let vesloWorkspace: VesloWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    deps.updateVesloServerSettings({
      ...deps.getVesloServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      const resolved = await resolveVesloHost({
        hostUrl,
        token,
        directoryHint: directory || null,
      });

      if (resolved.kind === "veslo") {
        resolvedBaseUrl = resolved.opencodeBaseUrl;
        resolvedDirectory = resolved.directory || directory;
        vesloWorkspace = resolved.workspace;
        resolvedHostUrl = resolved.hostUrl;
        resolvedAuth = resolved.auth;
      } else {
        deps.setError(__vesloIndirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", __vesloIndirectLocale()));
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      deps.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const finalDirectory = resolvedDirectory || "";

    const manageBusy = input.manageBusy ?? true;
    if (manageBusy) {
      deps.setBusy(true);
      deps.setBusyLabel("status.creating_workspace");
      deps.setBusyStartedAt(Date.now());
    }

    try {
      let remoteWorkspaceId = "";
      if (isTauriRuntime()) {
        const ws = await invokeWorkspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          vesloHostUrl: remoteType === "veslo" ? resolvedHostUrl : null,
          vesloToken: remoteType === "veslo" ? (token || null) : null,
          vesloWorkspaceId: remoteType === "veslo" ? vesloWorkspace?.id ?? null : null,
          vesloWorkspaceName: remoteType === "veslo" ? vesloWorkspace?.name ?? null : null,
        });
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
        remoteWorkspaceId = ws.activeId;
        console.log("[workspace] create remote complete:", ws.activeId ?? "none");
      } else {
        const workspaceId = `remote:${resolvedBaseUrl}:${finalDirectory}`;
        const nextWorkspace: WorkspaceInfo = {
          id: workspaceId,
          name: displayName ?? vesloWorkspace?.name ?? resolvedHostUrl ?? resolvedBaseUrl,
          path: "",
          preset: "remote",
          workspaceType: "remote",
          remoteType,
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory || null,
          displayName,
          vesloHostUrl: remoteType === "veslo" ? resolvedHostUrl : null,
          vesloToken: remoteType === "veslo" ? (token || null) : null,
          vesloWorkspaceId: remoteType === "veslo" ? vesloWorkspace?.id ?? null : null,
          vesloWorkspaceName: remoteType === "veslo" ? vesloWorkspace?.name ?? null : null,
        };

        deps.setWorkspaces((prev: WorkspaceInfo[]) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        deps.syncActiveWorkspaceId(workspaceId);
        remoteWorkspaceId = workspaceId;
        console.log("[workspace] create remote complete:", workspaceId);
      }

      const ok = await deps.connectToServer(
        resolvedBaseUrl,
        finalDirectory || undefined,
        {
          workspaceId: remoteWorkspaceId,
          workspaceType: "remote",
          targetRoot: finalDirectory,
          reason: "workspace-create-remote",
        },
        resolvedAuth,
      );

      if (!ok) {
        return false;
      }

      deps.setProjectDir(finalDirectory);
      deps.setWorkspaceConfig(null);
      deps.setWorkspaceConfigLoaded(true);
      deps.setAuthorizedDirs([]);

      const closeModal = input.closeModal ?? true;
      if (closeModal) {
        deps.setCreateWorkspaceOpen(false);
        deps.setCreateRemoteWorkspaceOpen(false);
      }
      const activeId = deps.getActiveWorkspaceId();
      if (activeId) {
        deps.updateWorkspaceConnectionState(activeId, { status: "connected", message: null });
      }
      await deps.openEmptySession(deps.getActiveWorkspaceRoot().trim() || finalDirectory);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      console.log("[workspace] create remote failed:", message);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      if (manageBusy) {
        deps.setBusy(false);
        deps.setBusyLabel(null);
        deps.setBusyStartedAt(null);
      }
    }
    })();

    createRemoteInFlight = run;
    try {
      return await run;
    } finally {
      if (createRemoteInFlight === run) {
        createRemoteInFlight = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // updateRemoteWorkspaceFlow
  // ---------------------------------------------------------------------------
  async function updateRemoteWorkspaceFlow(
    workspaceId: string,
    input: {
      vesloHostUrl?: string | null;
      vesloToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    },
  ) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = deps.getWorkspaces().find((item) => item.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return false;

    const normalizeRemoteType = (value?: WorkspaceInfo["remoteType"] | null) =>
      value === "veslo" ? "veslo" : "opencode";
    const remoteType = normalizeRemoteType(workspace.remoteType);
    if (remoteType !== "veslo") {
      deps.setError("Only Veslo remote workers can be edited.");
      return false;
    }

    const hostUrl =
      normalizeVesloServerUrl(
        input.vesloHostUrl ?? workspace.vesloHostUrl ?? workspace.baseUrl ?? "",
      ) ?? "";
    const token =
      input.vesloToken?.trim() ??
      workspace.vesloToken?.trim() ??
      deps.getVesloServerSettings().token ??
      "";
    const directory = input.directory?.trim() ?? "";
    const displayName = input.displayName?.trim() || null;

    if (!hostUrl) {
      deps.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    deps.setError(null);
    deps.setStartupPreference("server");

    let resolvedBaseUrl = "";
    let resolvedDirectory = directory;
    let vesloWorkspace: VesloWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;
    let resolvedHostUrl = hostUrl;

    deps.updateVesloServerSettings({
      ...deps.getVesloServerSettings(),
      urlOverride: hostUrl,
      token: token || undefined,
    });

    try {
      const resolved = await resolveVesloHost({
        hostUrl,
        token,
        workspaceId: workspace.vesloWorkspaceId ?? null,
        directoryHint: directory || null,
      });
      if (resolved.kind !== "veslo") {
        deps.setError(__vesloIndirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", __vesloIndirectLocale()));
        return false;
      }
      resolvedBaseUrl = resolved.opencodeBaseUrl;
      resolvedDirectory = resolved.directory || directory;
      vesloWorkspace = resolved.workspace;
      resolvedHostUrl = resolved.hostUrl;
      resolvedAuth = resolved.auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    }

    if (!resolvedBaseUrl) {
      deps.setError(t("app.error.remote_base_url_required", currentLocale()));
      return false;
    }

    const isActive = deps.getActiveWorkspaceId() === id;
    const finalDirectory = resolvedDirectory || "";

    if (isActive) {
      deps.updateWorkspaceConnectionState(id, { status: "connecting", message: null });
      const ok = await deps.connectToServer(
        resolvedBaseUrl,
        finalDirectory || undefined,
        {
          workspaceId: id,
          workspaceType: "remote",
          targetRoot: finalDirectory ?? "",
          reason: "workspace-edit-remote",
        },
        resolvedAuth,
      );
      if (!ok) {
        deps.updateWorkspaceConnectionState(id, {
          status: "error",
          message: __vesloIndirectT("ui.indirect.failed_to_connect_to_worker_bjt8ig", __vesloIndirectLocale()),
        });
        return false;
      }
    }

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateRemote({
          workspaceId: id,
          remoteType: "veslo",
          baseUrl: resolvedBaseUrl,
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          vesloHostUrl: resolvedHostUrl,
          vesloToken: token ? token : null,
          vesloWorkspaceId: vesloWorkspace?.id ?? workspace.vesloWorkspaceId ?? null,
          vesloWorkspaceName: vesloWorkspace?.name ?? workspace.vesloWorkspaceName ?? null,
        });
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }
    } else {
      deps.setWorkspaces((prev: WorkspaceInfo[]) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                remoteType: "veslo",
                baseUrl: resolvedBaseUrl,
                directory: finalDirectory ? finalDirectory : null,
                displayName,
                vesloHostUrl: resolvedHostUrl,
                vesloToken: token ? token : null,
                vesloWorkspaceId: vesloWorkspace?.id ?? item.vesloWorkspaceId ?? null,
                vesloWorkspaceName: vesloWorkspace?.name ?? item.vesloWorkspaceName ?? null,
              }
            : item,
        ),
      );
    }

    if (isActive) {
      deps.setProjectDir(finalDirectory);
      deps.setWorkspaceConfig(null);
      deps.setWorkspaceConfigLoaded(true);
      deps.setAuthorizedDirs([]);
      deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // recoverWorkspace
  // ---------------------------------------------------------------------------
  async function recoverWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    if (deps.getConnectingWorkspaceId() === id) return false;

    const workspace = deps.getWorkspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const reconnect = async () => {
      if (deps.getActiveWorkspaceId() === id) {
        return await deps.activateWorkspace(id, { origin: "remote-store:recover-active-workspace" });
      }
      return await deps.testWorkspaceConnection(id);
    };

    const myVersion = deps.wsActivateGuard.enter(id);
    deps.setConnectingWorkspaceId(id);
    deps.setError(null);

    try {
      deps.updateWorkspaceConnectionState(id, { status: "connecting", message: null });

      return Boolean(await reconnect());
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const hint = addOpencodeCacheHint(message);
      deps.setError(hint);
      deps.updateWorkspaceConnectionState(id, { status: "error", message: hint });
      return false;
    } finally {
      deps.wsActivateGuard.exit(myVersion, deps.setConnectingWorkspaceId);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // Methods
    resolveVesloHost,
    createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow,
    recoverWorkspace,
  };
}
