import { homeDir } from "@tauri-apps/api/path";

import type { DashboardTab, View, WorkspaceConnectionState, WorkspacePreset } from "../types";
import {
  addOpencodeCacheHint,
  isPrivateWorkspacePathForRoot,
  isTauriRuntime,
  normalizeDirectoryPath,
  safeStringify,
} from "../utils";
import { t, currentLocale } from "../../i18n";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import {
  pickDirectory,
  workspaceCreate,
  workspaceForget,
  workspacePrivateRoot,
  workspaceUpdateDisplayName,
  type WorkspaceInfo,
} from "../lib/tauri";
import type { WorkspaceRouting } from "./workspace-routing";
import type { WorkspaceActivationOptions } from "./workspace-types";

export type WorkspaceLocalWorkspacesDeps = {
  workspaces: () => WorkspaceInfo[];
  setWorkspaces: (value: WorkspaceInfo[] | ((prev: WorkspaceInfo[]) => WorkspaceInfo[])) => void;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  activeWorkspaceInfo: () => WorkspaceInfo | null;
  privateWorkspaceRoot: () => string;
  setPrivateWorkspaceRoot: (value: string) => void;
  syncActiveWorkspaceId: (id?: string) => void;
  routing: WorkspaceRouting;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  openSessionState: {
    loadSessions: (scopeRoot?: string) => Promise<void>;
    setView: (value: View) => void;
    setTab: (value: DashboardTab) => void;
  };
  clearDisplayedSessionState: (
    reason: "remote_to_local_workspace_changed" | "connect_workspace_scope_changed" | "open_empty_session",
    scope?: {
      workspaceId?: string | null;
      workspaceType?: WorkspaceInfo["workspaceType"] | null;
      previousDirectory?: string | null;
      nextDirectory?: string | null;
      activeWorkspaceRoot?: string | null;
      clearPendingPermissions?: boolean;
    },
  ) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: Partial<WorkspaceConnectionState>) => void;
  clearWorkspaceConnectionState: (workspaceId: string) => void;
  setProjectDir: (value: string) => void;
  setCreateWorkspaceOpen: (value: boolean) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  markOnboardingComplete: () => void;
  makeRunId: () => string;
  blockLocalAction: (code: string, detail: string) => boolean;
};

export function createWorkspaceLocalWorkspaces(deps: WorkspaceLocalWorkspacesDeps) {
  const buildPrivateWorkspaceRoot = async () => {
    const cached = deps.privateWorkspaceRoot().trim();
    if (cached) return cached;
    if (!isTauriRuntime()) return "";
    const next = (await workspacePrivateRoot()).replace(/[\\/]+$/, "");
    deps.setPrivateWorkspaceRoot(next);
    return next;
  };

  const openEmptySession = async (scopeRoot?: string) => {
    const root = (scopeRoot ?? deps.activeWorkspaceRoot().trim()).trim();
    if (deps.routing.active()) {
      try {
        await deps.openSessionState.loadSessions(root || undefined);
      } catch {
        // If session loading fails, still fall back to an empty session draft view.
      }
    }
    deps.clearDisplayedSessionState("open_empty_session", {
      workspaceId: deps.activeWorkspaceId().trim(),
      workspaceType: deps.activeWorkspaceInfo()?.workspaceType ?? null,
      nextDirectory: root || null,
      activeWorkspaceRoot: root || deps.activeWorkspaceRoot().trim(),
      clearPendingPermissions: true,
    });
    deps.openSessionState.setView("session");
  };

  const activateFreshLocalWorkspace = async (workspaceId: string | null, workspacePath: string) => {
    if (!workspaceId) {
      await openEmptySession(workspacePath);
      return true;
    }
    const hasClient = Boolean(deps.routing.client(workspaceId));
    const ok = hasClient
      ? await deps.activateWorkspace(workspaceId, { origin: "workspace:activate-fresh-local" })
      : await deps.startHost({ workspacePath, navigate: false });
    if (!ok) return false;
    await openEmptySession(deps.activeWorkspaceRoot().trim() || workspacePath);
    return true;
  };

  async function createLocalWorkspace(
    preset: WorkspacePreset,
    folder: string | null,
    flowOptions?: {
      markOnboardingComplete?: boolean;
      navigateToDashboard?: boolean;
      closeModal?: boolean;
      workspaceName?: string | null;
    },
  ) {
    if (CLOUD_ONLY_MODE) {
      deps.blockLocalAction("cloud_only_local_disabled", "Local workspace creation is disabled.");
      return null;
    }

    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    if (!folder) {
      deps.setError(t("app.error.choose_folder", currentLocale()));
      return null;
    }

    deps.setBusy(true);
    deps.setBusyLabel("status.creating_workspace");
    deps.setBusyStartedAt(Date.now());
    deps.setError(null);

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        deps.setError(t("app.error.choose_folder", currentLocale()));
        return null;
      }

      const explicitName = flowOptions?.workspaceName?.trim() ?? "";
      const name =
        explicitName ||
        resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
        "Workspace";
      const ws = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      deps.setWorkspaces(ws.workspaces);
      deps.syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;

      if (flowOptions?.closeModal !== false) {
        deps.setCreateWorkspaceOpen(false);
      }
      if (flowOptions?.navigateToDashboard !== false) {
        deps.openSessionState.setTab("scheduled");
        deps.openSessionState.setView("dashboard");
      }
      if (flowOptions?.markOnboardingComplete !== false) {
        deps.markOnboardingComplete();
      }
      return active;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      return null;
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null) {
    const created = await createLocalWorkspace(preset, folder, {
      markOnboardingComplete: false,
      navigateToDashboard: false,
      closeModal: true,
    });
    if (!created) return;
    const opened = await activateFreshLocalWorkspace(created.id ?? null, created.path);
    if (!opened) {
      const message = "Workspace was created, but the local runtime did not start.";
      deps.updateWorkspaceConnectionState(created.id, { status: "error", message });
      return;
    }
    deps.markOnboardingComplete();
  }

  async function createScratchWorkspace() {
    if (CLOUD_ONLY_MODE) {
      deps.blockLocalAction("cloud_only_local_disabled", "Local workspace creation is disabled.");
      return null;
    }
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    const root = await buildPrivateWorkspaceRoot();
    if (!root) {
      deps.setError("Failed to resolve private workspace root.");
      return null;
    }

    const name = "Private workspace";
    const runId = deps.makeRunId().replace(/[^a-z0-9-]+/gi, "").slice(0, 24) || `${Date.now()}`;
    const folder = `${root}/${Date.now()}-${runId}`;
    return await createLocalWorkspace("starter", folder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: false,
      workspaceName: name,
    });
  }

  const findLocalWorkspaceByPath = (folder: string) => {
    const normalized = normalizeDirectoryPath(folder);
    if (!normalized) return null;
    return deps.workspaces().find(
      (workspace) =>
        workspace.workspaceType === "local" &&
        normalizeDirectoryPath(workspace.path?.trim() ?? "") === normalized,
    ) ?? null;
  };

  async function ensureWorkspaceForFolder(folder: string) {
    const resolvedFolder = await resolveWorkspacePath(folder);
    if (!resolvedFolder) {
      deps.setError(t("app.error.choose_folder", currentLocale()));
      return null;
    }

    const existing = findLocalWorkspaceByPath(resolvedFolder);
    if (existing) {
      deps.setWorkspaces((prev) => {
        const rest = prev.filter((workspace) => workspace.id !== existing.id);
        return [existing, ...rest];
      });
      return existing;
    }

    return await createLocalWorkspace("starter", resolvedFolder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: false,
    });
  }

  const isPrivateWorkspacePath = (folder: string | null | undefined) => {
    return isPrivateWorkspacePathForRoot(folder, deps.privateWorkspaceRoot());
  };

  async function ensureLocalWorkspaceActive(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const activated = await deps.activateWorkspace(id, { origin: "workspace:ensure-local-active" });
    if (activated === false) return false;
    if (deps.routing.client(id)) return true;

    const workspace = deps.workspaces().find((entry) => entry.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "local") {
      deps.setError("Local workspace is not available.");
      return false;
    }
    if (workspace.missing) {
      deps.setError("Workspace folder no longer exists. Remove it from Veslo or choose the folder again.");
      return false;
    }

    const started = await deps.startHost({ workspacePath: workspace.path, navigate: false });
    if (!started) return false;
    return Boolean(deps.routing.client(id));
  }

  async function forgetWorkspace(
    workspaceId: string,
    forgetOptions?: { deleteLocalData?: boolean },
  ): Promise<boolean> {
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    const id = workspaceId.trim();
    if (!id) return false;

    try {
      const previousActive = deps.activeWorkspaceId();
      const mode = forgetOptions?.deleteLocalData ? "delete_local_data" : "detach_only";
      const ws = await workspaceForget(id, mode);
      deps.setWorkspaces(ws.workspaces);
      deps.clearWorkspaceConnectionState(id);
      deps.syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        deps.setProjectDir(active.workspaceType === "remote" ? active.directory?.trim() ?? "" : active.path);
      }

      if (ws.activeId && ws.activeId !== previousActive) {
        const activated = await deps.activateWorkspace(ws.activeId, { origin: "workspace:forget-next-active" });
        if (!activated) return false;
      }
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    }
  }

  async function pickWorkspaceFolder(defaultPath?: string | null) {
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    try {
      const preferredPath = defaultPath?.trim() ?? "";
      const selection = await pickDirectory({
        title: t("onboarding.choose_workspace_folder", currentLocale()),
        defaultPath: preferredPath || undefined,
      });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      return folder ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      return null;
    }
  }

  async function updateWorkspaceDisplayName(workspaceId: string, displayName: string | null) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = deps.workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const nextDisplayName = displayName?.trim() || null;
    deps.setError(null);

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
        deps.setWorkspaces(ws.workspaces);
        if (ws.activeId) {
          deps.updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
        }
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        deps.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    deps.setWorkspaces((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              displayName: nextDisplayName,
              name: nextDisplayName ?? entry.name,
            }
          : entry
      )
    );
    return true;
  }

  function normalizeRoots(list: string[]) {
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  async function resolveWorkspacePath(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return "";
    if (!isTauriRuntime()) return trimmed;

    if (trimmed === "~") {
      try {
        return (await homeDir()).replace(/[\\/]+$/, "");
      } catch {
        return trimmed;
      }
    }

    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      try {
        const home = (await homeDir()).replace(/[\\/]+$/, "");
        return `${home}${trimmed.slice(1)}`;
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  return {
    openEmptySession,
    activateFreshLocalWorkspace,
    createWorkspaceFlow,
    createScratchWorkspace,
    ensureLocalWorkspaceActive,
    ensureWorkspaceForFolder,
    forgetWorkspace,
    pickWorkspaceFolder,
    updateWorkspaceDisplayName,
    normalizeRoots,
    resolveWorkspacePath,
    isPrivateWorkspacePath,
    buildPrivateWorkspaceRoot,
  };
}
