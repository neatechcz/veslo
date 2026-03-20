import { createSignal } from "solid-js";

import type { WorkspaceVesloConfig } from "../types";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
  safeStringify,
} from "../utils";
import { reportError } from "../lib/error-reporter";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import { t, currentLocale } from "../../i18n";
import { downloadDir } from "@tauri-apps/api/path";
import {
  opencodeDbMigrate,
  pickFile,
  pickDirectory,
  saveFile,
  workspaceExportConfig,
  workspaceImportConfig,
  workspaceVesloWrite,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";

export type MigrationRepairResult = {
  ok: boolean;
  message: string;
};

export interface ConfigStoreDeps {
  getActiveWorkspacePath: () => string;
  getActiveWorkspaceInfo: () => WorkspaceInfo | null | undefined;
  getWorkspaces: () => WorkspaceInfo[];
  setWorkspaces: (ws: WorkspaceInfo[]) => void;
  getWorkspaceConfig: () => WorkspaceVesloConfig | null;
  setWorkspaceConfig: (config: WorkspaceVesloConfig) => void;
  getAuthorizedDirs: () => string[];
  setAuthorizedDirs: (dirs: string[]) => void;
  getEngine: () => EngineInfo | null;
  setEngine: (info: EngineInfo | null) => void;
  syncActiveWorkspaceId: (id: string | undefined) => void;
  setCreateWorkspaceOpen: (open: boolean) => void;
  setCreateRemoteWorkspaceOpen: (open: boolean) => void;
  markOnboardingComplete: () => void;
  activateFreshLocalWorkspace: (id: string | null, folder: string) => Promise<boolean>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  engineSource: () => string;
  engineCustomBinPath?: () => string;
  engineStop: () => Promise<EngineInfo>;
  setError: (msg: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setStartupPreference: (value: any) => void;
  setOnboardingStep: (step: any) => void;
  blockLocalAction: (code: string, detail: string) => boolean;
  normalizeRoots: (roots: string[]) => string[];
  resolveWorkspacePath: (path: string) => Promise<string>;
  formatExecOutput: (result: { stdout: string; stderr: string }) => string;
  isDbMigrateUnsupported: (output: string) => boolean;
  cloudOnlyMessage: (code: string, detail: string) => string;
}

export function createConfigStore(deps: ConfigStoreDeps) {
  const [exportingWorkspaceConfig, setExportingWorkspaceConfig] = createSignal(false);
  const [importingWorkspaceConfig, setImportingWorkspaceConfig] = createSignal(false);
  const [migrationRepairBusy, setMigrationRepairBusy] = createSignal(false);
  const [migrationRepairResult, setMigrationRepairResult] = createSignal<MigrationRepairResult | null>(null);
  const [newAuthorizedDir, setNewAuthorizedDir] = createSignal("");

  async function exportWorkspaceConfig(workspaceId?: string) {
    if (exportingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const targetId = workspaceId?.trim() || deps.getActiveWorkspaceInfo()?.id || "";
    if (!targetId) {
      deps.setError("Select a worker to export");
      return;
    }
    const target = deps.getWorkspaces().find((ws) => ws.id === targetId) ?? null;
    if (!target) {
      deps.setError("Unknown worker");
      return;
    }
    if (target.workspaceType === "remote") {
      deps.setError("Export is only supported for local workers");
      return;
    }

    setExportingWorkspaceConfig(true);
    deps.setError(null);

    try {
      const nameBase = (target.displayName || target.name || "worker")
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const fileName = `veslo-${nameBase || "worker"}-${dateStamp}.veslo-workspace`;
      const downloads = await downloadDir().catch((e: unknown) => { reportError(e, "workspace.downloadDir"); return null; });
      const defaultPath = downloads ? `${downloads}/${fileName}` : fileName;

      const outputPath = await saveFile({
        title: "Export worker config",
        defaultPath,
        filters: [{ name: "Veslo Worker", extensions: ["veslo-workspace", "zip"] }],
      });

      if (!outputPath) {
        return;
      }

      await workspaceExportConfig({
        workspaceId: target.id,
        outputPath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    } finally {
      setExportingWorkspaceConfig(false);
    }
  }

  async function importWorkspaceConfig() {
    if (importingWorkspaceConfig()) return;
    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    setImportingWorkspaceConfig(true);
    deps.setError(null);

    try {
      const selection = await pickFile({
        title: "Import worker config",
        filters: [{ name: "Veslo Worker", extensions: ["veslo-workspace", "zip"] }],
      });
      const filePath =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!filePath) return;

      const target = await pickDirectory({
        title: "Choose a worker folder",
      });
      const folder =
        typeof target === "string" ? target : Array.isArray(target) ? target[0] : null;
      if (!folder) return;

      const resolvedFolder = await deps.resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        deps.setError(t("app.error.choose_folder", currentLocale()));
        return;
      }

      const ws = await workspaceImportConfig({
        archivePath: filePath,
        targetDir: resolvedFolder,
      });

      deps.setWorkspaces(ws.workspaces);
      deps.syncActiveWorkspaceId(ws.activeId);
      deps.setCreateWorkspaceOpen(false);
      deps.setCreateRemoteWorkspaceOpen(false);
      deps.markOnboardingComplete();

      const opened = await deps.activateFreshLocalWorkspace(ws.activeId ?? null, resolvedFolder);
      if (!opened) {
        return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    } finally {
      setImportingWorkspaceConfig(false);
    }
  }

  function canRepairOpencodeMigration() {
    if (CLOUD_ONLY_MODE) return false;
    if (!isTauriRuntime()) return false;
    const workspace = deps.getActiveWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") return false;
    return Boolean(deps.getActiveWorkspacePath().trim());
  }

  async function repairOpencodeMigration(optionsOverride?: { navigate?: boolean }) {
    if (CLOUD_ONLY_MODE) {
      const message = deps.cloudOnlyMessage("cloud_only_local_disabled", "Local migration repair is disabled.");
      setMigrationRepairResult({ ok: false, message });
      deps.setError(message);
      return false;
    }

    if (!isTauriRuntime()) {
      const message = t("app.migration.desktop_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      deps.setError(message);
      return false;
    }

    if (migrationRepairBusy()) return false;

    const workspace = deps.getActiveWorkspaceInfo();
    if (!workspace || workspace.workspaceType !== "local") {
      const message = t("app.migration.local_only", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      deps.setError(message);
      return false;
    }

    const root = deps.getActiveWorkspacePath().trim();
    if (!root) {
      const message = t("app.migration.workspace_required", currentLocale());
      setMigrationRepairResult({ ok: false, message });
      deps.setError(message);
      return false;
    }

    setMigrationRepairBusy(true);
    setMigrationRepairResult(null);
    deps.setError(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.repairing_migration");
    deps.setBusyStartedAt(Date.now());

    try {
      if (deps.getEngine()?.running) {
        const info = await deps.engineStop();
        deps.setEngine(info);
      }

      const source = deps.engineSource();
      const result = await opencodeDbMigrate({
        projectDir: root,
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
      });

      if (!result.ok) {
        const output = deps.formatExecOutput(result);
        if (deps.isDbMigrateUnsupported(output)) {
          const message = t("app.migration.unsupported", currentLocale());
          setMigrationRepairResult({ ok: false, message });
          deps.setError(message);
          return false;
        }

        const fallback = t("app.migration.failed", currentLocale());
        const message = output ? `${fallback}\n\n${output}` : fallback;
        setMigrationRepairResult({ ok: false, message });
        deps.setError(addOpencodeCacheHint(message));
        return false;
      }

      const started = await deps.startHost({
        workspacePath: root,
        navigate: optionsOverride?.navigate ?? false,
      });
      if (!started) {
        const message = t("app.migration.restart_failed", currentLocale());
        setMigrationRepairResult({ ok: false, message });
        return false;
      }

      setMigrationRepairResult({ ok: true, message: t("app.migration.success", currentLocale()) });
      return true;
    } catch (error) {
      const message = addOpencodeCacheHint(error instanceof Error ? error.message : safeStringify(error));
      setMigrationRepairResult({ ok: false, message });
      deps.setError(message);
      return false;
    } finally {
      setMigrationRepairBusy(false);
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function onRepairOpencodeMigration() {
    if (CLOUD_ONLY_MODE) {
      deps.setStartupPreference("server");
      deps.setOnboardingStep("server");
      deps.blockLocalAction("cloud_only_local_disabled", "Local migration repair is disabled.");
      return;
    }

    deps.setStartupPreference("local");
    deps.setOnboardingStep("connecting");
    const ok = await repairOpencodeMigration({ navigate: true });
    if (!ok) {
      deps.setOnboardingStep("local");
    }
  }

  async function persistAuthorizedRoots(nextRoots: string[]) {
    if (!isTauriRuntime()) return;
    if (deps.getActiveWorkspaceInfo()?.workspaceType === "remote") return;
    const root = deps.getActiveWorkspacePath().trim();
    if (!root) return;

    const existing = deps.getWorkspaceConfig();
    const cfg: WorkspaceVesloConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: nextRoots,
      reload: existing?.reload ?? null,
    };

    await workspaceVesloWrite({ workspacePath: root, config: cfg });
    deps.setWorkspaceConfig(cfg);
  }

  async function persistReloadSettings(next: { auto?: boolean; resume?: boolean }) {
    if (!isTauriRuntime()) return;
    if (deps.getActiveWorkspaceInfo()?.workspaceType === "remote") return;
    const root = deps.getActiveWorkspacePath().trim();
    if (!root) return;

    const existing = deps.getWorkspaceConfig();
    const cfg: WorkspaceVesloConfig = {
      version: existing?.version ?? 1,
      workspace: existing?.workspace ?? null,
      authorizedRoots: Array.isArray(existing?.authorizedRoots) ? existing!.authorizedRoots : deps.getAuthorizedDirs(),
      reload: {
        auto: Boolean(next.auto),
        resume: Boolean(next.resume),
      },
    };

    await workspaceVesloWrite({ workspacePath: root, config: cfg });
    deps.setWorkspaceConfig(cfg);
  }

  async function addAuthorizedDir() {
    if (deps.getActiveWorkspaceInfo()?.workspaceType === "remote") return;
    const next = newAuthorizedDir().trim();
    if (!next) return;

    const roots = deps.normalizeRoots([...deps.getAuthorizedDirs(), next]);
    deps.setAuthorizedDirs(roots);
    setNewAuthorizedDir("");

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    }
  }

  async function addAuthorizedDirFromPicker(optionsOverride?: { persistToWorkspace?: boolean }) {
    if (!isTauriRuntime()) return;
    if (deps.getActiveWorkspaceInfo()?.workspaceType === "remote") return;

    try {
      const selection = await pickDirectory({ title: t("onboarding.authorize_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!folder) return;

      const roots = deps.normalizeRoots([...deps.getAuthorizedDirs(), folder]);
      deps.setAuthorizedDirs(roots);

      if (optionsOverride?.persistToWorkspace) {
        await persistAuthorizedRoots(roots);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    }
  }

  async function removeAuthorizedDir(dir: string) {
    if (deps.getActiveWorkspaceInfo()?.workspaceType === "remote") return;
    const roots = deps.normalizeRoots(deps.getAuthorizedDirs().filter((root) => root !== dir));
    deps.setAuthorizedDirs(roots);

    try {
      await persistAuthorizedRoots(roots);
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    }
  }

  function removeAuthorizedDirAtIndex(index: number) {
    const roots = deps.getAuthorizedDirs();
    const target = roots[index];
    if (target) {
      void removeAuthorizedDir(target);
    }
  }

  return {
    // Methods
    exportWorkspaceConfig,
    importWorkspaceConfig,
    canRepairOpencodeMigration,
    repairOpencodeMigration,
    onRepairOpencodeMigration,
    persistAuthorizedRoots,
    persistReloadSettings,
    addAuthorizedDir,
    addAuthorizedDirFromPicker,
    removeAuthorizedDir,
    removeAuthorizedDirAtIndex,
    // Reactive getters
    exportingWorkspaceConfig,
    importingWorkspaceConfig,
    migrationRepairBusy,
    migrationRepairResult,
    newAuthorizedDir,
    setNewAuthorizedDir,
    setMigrationRepairResult,
  };
}
