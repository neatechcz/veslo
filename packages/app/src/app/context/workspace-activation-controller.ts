import type { WorkspaceInfo } from "../lib/tauri";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import type { WorkspaceActivationOptions } from "./workspace-types";

export type WorkspaceActivationRunContext = {
  id: string;
  next: WorkspaceInfo;
  myVersion: number;
  isSuperseded: () => boolean;
  activateStart: number;
  activationOptions: WorkspaceActivationOptions;
};

export type WorkspaceActivationControllerDeps = {
  workspaces: () => WorkspaceInfo[];
  activeWorkspaceId: () => string;
  projectDir: () => string;
  startupPreference: () => unknown;
  hasActiveRoute: () => boolean;
  setConnectingWorkspaceId: (
    value: string | null | ((prev: string | null) => string | null),
  ) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  wsActivateGuard: {
    enter: (workspaceId: string) => number;
    isSuperseded: (version: number) => boolean;
    exit: (
      version: number,
      clearConnecting: (updater: (current: string | null) => string | null) => void,
    ) => void;
  };
  runActivationBody: (context: WorkspaceActivationRunContext) => Promise<boolean>;
  blockLocalAction: (code: string, detail: string) => boolean;
  cloudOnlyMessage: (code: string, detail: string) => string;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  safeStringify: (value: unknown) => string;
  addOpencodeCacheHint: (message: string) => string;
  workspaceDebugStack: () => unknown;
  wsDebug: (label: string, payload?: unknown) => void;
  wsLog: (msg: string, data?: unknown) => void;
  activateTimeoutMs: number;
};

export function createWorkspaceActivationController(deps: WorkspaceActivationControllerDeps) {
  async function activateWorkspace(
    workspaceId: string | undefined,
    activationOptions: WorkspaceActivationOptions,
  ) {
    const id = workspaceId?.trim() ?? "";
    if (!id) return false;

    const next = deps.workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    if (CLOUD_ONLY_MODE && !isRemote) {
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.cloudOnlyMessage("cloud_only_local_workspace_filtered", "Local workers are disabled."),
      });
      return deps.blockLocalAction("cloud_only_local_workspace_filtered", "Local workers are disabled.");
    }

    const myVersion = deps.wsActivateGuard.enter(id);
    const isSuperseded = () => deps.wsActivateGuard.isSuperseded(myVersion);

    console.log("[workspace] activate", {
      id: next.id,
      type: next.workspaceType,
      origin: activationOptions.origin,
    });
    const activateStart = Date.now();
    deps.wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: deps.activeWorkspaceId(),
      prevProjectDir: deps.projectDir(),
      startupPref: deps.startupPreference(),
      hasClient: Boolean(deps.hasActiveRoute()),
      origin: activationOptions.origin,
      stack: deps.workspaceDebugStack(),
    });

    deps.setConnectingWorkspaceId(id);
    deps.updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    let activateTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof window !== "undefined") {
      activateTimeoutId = setTimeout(() => {
        if (deps.wsActivateGuard.isSuperseded(myVersion)) return;
        const message = `Timed out switching worker after ${Math.round(deps.activateTimeoutMs / 1000)}s.`;
        deps.wsDebug("activate:timeout", { id, timeoutMs: deps.activateTimeoutMs });
        deps.setError(message);
        deps.updateWorkspaceConnectionState(id, { status: "error", message });
        deps.wsActivateGuard.exit(myVersion, deps.setConnectingWorkspaceId);
        deps.setBusy(false);
        deps.setBusyLabel(null);
        deps.setBusyStartedAt(null);
      }, deps.activateTimeoutMs);
    }

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    if (isSuperseded()) {
      deps.wsDebug("activate:superseded:early", { id });
      return false;
    }

    try {
      return await deps.runActivationBody({
        id,
        next,
        myVersion,
        isSuperseded,
        activateStart,
        activationOptions,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : deps.safeStringify(e);
      deps.setError(deps.addOpencodeCacheHint(message));
      deps.updateWorkspaceConnectionState(id, { status: "error", message });
      return false;
    } finally {
      if (activateTimeoutId !== null) {
        clearTimeout(activateTimeoutId);
      }
      deps.wsLog("[workspace:activate] FINALLY — clearing connectingWorkspaceId", {
        id,
        ms: Date.now() - activateStart,
      });
      deps.wsActivateGuard.exit(myVersion, deps.setConnectingWorkspaceId);
      deps.wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
  }

  return { activateWorkspace };
}
