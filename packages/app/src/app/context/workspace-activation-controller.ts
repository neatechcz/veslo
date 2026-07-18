import type { WorkspaceConnectionState, StartupPreference } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import type { WorkspaceActivationOptions } from "./workspace-types";

export type WorkspaceSwitchOverlayTarget = {
  workspaceId: string;
  version: number;
};

const NON_BLOCKING_LOCAL_BROWSE_ORIGINS = new Set([
  "app:new-private-existing-pending-draft",
  "app:new-private-scratch-workspace",
  "app:open-directory-session-from-picker",
  "app:open-pending-directory-draft-workspace",
  "composer-target:chat",
  "composer-target:create-private",
  "composer-target:workspace",
  "dashboard:open-soul-workspace",
  "send-target:selected-session-workspace",
  "session-navigation:open-session-before-open",
  "session-navigation:open-pending-draft",
  "session:open-soul-workspace",
  "workspace-session-list:project-open",
]);

export function isPassiveLocalBrowseActivationOrigin(origin?: string | null) {
  return NON_BLOCKING_LOCAL_BROWSE_ORIGINS.has(origin?.trim() ?? "");
}

export type WorkspaceBrowsePolicyStore = {
  workspaces: () => Array<Pick<WorkspaceInfo, "id" | "workspaceType">>;
  browseWorkspace: (
    workspaceId: string | undefined,
    options: WorkspaceActivationOptions,
  ) => Promise<boolean>;
  activateWorkspace: (
    workspaceId: string | undefined,
    options: WorkspaceActivationOptions,
  ) => Promise<boolean>;
};

export async function activateWorkspaceWithBrowsePolicy(
  store: WorkspaceBrowsePolicyStore,
  workspaceId: string | undefined,
  options: WorkspaceActivationOptions,
) {
  const id = workspaceId?.trim() ?? "";
  if (!id) return false;

  if (!isPassiveLocalBrowseActivationOrigin(options.origin)) {
    return await store.activateWorkspace(id, options);
  }

  const target = store.workspaces().find((workspace) => workspace.id === id) ?? null;
  if (!target) return false;

  if (target.workspaceType === "local") {
    return await store.browseWorkspace(id, options);
  }

  return await store.activateWorkspace(id, options);
}

export function shouldSuppressWorkspaceSwitchOverlayForActivation(input: {
  workspaceType?: WorkspaceInfo["workspaceType"] | null;
  origin?: string | null;
  promoteToFront?: boolean;
  blockingOverlay?: boolean;
}) {
  return !shouldShowBlockingWorkspaceOverlayForActivation(input);
}

export function shouldShowBlockingWorkspaceOverlayForActivation(input: {
  workspaceType?: WorkspaceInfo["workspaceType"] | null;
  origin?: string | null;
  promoteToFront?: boolean;
  blockingOverlay?: boolean;
}) {
  if (input.blockingOverlay !== undefined) return input.blockingOverlay;
  return input.workspaceType === "remote";
}

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
  startupPreference: () => StartupPreference | null;
  hasActiveRoute: () => boolean;
  setConnectingWorkspaceId: (
    value: string | null | ((prev: string | null) => string | null),
  ) => void;
  setWorkspaceSwitchOverlaySuppressionToken?: (
    value: string | null | ((prev: string | null) => string | null),
  ) => void;
  setWorkspaceSwitchOverlayTarget?: (
    value:
      | WorkspaceSwitchOverlayTarget
      | null
      | ((prev: WorkspaceSwitchOverlayTarget | null) => WorkspaceSwitchOverlayTarget | null),
  ) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: Partial<WorkspaceConnectionState>) => void;
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
    const overlaySuppressionToken = shouldSuppressWorkspaceSwitchOverlayForActivation({
      workspaceType: next.workspaceType,
      origin: activationOptions.origin,
      promoteToFront: activationOptions.promoteToFront,
      blockingOverlay: activationOptions.blockingOverlay,
    })
      ? `${id}:${myVersion}`
      : "";
    const overlayTarget = overlaySuppressionToken
      ? null
      : {
          workspaceId: id,
          version: myVersion,
        };
    const clearOverlaySuppressionToken = () => {
      if (!overlaySuppressionToken) return;
      deps.setWorkspaceSwitchOverlaySuppressionToken?.((current) =>
        current === overlaySuppressionToken ? null : current,
      );
    };
    const clearOverlayTarget = () => {
      if (!overlayTarget) return;
      deps.setWorkspaceSwitchOverlayTarget?.((current) =>
        current?.version === overlayTarget.version ? null : current,
      );
    };

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
    if (overlayTarget) {
      deps.setWorkspaceSwitchOverlayTarget?.(overlayTarget);
      deps.wsDebug("activate:overlay:blocking", {
        id: next.id,
        origin: activationOptions.origin,
        version: myVersion,
      });
    }
    if (overlaySuppressionToken) {
      deps.setWorkspaceSwitchOverlaySuppressionToken?.(overlaySuppressionToken);
      deps.wsDebug("activate:overlay:suppressed", {
        id: next.id,
        origin: activationOptions.origin,
        token: overlaySuppressionToken,
      });
    }
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
        clearOverlaySuppressionToken();
        clearOverlayTarget();
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
      clearOverlaySuppressionToken();
      clearOverlayTarget();
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
      clearOverlaySuppressionToken();
      clearOverlayTarget();
      deps.wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
  }

  return { activateWorkspace };
}
