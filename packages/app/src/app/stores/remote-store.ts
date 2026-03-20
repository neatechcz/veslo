import { createSignal } from "solid-js";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";

import type { WorkspacePreset, WorkspaceConnectionState } from "../types";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
  normalizeDirectoryPath,
  safeStringify,
} from "../utils";
import { t, currentLocale } from "../../i18n";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import type { OpencodeAuth } from "../lib/opencode";
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
  orchestratorStartDetached,
  sandboxStop,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceForget,
  workspaceUpdateRemote,
  type WorkspaceInfo,
} from "../lib/tauri";
import type { SandboxDoctorResult } from "../lib/tauri";

import type {
  SandboxCreatePhase,
  SandboxCreateProgressState,
  SandboxCreateProgressStep,
} from "../context/workspace";

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

  // Engine store reference
  engineStore: {
    refreshSandboxDoctor: () => Promise<SandboxDoctorResult | null>;
  };

  // Server connection
  connectToServer: (
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) => Promise<boolean>;

  // Workspace activation & testing
  activateWorkspace: (workspaceId: string) => Promise<boolean>;
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
  // Sandbox signals (owned by this store)
  // ---------------------------------------------------------------------------
  const [sandboxPreflightBusy, setSandboxPreflightBusy] = createSignal(false);
  const [sandboxCreatePhase, setSandboxCreatePhase] = createSignal<SandboxCreatePhase>("idle");
  const [sandboxCreateProgress, setSandboxCreateProgress] = createSignal<SandboxCreateProgressState | null>(null);
  const clearSandboxCreateProgress = () => setSandboxCreateProgress(null);

  const pushSandboxCreateLog = (line: string) => {
    const value = String(line ?? "").trim();
    if (!value) return;
    setSandboxCreateProgress((prev) => {
      if (!prev) return prev;
      const nextLogs = prev.logs.length ? prev.logs.slice(-119) : [];
      // Avoid rapid duplicates.
      const last = nextLogs[nextLogs.length - 1] ?? "";
      if (last !== value) nextLogs.push(value);
      return { ...prev, logs: nextLogs };
    });
  };

  const setSandboxStep = (key: SandboxCreateProgressStep["key"], patch: Partial<SandboxCreateProgressStep>) => {
    setSandboxCreateProgress((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        steps: prev.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
      };
    });
  };

  const setSandboxStage = (stage: string) => {
    const value = String(stage ?? "").trim();
    if (!value) return;
    setSandboxCreateProgress((prev) => (prev ? { ...prev, stage: value } : prev));
  };

  const setSandboxError = (message: string) => {
    const value = String(message ?? "").trim() || "Sandbox failed to start";
    setSandboxCreateProgress((prev) => (prev ? { ...prev, error: value } : prev));
  };

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

    // Sandbox lifecycle metadata (desktop-managed)
    sandboxBackend?: "docker" | null;
    sandboxRunId?: string | null;
    sandboxContainerName?: string | null;
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
      let resolved: Awaited<ReturnType<typeof resolveVesloHost>> | null = null;
      try {
        resolved = await resolveVesloHost({
          hostUrl,
          token,
          directoryHint: directory || null,
        });
      } catch (error) {
        // Sandbox workers can report healthy before listWorkspaces is fully ready.
        // Fall back to host-level OpenCode URL so the worker can still be registered.
        if (input.sandboxBackend !== "docker") {
          throw error;
        }
        deps.wsDebug("sandbox:veslo-resolve-fallback:error", {
          hostUrl,
          message: error instanceof Error ? error.message : safeStringify(error),
        });
      }

      if (resolved?.kind === "veslo") {
        resolvedBaseUrl = resolved.opencodeBaseUrl;
        resolvedDirectory = resolved.directory || directory;
        vesloWorkspace = resolved.workspace;
        resolvedHostUrl = resolved.hostUrl;
        resolvedAuth = resolved.auth;
      } else if (input.sandboxBackend === "docker") {
        resolvedHostUrl = hostUrl;
        resolvedBaseUrl = `${hostUrl.replace(/\/+$/, "")}/opencode`;
        resolvedDirectory = directory || resolvedDirectory;
        resolvedAuth = token ? { token, mode: "veslo" } : undefined;
        deps.wsDebug("sandbox:veslo-resolve-fallback:host", {
          hostUrl: resolvedHostUrl,
          baseUrl: resolvedBaseUrl,
          directory: resolvedDirectory,
        });
      } else {
        deps.setError("Veslo server unavailable. Check the URL and token.");
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

    const ok = await deps.connectToServer(
      resolvedBaseUrl,
      resolvedDirectory || undefined,
      {
        workspaceType: "remote",
        targetRoot: resolvedDirectory ?? "",
        reason: "workspace-create-remote",
      },
      resolvedAuth,
    );

    if (!ok) {
      return false;
    }

    const finalDirectory = deps.getClientDirectory().trim() || resolvedDirectory || "";

    const manageBusy = input.manageBusy ?? true;
    if (manageBusy) {
      deps.setBusy(true);
      deps.setBusyLabel("status.creating_workspace");
      deps.setBusyStartedAt(Date.now());
    }

    try {
      if (isTauriRuntime()) {
        const ws = await workspaceCreateRemote({
          baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
          directory: finalDirectory ? finalDirectory : null,
          displayName,
          remoteType,
          vesloHostUrl: remoteType === "veslo" ? resolvedHostUrl : null,
          vesloToken: remoteType === "veslo" ? (token || null) : null,
          vesloWorkspaceId: remoteType === "veslo" ? vesloWorkspace?.id ?? null : null,
          vesloWorkspaceName: remoteType === "veslo" ? vesloWorkspace?.name ?? null : null,
          sandboxBackend: input.sandboxBackend ?? null,
          sandboxRunId: input.sandboxRunId ?? null,
          sandboxContainerName: input.sandboxContainerName ?? null,
        });
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
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
          sandboxBackend: input.sandboxBackend ?? null,
          sandboxRunId: input.sandboxRunId ?? null,
          sandboxContainerName: input.sandboxContainerName ?? null,
        };

        deps.setWorkspaces((prev: WorkspaceInfo[]) => {
          const withoutMatch = prev.filter((workspace) => workspace.id !== workspaceId);
          return [...withoutMatch, nextWorkspace];
        });
        deps.syncActiveWorkspaceId(workspaceId);
        console.log("[workspace] create remote complete:", workspaceId);
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
        deps.setError("Veslo server unavailable. Check the URL and token.");
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
          message: "Failed to connect to worker.",
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
        return await deps.activateWorkspace(id);
      }
      return await deps.testWorkspaceConnection(id);
    };

    const myVersion = deps.wsActivateGuard.enter(id);
    deps.setConnectingWorkspaceId(id);
    deps.setError(null);

    try {
      deps.updateWorkspaceConnectionState(id, { status: "connecting", message: null });

      if (workspace.workspaceType !== "remote") {
        return Boolean(await reconnect());
      }

      const isSandboxWorkspace =
        workspace.sandboxBackend === "docker" || Boolean(workspace.sandboxContainerName?.trim());

      if (!isSandboxWorkspace) {
        return Boolean(await reconnect());
      }

      if (!isTauriRuntime()) {
        deps.setError(t("app.error.tauri_required", currentLocale()));
        deps.updateWorkspaceConnectionState(id, {
          status: "error",
          message: t("app.error.tauri_required", currentLocale()),
        });
        return false;
      }

      const workspacePath = workspace.directory?.trim() || workspace.path?.trim() || "";
      if (!workspacePath) {
        const message = "Worker folder is missing. Open Edit connection and try again.";
        deps.setError(message);
        deps.updateWorkspaceConnectionState(id, { status: "error", message });
        return false;
      }

      const doctor = await deps.engineStore.refreshSandboxDoctor();
      if (!doctor?.ready) {
        const detail =
          doctor?.error?.trim() ||
          "Docker needs to be running before we can get this worker back online.";
        throw new Error(detail);
      }

      const host = await orchestratorStartDetached({
        workspacePath,
        sandboxBackend: "docker",
        runId: workspace.sandboxRunId?.trim() || null,
        vesloToken:
          workspace.vesloToken?.trim() || deps.getVesloServerSettings().token?.trim() || null,
      });

      const resolved = await resolveVesloHost({
        hostUrl: host.vesloUrl,
        token: host.token,
        directoryHint: workspacePath,
      });

      if (resolved.kind !== "veslo") {
        throw new Error("Worker is still warming up. Try again in a few seconds.");
      }

      const updated = await workspaceUpdateRemote({
        workspaceId: id,
        remoteType: "veslo",
        baseUrl: resolved.opencodeBaseUrl,
        directory: resolved.directory || workspacePath,
        vesloHostUrl: resolved.hostUrl,
        vesloToken: host.token,
        vesloWorkspaceId: resolved.workspace?.id ?? workspace.vesloWorkspaceId ?? null,
        vesloWorkspaceName: resolved.workspace?.name ?? workspace.vesloWorkspaceName ?? null,
        sandboxBackend: host.sandboxBackend ?? "docker",
        sandboxRunId: host.sandboxRunId ?? workspace.sandboxRunId ?? null,
        sandboxContainerName: host.sandboxContainerName ?? workspace.sandboxContainerName ?? null,
      });

      deps.setWorkspaces(updated.workspaces);
      deps.syncActiveWorkspaceId(updated.activeId);

      const ok = await reconnect();
      if (!ok) {
        const message = "Worker restarted, but reconnect failed. Try again in a few seconds.";
        deps.updateWorkspaceConnectionState(id, { status: "error", message });
        deps.setError(message);
        return false;
      }

      deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
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
  // createSandboxFlow
  // ---------------------------------------------------------------------------
  async function createSandboxFlow(
    preset: WorkspacePreset,
    folder: string | null,
    input?: { onReady?: () => Promise<void> | void },
  ): Promise<boolean> {
    if (CLOUD_ONLY_MODE) {
      return deps.blockLocalAction("cloud_only_local_disabled", "Local sandbox provisioning is disabled.");
    }

    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    if (!folder) {
      deps.setError(t("app.error.choose_folder", currentLocale()));
      return false;
    }

    const runId = deps.makeRunId();
    const startedAt = Date.now();
    setSandboxCreatePhase("preflight");
    setSandboxPreflightBusy(true);
    deps.setError(null);
    clearSandboxCreateProgress();

    const doctor = await deps.engineStore.refreshSandboxDoctor();
    setSandboxPreflightBusy(false);
    setSandboxCreatePhase("provisioning");
    setSandboxCreateProgress({
      runId,
      startedAt,
      stage: "Checking Docker...",
      error: null,
      logs: [],
      steps: [
        { key: "docker", label: "Docker ready", status: "active", detail: null },
        { key: "workspace", label: "Prepare worker", status: "pending", detail: null },
        { key: "sandbox", label: "Start sandbox services", status: "pending", detail: null },
        { key: "health", label: "Wait for Veslo", status: "pending", detail: null },
        { key: "connect", label: "Connect in Veslo", status: "pending", detail: null },
      ],
    });

    if (doctor?.debug) {
      const selectedBin = doctor.debug.selectedBin?.trim();
      if (selectedBin) {
        pushSandboxCreateLog(`Docker binary: ${selectedBin}`);
      }
      const candidates = (doctor.debug.candidates ?? []).filter((item) => item?.trim());
      if (candidates.length) {
        pushSandboxCreateLog(`Docker candidates: ${candidates.join(", ")}`);
      }
      const versionDebug = doctor.debug.versionCommand;
      if (versionDebug) {
        pushSandboxCreateLog(`docker --version exit=${versionDebug.status}`);
        if (versionDebug.stderr?.trim()) pushSandboxCreateLog(`docker --version stderr: ${versionDebug.stderr.trim()}`);
      }
      const infoDebug = doctor.debug.infoCommand;
      if (infoDebug) {
        pushSandboxCreateLog(`docker info exit=${infoDebug.status}`);
        if (infoDebug.stderr?.trim()) pushSandboxCreateLog(`docker info stderr: ${infoDebug.stderr.trim()}`);
      }
    }
    if (!doctor?.ready) {
      const detail =
        doctor?.error?.trim() ||
        "Docker is required for sandboxes. Install Docker Desktop, start it, then retry.";
      deps.setError(detail);
      setSandboxStep("docker", { status: "error", detail });
      setSandboxError(detail);
      setSandboxStage("Docker not ready");
      setSandboxCreatePhase("idle");
      return false;
    }
    setSandboxStep("docker", { status: "done", detail: doctor.serverVersion ?? null });
    setSandboxStage("Preparing worker...");

    try {
      const resolvedFolder = await deps.resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        deps.setError(t("app.error.choose_folder", currentLocale()));
        setSandboxStep("workspace", { status: "error", detail: "No folder selected" });
        setSandboxError("No folder selected");
        return false;
      }

      const name = resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Worker";

      setSandboxStep("workspace", { status: "active", detail: name });
      pushSandboxCreateLog(`Worker: ${resolvedFolder}`);

      // Ensure the workspace folder has baseline Veslo/OpenCode files.
      const created = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      deps.setWorkspaces(created.workspaces);
      deps.syncActiveWorkspaceId(created.activeId);
      setSandboxStep("workspace", { status: "done", detail: null });

      // Remove the local workspace entry to avoid duplicate Local+Remote rows.
      const localId = created.activeId;
      if (localId) {
        pushSandboxCreateLog("Removing local worker row (will re-add as remote sandbox)...");
        const forgotten = await workspaceForget(localId);
        deps.setWorkspaces(forgotten.workspaces);
        deps.syncActiveWorkspaceId(forgotten.activeId);
      }

      setSandboxStep("sandbox", { status: "active", detail: null });
      setSandboxStage("Starting sandbox services...");

      let stopListen: (() => void) | null = null;
      try {
        stopListen = await listen(
          "veslo://sandbox-create-progress",
          (event: TauriEvent<{ runId?: string; stage?: string; message?: string; payload?: any }>) => {
            const payload = event.payload ?? {};
            if ((payload.runId ?? "").trim() !== runId) return;
            const stage = String(payload.stage ?? "").trim();
            const message = String(payload.message ?? "").trim();
            if (message) {
              setSandboxStage(message);
              pushSandboxCreateLog(message);
            }

            if (stage === "docker.container") {
              const state = String(payload.payload?.containerState ?? "").trim();
              if (state) {
                setSandboxStep("sandbox", { status: "active", detail: `Container: ${state}` });
              }
            }

            if (stage === "docker.config") {
              const selected = String(payload.payload?.vesloDockerBin ?? "").trim();
              if (selected) {
                pushSandboxCreateLog(`VESLO_DOCKER_BIN=${selected}`);
              }
              const candidates = Array.isArray(payload.payload?.candidates)
                ? payload.payload.candidates.filter((item: unknown) => String(item ?? "").trim())
                : [];
              if (candidates.length) {
                pushSandboxCreateLog(`Docker probe paths: ${candidates.join(", ")}`);
              }
            }

            if (stage === "docker.inspect") {
              const inspectError = String(payload.payload?.error ?? "").trim();
              if (inspectError) {
                setSandboxStep("sandbox", { status: "active", detail: "Docker inspect warning" });
                pushSandboxCreateLog(`docker inspect warning: ${inspectError}`);
              }
            }

            if (stage === "veslo.waiting") {
              const elapsedMs = Number(payload.payload?.elapsedMs ?? 0);
              const seconds = elapsedMs > 0 ? Math.max(1, Math.floor(elapsedMs / 1000)) : 0;
              setSandboxStep("health", { status: "active", detail: seconds ? `${seconds}s` : null });
              const probeError = String(payload.payload?.containerProbeError ?? "").trim();
              if (probeError) {
                pushSandboxCreateLog(`Container probe: ${probeError}`);
              }
            }

            if (stage === "veslo.healthy") {
              setSandboxStep("sandbox", { status: "done" });
              setSandboxStep("health", { status: "done", detail: null });
            }

            if (stage === "error") {
              const err = String(payload.payload?.error ?? "").trim() || message || "Sandbox failed to start";
              setSandboxStep("sandbox", { status: "error", detail: err });
              setSandboxStep("health", { status: "error", detail: err });
              setSandboxError(err);
            }
          },
        );

        const host = await orchestratorStartDetached({
          workspacePath: resolvedFolder,
          sandboxBackend: "docker",
          runId,
        });
        setSandboxStep("sandbox", { status: "done", detail: host.sandboxContainerName ?? null });
        setSandboxStep("health", { status: "done" });
        setSandboxStage("Connecting to sandbox...");

        setSandboxStep("connect", { status: "active", detail: null });

        deps.markOnboardingComplete();

        const ok = await createRemoteWorkspaceFlow({
          vesloHostUrl: host.vesloUrl,
          vesloToken: host.token,
          directory: resolvedFolder,
          displayName: name,
          sandboxBackend: host.sandboxBackend ?? "docker",
          sandboxRunId: host.sandboxRunId ?? runId,
          sandboxContainerName: host.sandboxContainerName ?? null,
          manageBusy: false,
          closeModal: false,
        });
        if (!ok) {
          const fallback = "Failed to connect to sandbox";
          pushSandboxCreateLog(fallback);
          setSandboxStep("connect", { status: "error", detail: fallback });
          setSandboxError(fallback);
          return false;
        }

        if (input?.onReady) {
          setSandboxCreatePhase("finalizing");
          setSandboxStage("Finalizing worker...");
          setSandboxStep("connect", { status: "active", detail: "Applying setup" });
          pushSandboxCreateLog("Applying final worker setup...");
          await input.onReady();
        }

        setSandboxStep("connect", { status: "done", detail: null });
        setSandboxStage("Sandbox ready.");
        deps.setCreateWorkspaceOpen(false);
        await deps.openEmptySession(deps.getActiveWorkspaceRoot().trim() || resolvedFolder);
        clearSandboxCreateProgress();
        return true;
      } finally {
        stopListen?.();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      setSandboxError(message);
      setSandboxStage("Sandbox failed");
      return false;
    } finally {
      setSandboxPreflightBusy(false);
      setSandboxCreatePhase("idle");
    }
  }

  // ---------------------------------------------------------------------------
  // stopSandbox
  // ---------------------------------------------------------------------------
  async function stopSandbox(workspaceId: string) {
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const id = workspaceId.trim();
    if (!id) return;

    const workspace = deps.getWorkspaces().find((entry) => entry.id === id) ?? null;
    const containerName = workspace?.sandboxContainerName?.trim() ?? "";
    if (!containerName) {
      deps.setError("Sandbox container name missing.");
      return;
    }

    deps.setBusy(true);
    deps.setBusyLabel("Stopping sandbox...");
    deps.setBusyStartedAt(Date.now());
    deps.setError(null);

    try {
      const result = await sandboxStop(containerName);
      if (!result.ok) {
        const details = [result.stderr?.trim(), result.stdout?.trim()]
          .filter(Boolean)
          .join("\n")
          .trim();
        throw new Error(details || `Failed to stop sandbox (status ${result.status})`);
      }

      // If the user stopped the active workspace, proactively disconnect the client.
      if (deps.getActiveWorkspaceId() === id) {
        deps.setClient(null);
        deps.setConnectedVersion(null);
        deps.setSseConnected(false);
      }

      deps.updateWorkspaceConnectionState(id, { status: "error", message: "Sandbox stopped." });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // Signals
    sandboxPreflightBusy,
    sandboxCreatePhase,
    sandboxCreateProgress,
    clearSandboxCreateProgress,

    // Methods
    resolveVesloHost,
    createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow,
    recoverWorkspace,
    createSandboxFlow,
    stopSandbox,
  };
}
