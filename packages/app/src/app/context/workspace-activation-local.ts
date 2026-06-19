import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import { batch } from "solid-js";
import {
  workspaceSetActive,
  workspaceVesloRead,
} from "../lib/tauri";
import { isTauriRuntime } from "../utils";
import type { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";
import { isPassiveLocalBrowseActivationOrigin } from "./workspace-activation-controller";
import type { WorkspaceActivationOptions } from "./workspace-types";

export type LocalActivationSelection = {
  startedFromLocalMode: boolean;
  wasLocalConnection: boolean;
  nextRoot: string;
  oldWorkspacePath: string;
  oldWorkspaceScope: string;
  nextWorkspaceScope: string;
  actualEngineDir: string;
  actualEngineScope: string;
  workspaceChanged: boolean;
  displayedSessionCleared: boolean;
  passiveBrowseActivation: boolean;
  targetRuntimeReady: boolean;
};

export type WorkspaceLocalActivationDeps = {
  routingActive: () => unknown;
  startupPreference: () => unknown;
  setStartupPreference: (value: any) => void;
  projectDir: () => string;
  activeWorkspaceRoot: () => string;
  setProjectDir: (value: string) => void;
  authorizedDirs: () => string[];
  setAuthorizedDirs: (value: string[]) => void;
  setWorkspaces: (value: WorkspaceInfo[] | ((prev: WorkspaceInfo[]) => WorkspaceInfo[])) => void;
  syncActiveWorkspaceId: (id?: string) => void;
  normalizeWorkspaceScopePath: (
    value?: string | null,
    workspaceType?: WorkspaceInfo["workspaceType"] | null,
  ) => string;
  workspaceScopeChanged: (
    previous?: string | null,
    next?: string | null,
    workspaceType?: WorkspaceInfo["workspaceType"] | null,
  ) => boolean;
  engine: () => EngineInfo | null;
  resolveEngineRuntime: () => EngineInfo["runtime"];
  localRuntimeLifecycle: ReturnType<typeof createLocalRuntimeLifecycle>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  syncWorkspaceSkillMaterializationBeforeRuntime: (
    workspace: WorkspaceInfo,
    options: { reason: string },
  ) => Promise<boolean>;
  clearDisplayedSessionState: (
    reason:
      | "remote_to_local_workspace_changed"
      | "connect_workspace_scope_changed"
      | "local_browse_workspace_changed"
      | "open_empty_session",
    scope?: {
      workspaceId?: string | null;
      workspaceType?: WorkspaceInfo["workspaceType"] | null;
      previousDirectory?: string | null;
      nextDirectory?: string | null;
      activeWorkspaceRoot?: string | null;
      clearPendingPermissions?: boolean;
    },
  ) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  setWorkspaceConfig: (value: any) => void;
  setWorkspaceConfigLoaded: (value: boolean) => void;
  setEngineReady?: (value: boolean) => void;
  isWorkspaceRuntimeReady?: (workspaceId: string) => boolean;
  populateSidebarFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  hydrateLatestSessionFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  activateVesloHostWorkspace: (workspacePath: string) => Promise<void>;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  reportError: (error: unknown, context: string) => void;
  isSuperseded: () => boolean;
  activationOptions: WorkspaceActivationOptions;
  activateStart: number;
  workspaceIoTimeoutMs: number;
  workspaceSetActiveTimeoutMs: number;
  startHostTimeoutMs: number;
  withTimeoutOrThrow: typeof import("../utils/promise-timeout").withTimeoutOrThrow;
  indirectT: (key: string, locale?: any) => string;
  indirectLocale: () => any;
  safeStringify: (value: unknown) => string;
  addOpencodeCacheHint: (message: string) => string;
  wsDebug: (label: string, payload?: unknown) => void;
  wsLog: (msg: string, data?: unknown) => void;
};

type LocalRuntimeRestartResult = "ok" | "failed" | "superseded";

export function createWorkspaceLocalActivation(deps: WorkspaceLocalActivationDeps) {
  function prepareLocalWorkspaceSelection(id: string, next: WorkspaceInfo): LocalActivationSelection {
    const startedFromLocalMode = deps.startupPreference() === "local";
    const wasLocalConnection = startedFromLocalMode && Boolean(deps.routingActive());
    deps.setStartupPreference("local");
    const nextRoot = next.path;
    const previousProjectDir = deps.projectDir();
    const previousActiveWorkspaceRoot = deps.activeWorkspaceRoot().trim();
    const oldWorkspacePath = previousActiveWorkspaceRoot || previousProjectDir;
    const oldWorkspaceScope = deps.normalizeWorkspaceScopePath(oldWorkspacePath, "local");
    const previousProjectDirScope = deps.normalizeWorkspaceScopePath(previousProjectDir, "local");
    const nextWorkspaceScope = deps.normalizeWorkspaceScopePath(nextRoot, "local");
    const actualEngineDir = deps.engine()?.projectDir?.trim() ?? "";
    const actualEngineScope = deps.normalizeWorkspaceScopePath(actualEngineDir, "local");
    const passiveBrowseActivation = isPassiveLocalBrowseActivationOrigin(deps.activationOptions.origin);
    const targetRuntimeReady = Boolean(deps.isWorkspaceRuntimeReady?.(id));
    const projectDirOutOfSync =
      Boolean(previousProjectDirScope && oldWorkspaceScope) &&
      previousProjectDirScope !== oldWorkspaceScope;
    const workspaceChanged =
      deps.workspaceScopeChanged(oldWorkspacePath, nextRoot, "local") ||
      (actualEngineScope !== "" && actualEngineScope !== nextWorkspaceScope);

    deps.wsDebug("activate:local:prep", {
      id,
      nextRoot,
      nextWorkspaceScope,
      workspaceChanged,
      startedFromLocalMode,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: previousProjectDir,
      prevProjectDirScope: previousProjectDirScope || null,
      prevActiveWorkspaceRoot: previousActiveWorkspaceRoot || null,
      prevWorkspaceScope: oldWorkspaceScope,
      projectDirOutOfSync,
      actualEngineDir,
      actualEngineScope,
      passiveBrowseActivation,
      targetRuntimeReady,
    });
    if (projectDirOutOfSync) {
      deps.wsDebug("activate:local:projectDir-out-of-sync", {
        id,
        nextRoot,
        previousProjectDir,
        previousProjectDirScope,
        previousActiveWorkspaceRoot,
        previousActiveWorkspaceScope: oldWorkspaceScope,
      });
    }
    deps.wsLog("[workspace:activate] STEP 1 — syncActiveWorkspaceId + setProjectDir", {
      id,
      nextRoot,
      workspaceChanged,
      startedFromLocalMode,
      wasLocalConnection,
      actualEngineDir,
    });

    const displayedSessionCleared = workspaceChanged;
    if (displayedSessionCleared) {
      deps.clearDisplayedSessionState("connect_workspace_scope_changed", {
        workspaceId: id,
        workspaceType: "local",
        previousDirectory: oldWorkspacePath,
        nextDirectory: nextRoot,
        activeWorkspaceRoot: nextRoot,
        clearPendingPermissions: true,
      });
    }

    batch(() => {
      deps.syncActiveWorkspaceId(id);
      deps.setProjectDir(nextRoot);
    });

    if (targetRuntimeReady) {
      deps.setEngineReady?.(true);
    } else if (startedFromLocalMode && workspaceChanged && isTauriRuntime() && deps.populateSidebarFromDb) {
      deps.setEngineReady?.(false);
    }

    return {
      startedFromLocalMode,
      wasLocalConnection: Boolean(wasLocalConnection),
      nextRoot,
      oldWorkspacePath,
      oldWorkspaceScope,
      nextWorkspaceScope,
      actualEngineDir,
      actualEngineScope,
      workspaceChanged,
      displayedSessionCleared,
      passiveBrowseActivation,
      targetRuntimeReady,
    };
  }

  async function persistLocalWorkspaceSelection(
    id: string,
    next: WorkspaceInfo,
    selection: LocalActivationSelection,
  ) {
    if (isTauriRuntime()) {
      deps.setWorkspaceConfigLoaded(false);
      deps.wsLog("[workspace:activate] STEP 2 — workspaceVesloRead...", { path: next.path });
      try {
        const cfg = await deps.withTimeoutOrThrow(
          workspaceVesloRead({ workspacePath: next.path }),
          { timeoutMs: deps.workspaceIoTimeoutMs, label: "workspace_veslo_read" },
        );
        deps.wsLog("[workspace:activate] STEP 2 — workspaceVesloRead DONE");
        deps.setWorkspaceConfig(cfg);
        deps.setWorkspaceConfigLoaded(true);

        const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        deps.setAuthorizedDirs(roots.length ? roots : [next.path]);
      } catch (e) {
        deps.wsLog("[workspace:activate] STEP 2 — workspaceVesloRead FAILED", e instanceof Error ? e.message : String(e));
        deps.setWorkspaceConfig(null);
        deps.setWorkspaceConfigLoaded(true);
        deps.setAuthorizedDirs([next.path]);
      }

      if (deps.isSuperseded()) {
        deps.wsDebug("activate:superseded:before-local-set-active", { id });
        return false;
      }

      deps.wsLog("[workspace:activate] STEP 3 — workspaceSetActive...", { id });
      try {
        const ws = await deps.withTimeoutOrThrow(
          workspaceSetActive(id, { promoteToFront: deps.activationOptions?.promoteToFront ?? false }),
          { timeoutMs: deps.workspaceSetActiveTimeoutMs, label: "workspace_set_active" },
        );
        if (deps.isSuperseded()) {
          deps.wsDebug("activate:superseded:after-local-set-active", { id });
          return false;
        }
        deps.setWorkspaces(ws.workspaces);
        deps.syncActiveWorkspaceId(ws.activeId);
        if (selection.passiveBrowseActivation) {
          deps.wsDebug("activate:local:veslo-host-active:skip", {
            id,
            path: next.path,
            reason: "passive-browse",
          });
        } else {
          try {
            await deps.activateVesloHostWorkspace(next.path);
            deps.wsDebug("activate:local:veslo-host-active:done", { id, path: next.path });
          } catch (e) {
            deps.wsDebug("activate:local:veslo-host-active:failed", {
              id,
              path: next.path,
              error: e instanceof Error ? e.message : deps.safeStringify(e),
            });
          }
        }
        deps.wsLog("[workspace:activate] STEP 3 — workspaceSetActive DONE");
      } catch (e) {
        deps.wsLog("[workspace:activate] STEP 3 — workspaceSetActive FAILED", e instanceof Error ? e.message : String(e));
      }
    } else {
      if (!deps.authorizedDirs().includes(next.path)) {
        const merged = deps.authorizedDirs().length ? deps.authorizedDirs().slice() : [];
        if (!merged.includes(next.path)) merged.push(next.path);
        deps.setAuthorizedDirs(merged);
      }
    }
    return true;
  }

  async function reconnectRemoteToLocalHost(
    id: string,
    next: WorkspaceInfo,
    selection: LocalActivationSelection,
  ) {
    if (!deps.routingActive() || selection.wasLocalConnection || selection.startedFromLocalMode) return true;
    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:before-remote-to-local", { id });
      return false;
    }
    deps.wsLog("[workspace:activate] STEP 4a — remote→local reconnect path");
    deps.wsDebug("activate:remote->local:reconnect", {
      id,
      nextPath: next.path,
      engine: deps.engine()?.baseUrl ?? null,
      engineRunning: Boolean(deps.engine()?.running),
    });
    if (selection.workspaceChanged && !selection.displayedSessionCleared) {
      deps.clearDisplayedSessionState("remote_to_local_workspace_changed", {
        workspaceId: id,
        workspaceType: "local",
        previousDirectory: selection.oldWorkspacePath,
        nextDirectory: selection.nextRoot,
        activeWorkspaceRoot: selection.nextRoot,
        clearPendingPermissions: true,
      });
    } else {
      deps.wsDebug("ui-reset:displayed-session:skip", {
        reason: "remote_to_local_same_workspace_scope",
        workspaceId: id,
        previousDirectory: selection.oldWorkspacePath,
        nextDirectory: selection.nextRoot,
        previousDirectoryNormalized: selection.oldWorkspaceScope,
        nextDirectoryNormalized: selection.nextWorkspaceScope,
      });
    }

    let connectedToLocalHost = false;
    const existingEngine = deps.engine();
    const runtime = existingEngine?.runtime ?? deps.resolveEngineRuntime();
    const canReuseHost =
      isTauriRuntime() &&
      Boolean(existingEngine?.running && existingEngine.baseUrl);

    deps.wsDebug("activate:remote->local:hostReuse", {
      canReuseHost,
      runtime,
      existingEngineBaseUrl: existingEngine?.baseUrl ?? null,
      existingEngineProjectDir: existingEngine?.projectDir ?? null,
    });

    if (canReuseHost && runtime === "veslo-orchestrator") {
      try {
        const reuseStart = Date.now();
        deps.wsLog("[workspace:activate] STEP 4a.1 — localRuntimeLifecycle.reattachOrchestratorWorkspace...", {
          path: next.path,
        });
        connectedToLocalHost = await deps.localRuntimeLifecycle.reattachOrchestratorWorkspace({
          workspacePath: next.path,
          workspaceId: next.id,
          workspaceName: next.displayName?.trim() || next.name?.trim() || null,
          reason: "workspace-attach-local",
          navigate: false,
        });
        deps.wsDebug("activate:remote->local:reuseHost:done", {
          ok: connectedToLocalHost,
          ms: Date.now() - reuseStart,
        });
      } catch {
        connectedToLocalHost = false;
        deps.wsDebug("activate:remote->local:reuseHost:error");
      }
    }

    if (!connectedToLocalHost) {
      deps.wsLog("[workspace:activate] STEP 4a.5 — startHost (no reuse)...", { path: next.path });
      const startHostAt = Date.now();
      const ok = await deps.withTimeoutOrThrow(
        deps.startHost({ workspacePath: next.path, navigate: false }),
        { timeoutMs: deps.startHostTimeoutMs, label: "startHost" },
      );
      deps.wsLog("[workspace:activate] STEP 4a.5 — startHost DONE", { ok, ms: Date.now() - startHostAt });
      deps.wsDebug("activate:remote->local:startHost:done", { ok, ms: Date.now() - startHostAt });
      if (!ok) {
        deps.updateWorkspaceConnectionState(id, {
          status: "error",
          message: deps.indirectT("ui.indirect.failed_to_start_local_engine_1uglec", deps.indirectLocale()),
        });
        return false;
      }
    }
    return true;
  }

  async function enterLocalBrowseMode(
    id: string,
    next: WorkspaceInfo,
    selection: LocalActivationSelection,
  ) {
    const enginePresentForActiveWorkspace = Boolean(
      deps.engine()?.baseUrl?.trim() &&
        deps.normalizeWorkspaceScopePath(deps.engine()?.projectDir?.trim() ?? "", "local") ===
          deps.normalizeWorkspaceScopePath(next.path, "local"),
    );
    const needsEngineWarmup = !selection.workspaceChanged && !enginePresentForActiveWorkspace;
    const canBrowseOffline =
      (selection.workspaceChanged || needsEngineWarmup) && isTauriRuntime() && deps.populateSidebarFromDb;
    const isColdBoot = !deps.routingActive() && deps.startupPreference() === "local";
    if (
      !canBrowseOffline ||
      !selection.passiveBrowseActivation ||
      !(selection.startedFromLocalMode || selection.wasLocalConnection || isColdBoot || needsEngineWarmup)
    ) {
      return false;
    }

    deps.wsLog("[workspace:activate] STEP 5-BROWSE — browsing mode, loading from SQLite", { id, path: next.path });
    deps.wsDebug("activate:local->local:browsingMode", { id, nextPath: next.path });

    deps.setEngineReady?.(selection.targetRuntimeReady);
    if (selection.workspaceChanged && !selection.displayedSessionCleared) {
      deps.clearDisplayedSessionState("local_browse_workspace_changed", {
        workspaceId: id,
        workspaceType: "local",
        previousDirectory: selection.oldWorkspacePath,
        nextDirectory: selection.nextRoot,
        activeWorkspaceRoot: selection.nextRoot,
        clearPendingPermissions: true,
      });
    }

    try {
      await deps.populateSidebarFromDb!(id, next.path);
    } catch (e) {
      deps.wsLog("[workspace:activate] STEP 5-BROWSE — populateSidebarFromDb failed", e);
    }

    deps.wsDebug("activate:local->local:browsingMode:skipLatestHydration", {
      id,
      reason: "title-only-browse",
    });

    deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
    deps.wsDebug("activate:local->local:browsingMode:done", { id, ms: Date.now() - deps.activateStart });
    return true;
  }

  async function restartLocalRuntimeForSwitch(
    id: string,
    next: WorkspaceInfo,
    selection: LocalActivationSelection,
  ): Promise<LocalRuntimeRestartResult> {
    if (!selection.wasLocalConnection || !selection.workspaceChanged) return "ok";
    if (deps.isSuperseded()) {
      deps.wsDebug("activate:superseded:before-engine-restart", { id });
      return "superseded";
    }
    deps.wsLog("[workspace:activate] STEP 5 — local→local engine restart", { id, path: next.path });
    deps.wsDebug("activate:local->local:restartEngine", { id, nextPath: next.path });
    deps.setError(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.restarting_engine");
    deps.setBusyStartedAt(Date.now());

    try {
      const skillsReady = await deps.syncWorkspaceSkillMaterializationBeforeRuntime(next, {
        reason: "workspace-restart",
      });
      if (!skillsReady) return "failed";
      const runtime = deps.resolveEngineRuntime();
      deps.wsLog("[workspace:activate] STEP 5 — runtime =", runtime);
      deps.wsLog("[workspace:activate] STEP 5.1 — localRuntimeLifecycle.restartWorkspaceRuntime...", {
        path: next.path,
        runtime,
      });
      const ok = await deps.localRuntimeLifecycle.restartWorkspaceRuntime({
        workspacePath: next.path,
        workspaceId: next.id,
        workspaceName: next.displayName?.trim() || next.name?.trim() || null,
        reason: runtime === "veslo-orchestrator" ? "workspace-orchestrator-switch" : "workspace-restart",
        navigate: false,
      });
      if (!ok) {
        deps.setError("Failed to reconnect after worker switch");
        return "failed";
      }
      return "ok";
    } catch (e) {
      const message = e instanceof Error ? e.message : deps.safeStringify(e);
      deps.setError(deps.addOpencodeCacheHint(message));
      return "failed";
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function activateLocalWorkspace(
    id: string,
    next: WorkspaceInfo,
  ) {
    const selection = prepareLocalWorkspaceSelection(id, next);
    if (!(await persistLocalWorkspaceSelection(id, next, selection))) return false;

    deps.wsLog("[workspace:activate] STEP 4 — branch decision", {
      isRemote: false,
      hasClient: Boolean(deps.routingActive()),
      startedFromLocalMode: selection.startedFromLocalMode,
      wasLocalConnection: selection.wasLocalConnection,
      workspaceChanged: selection.workspaceChanged,
    });

    if (!(await reconnectRemoteToLocalHost(id, next, selection))) return false;
    if (await enterLocalBrowseMode(id, next, selection)) return true;

    const restartResult = await restartLocalRuntimeForSwitch(id, next, selection);
    if (restartResult === "superseded") return false;
    if (restartResult === "failed") {
      deps.wsLog("[workspace:activate] STEP 6 — engineRestartFailed!", { id, ms: Date.now() - deps.activateStart });
      deps.updateWorkspaceConnectionState(id, {
        status: "error",
        message: deps.indirectT("ui.indirect.failed_to_switch_worker_ayyxrj", deps.indirectLocale()),
      });
      deps.wsDebug("activate:local:engineRestartFailed", { id, ms: Date.now() - deps.activateStart });
      return false;
    }

    deps.wsLog("[workspace:activate] STEP 6 — SUCCESS, refreshing skills/plugins", { id, ms: Date.now() - deps.activateStart });
    deps.refreshSkills({ force: true }).catch(e => deps.reportError(e, "workspace.refreshSkills"));
    deps.refreshPlugins().catch(e => deps.reportError(e, "workspace.refreshPlugins"));
    deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
    deps.wsDebug("activate:local:done", { id, ms: Date.now() - deps.activateStart });
    return true;
  }

  return {
    activateLocalWorkspace,
    prepareLocalWorkspaceSelection,
    reconnectRemoteToLocalHost,
    enterLocalBrowseMode,
    restartLocalRuntimeForSwitch,
  };
}
