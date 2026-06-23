import type { OpencodeAuth } from "../lib/opencode";
import type { VesloServerSettings, VesloSoulAuthContext, VesloWorkspaceInfo } from "../lib/veslo-server";
import {
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
} from "../lib/veslo-server";
import type { WorkspaceInfo } from "../lib/tauri";
import {
  workspaceSetActive,
  workspaceUpdateRemote,
} from "../lib/tauri";
import { isTauriRuntime } from "../utils";
import type { ConnectToServer, WorkspaceActivationOptions } from "./workspace-types";

export type WorkspaceRemoteActivationDeps = {
  setStartupPreference: (value: any) => void;
  vesloServerSettings: () => VesloServerSettings;
  soulAuthContext?: () => VesloSoulAuthContext;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  resolveVesloHost: (input: {
    hostUrl: string;
    token?: string | null;
    workspaceId?: string | null;
    directoryHint?: string | null;
  }) => Promise<any>;
  connectToServer: ConnectToServer;
  setWorkspaces: (value: WorkspaceInfo[] | ((prev: WorkspaceInfo[]) => WorkspaceInfo[])) => void;
  syncActiveWorkspaceId: (id?: string) => void;
  setProjectDir: (value: string) => void;
  setWorkspaceConfig: (value: any) => void;
  setWorkspaceConfigLoaded: (value: boolean) => void;
  setAuthorizedDirs: (value: string[]) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  setError: (value: string | null) => void;
  isSuperseded: () => boolean;
  activationOptions: WorkspaceActivationOptions;
  activateStart: number;
  workspaceSetActiveTimeoutMs: number;
  withTimeoutOrThrow: typeof import("../utils/promise-timeout").withTimeoutOrThrow;
  t: (key: string, locale?: any) => string;
  currentLocale: () => any;
  indirectT: (key: string, locale?: any) => string;
  indirectLocale: () => any;
  safeStringify: (value: unknown) => string;
  addOpencodeCacheHint: (message: string) => string;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function createWorkspaceRemoteActivation(deps: WorkspaceRemoteActivationDeps) {
  async function persistRemoteSelection(
    id: string,
    directory: string,
  ) {
    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:before-remote-persist", { id });
      return false;
    }

    deps.syncActiveWorkspaceId(id);
    deps.setProjectDir(directory);
    deps.setWorkspaceConfig(null);
    deps.setWorkspaceConfigLoaded(true);
    deps.setAuthorizedDirs([]);

    if (isTauriRuntime()) {
      try {
        const ws = await deps.withTimeoutOrThrow(
          workspaceSetActive(id, { promoteToFront: deps.activationOptions?.promoteToFront ?? false }),
          { timeoutMs: deps.workspaceSetActiveTimeoutMs, label: "workspace_set_active" },
        );
        if (deps.isSuperseded()) {
          deps.wsDebug("activate:superseded:after-remote-set-active", { id });
          return false;
        }
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }
    }
    return true;
  }

  async function activateRemoteVesloWorkspace(
    id: string,
    next: WorkspaceInfo,
    baseUrl: string,
  ) {
    const hostUrl = next.vesloHostUrl?.trim() ?? "";
    if (!hostUrl) {
      deps.setError(deps.indirectT("ui.indirect.veslo_server_url_is_required_63g0jb", deps.indirectLocale()));
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.veslo_server_url_is_required_63g0jb", deps.indirectLocale()),
      });
      return false;
    }

    const workspaceToken = next.vesloToken?.trim() ?? "";
    const fallbackToken = deps.vesloServerSettings().token ?? "";
    const token = workspaceToken || fallbackToken;

    const currentSettings = deps.vesloServerSettings();
    if (
      currentSettings.urlOverride?.trim() !== hostUrl ||
      (token && currentSettings.token?.trim() !== token)
    ) {
      deps.updateVesloServerSettings({
        ...currentSettings,
        urlOverride: hostUrl,
        token: token || currentSettings.token,
      });
    }

    let resolvedBaseUrl = baseUrl;
    let resolvedDirectory = next.directory?.trim() ?? "";
    let workspaceInfo: VesloWorkspaceInfo | null = null;
    let resolvedAuth: OpencodeAuth | undefined = undefined;

    try {
      const resolved = await deps.resolveVesloHost({
        hostUrl,
        token,
        workspaceId: next.vesloWorkspaceId ?? null,
        directoryHint: next.directory ?? null,
      });
      if (resolved.kind !== "veslo") {
        deps.setError(deps.indirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", deps.indirectLocale()));
        deps.updateWorkspaceConnectionState(id, {
          status: "error",
          message: deps.indirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", deps.indirectLocale()),
        });
        return false;
      }

      resolvedBaseUrl = resolved.opencodeBaseUrl;
      resolvedDirectory = resolved.directory;
      workspaceInfo = resolved.workspace;
      resolvedAuth = resolved.auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(deps.addOpencodeCacheHint(message));
      deps.updateWorkspaceConnectionState(id, { status: "error", message });
      return false;
    }

    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:after-veslo-resolve", { id });
      return false;
    }

    if (!resolvedBaseUrl) {
      deps.setError(deps.t("app.error.remote_base_url_required", deps.currentLocale()));
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.remote_base_url_is_required_1ig1w2", deps.indirectLocale()),
      });
      return false;
    }

    const ok = await deps.connectToServer(
      resolvedBaseUrl,
      resolvedDirectory || undefined,
      {
        workspaceId: next.id,
        workspaceType: next.workspaceType,
        targetRoot: resolvedDirectory ?? "",
        reason: "workspace-switch-veslo",
      },
      resolvedAuth,
      { navigate: false },
    );

    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:after-veslo-connect", { id });
      return false;
    }

    if (!ok) {
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.failed_to_connect_to_worker_bjt8ig", deps.indirectLocale()),
      });
      return false;
    }

    if (workspaceInfo?.id) {
      try {
        const scopedHostUrl =
          buildVesloWorkspaceBaseUrl(hostUrl, workspaceInfo.id) ?? hostUrl;
        const provisionClient = createVesloServerClient({
          baseUrl: scopedHostUrl,
          token: token || undefined,
        });
        const provision = await provisionClient.provisionWorkspaceSystem(
          workspaceInfo.id,
          deps.soulAuthContext?.(),
        );
        deps.wsDebug("activate:veslo:provision", {
          id: workspaceInfo.id,
          status: provision.status,
          version: provision.version,
          written: provision.written,
          unchanged: provision.unchanged,
        });
      } catch (error) {
        deps.wsDebug("activate:veslo:provision:failed", {
          id: workspaceInfo.id,
          message: error instanceof Error ? error.message : deps.safeStringify(error),
        });
      }
    }

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateRemote({
          workspaceId: next.id,
          remoteType: "veslo",
          baseUrl: resolvedBaseUrl,
          directory: resolvedDirectory || null,
          vesloHostUrl: hostUrl,
          vesloToken: token ? token : null,
          vesloWorkspaceId: workspaceInfo?.id ?? next.vesloWorkspaceId ?? null,
          vesloWorkspaceName: workspaceInfo?.name ?? next.vesloWorkspaceName ?? null,
        });
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
      } catch {
        // ignore
      }
    } else {
      const resolvedToken = token.trim();
      deps.setWorkspaces((prev) =>
        prev.map((ws) => {
          if (ws.id !== next.id) return ws;
          return {
            ...ws,
            remoteType: "veslo",
            baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
            directory: resolvedDirectory || null,
            vesloHostUrl: hostUrl,
            vesloToken: resolvedToken || null,
            vesloWorkspaceId: workspaceInfo?.id ?? ws.vesloWorkspaceId ?? null,
            vesloWorkspaceName: workspaceInfo?.name ?? ws.vesloWorkspaceName ?? null,
          };
        }),
      );
    }

    if (!(await persistRemoteSelection(id, resolvedDirectory || ""))) return false;
    deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
    return true;
  }

  async function activateRemoteDirectWorkspace(
    id: string,
    next: WorkspaceInfo,
    baseUrl: string,
  ) {
    if (!baseUrl) {
      deps.setError(deps.t("app.error.remote_base_url_required", deps.currentLocale()));
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.remote_base_url_is_required_1ig1w2", deps.indirectLocale()),
      });
      return false;
    }

    const ok = await deps.connectToServer(
      baseUrl,
      next.directory?.trim() || undefined,
      {
        workspaceId: next.id,
        workspaceType: next.workspaceType,
        targetRoot: next.directory?.trim() ?? "",
        reason: "workspace-switch-direct",
      },
      undefined,
      { navigate: false },
    );

    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:after-direct-connect", { id });
      return false;
    }

    if (!ok) {
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.failed_to_connect_to_worker_bjt8ig", deps.indirectLocale()),
      });
      return false;
    }

    const directory = next.directory?.trim() ?? "";
    if (!(await persistRemoteSelection(id, directory))) return false;
    deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
    deps.wsDebug("activate:remote:done", { id, ms: Date.now() - deps.activateStart });
    return true;
  }

  async function activateRemoteWorkspace(
    id: string,
    next: WorkspaceInfo,
    remoteType: "veslo" | "opencode",
    baseUrl: string,
  ) {
    deps.setStartupPreference("server");
    return remoteType === "veslo"
      ? await activateRemoteVesloWorkspace(id, next, baseUrl)
      : await activateRemoteDirectWorkspace(id, next, baseUrl);
  }

  return {
    activateRemoteWorkspace,
    activateRemoteVesloWorkspace,
    activateRemoteDirectWorkspace,
  };
}
