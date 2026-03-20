import { createSignal } from "solid-js";

import type { OnboardingStep } from "../types";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
  safeStringify,
} from "../utils";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import { t, currentLocale } from "../../i18n";
import { reportError } from "../lib/error-reporter";
import type { OpencodeAuth } from "../lib/opencode";
import {
  engineDoctor,
  engineInfo,
  engineInstall,
  engineStart,
  engineStop,
  orchestratorInstanceDispose,
  sandboxDoctor,
  type EngineDoctorResult,
  type EngineInfo,
  type SandboxDoctorResult,
  type WorkspaceInfo,
} from "../lib/tauri";

export interface EngineStoreDeps {
  // Workspace path / info accessors
  activeWorkspacePath: () => string;
  activeWorkspaceRoot: () => string;
  activeWorkspaceInfo: () => WorkspaceInfo | null;
  activeWorkspaceId: () => string;
  activeWorkspaceDisplay: () => { workspaceType: string };
  projectDir: () => string;
  setProjectDir: (value: string) => void;
  authorizedDirs: () => string[];
  setAuthorizedDirs: (dirs: string[]) => void;

  // Engine source / bin path
  engineSource: () => "path" | "sidecar" | "custom";
  engineCustomBinPath?: () => string;
  isWindowsPlatform: () => boolean;

  // UI state setters
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setBaseUrl: (value: string) => void;
  setClient: (value: any) => void;
  setConnectedVersion: (value: string | null) => void;
  setSelectedSessionId: (value: string | null) => void;
  setMessages: (value: any[]) => void;
  setTodos: (value: any[]) => void;
  setPendingPermissions: (value: any[]) => void;
  setSessionStatusById: (value: Record<string, string>) => void;
  setSseConnected: (value: boolean) => void;
  setStartupPreference: (value: any) => void;
  setOnboardingStep: (step: OnboardingStep) => void;
  setView: (value: any) => void;
  client: () => any;
  onEngineStable?: () => void;

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

  // Orchestrator / runtime helpers
  resolveEngineRuntime: () => string;
  resolveWorkspacePaths: () => string[];
  activateOrchestratorWorkspace: (input: { workspacePath: string; name?: string | null }) => Promise<any>;

  // Workspace-level helpers
  blockLocalAction: (code: string, detail: string) => boolean;
  markOnboardingComplete: () => void;
  resolveWelcomeOnboardingStep: () => OnboardingStep;
  setMigrationRepairResult: (value: any) => void;
}

export function createEngineStore(deps: EngineStoreDeps) {
  const [engine, setEngine] = createSignal<EngineInfo | null>(null);
  const [engineAuth, setEngineAuth] = createSignal<OpencodeAuth | null>(null);
  const [engineDoctorResult, setEngineDoctorResult] = createSignal<EngineDoctorResult | null>(null);
  const [engineDoctorCheckedAt, setEngineDoctorCheckedAt] = createSignal<number | null>(null);
  const [engineInstallLogs, setEngineInstallLogs] = createSignal<string | null>(null);
  const [sandboxDoctorResult, setSandboxDoctorResult] = createSignal<SandboxDoctorResult | null>(null);
  const [sandboxDoctorCheckedAt, setSandboxDoctorCheckedAt] = createSignal<number | null>(null);
  const [sandboxDoctorBusy, setSandboxDoctorBusy] = createSignal(false);

  let lastEngineReconnectAt = 0;
  let reconnectingEngine = false;

  async function refreshEngine() {
    if (!isTauriRuntime()) return;

    try {
      const info = await engineInfo();
      setEngine(info);

      const isRemoteWorkspace = deps.activeWorkspaceInfo()?.workspaceType === "remote";
      const syncLocalState = !isRemoteWorkspace;

      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : null;
      setEngineAuth(auth);

      if (info.projectDir && syncLocalState) {
        deps.setProjectDir(info.projectDir);
      }
      if (info.baseUrl && syncLocalState) {
        deps.setBaseUrl(info.baseUrl);
      }

      if (
        syncLocalState &&
        info.running &&
        info.baseUrl &&
        !deps.client() &&
        !reconnectingEngine
      ) {
        const now = Date.now();
        if (now - lastEngineReconnectAt > 10_000) {
          lastEngineReconnectAt = now;
          reconnectingEngine = true;
          deps.connectToServer(
            info.baseUrl,
            (deps.activeWorkspaceRoot().trim() || info.projectDir || undefined),
            {
              workspaceId: deps.activeWorkspaceId().trim() || undefined,
              workspaceType: "local",
              targetRoot: deps.activeWorkspaceRoot().trim() || undefined,
              reason: "engine-refresh",
            },
            auth ?? undefined,
            { quiet: true, navigate: false },
          )
            .catch(e => reportError(e, "workspace.reconnect"))
            .finally(() => {
              reconnectingEngine = false;
            });
        }
      }
    } catch {
      // ignore
    }
  }

  async function refreshEngineDoctor() {
    if (!isTauriRuntime()) return;

    try {
      const source = deps.engineSource();
      const result = await engineDoctor({
        preferSidecar: source === "sidecar",
        opencodeBinPath: source === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
      });
      setEngineDoctorResult(result);
      setEngineDoctorCheckedAt(Date.now());
    } catch (e) {
      setEngineDoctorResult(null);
      setEngineDoctorCheckedAt(Date.now());
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }
  }

  async function refreshSandboxDoctor() {
    if (!isTauriRuntime()) {
      setSandboxDoctorResult(null);
      setSandboxDoctorCheckedAt(Date.now());
      return null;
    }
    if (sandboxDoctorBusy()) return sandboxDoctorResult();
    setSandboxDoctorBusy(true);
    try {
      const result = await sandboxDoctor();
      setSandboxDoctorResult(result);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const fallback: SandboxDoctorResult = {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        error: message,
      };
      setSandboxDoctorResult(fallback);
      return fallback;
    } finally {
      setSandboxDoctorCheckedAt(Date.now());
      setSandboxDoctorBusy(false);
    }
  }

  async function startHost(optionsOverride?: { workspacePath?: string; navigate?: boolean }) {
    if (CLOUD_ONLY_MODE) {
      return deps.blockLocalAction("cloud_only_host_mode_removed", "Local host mode has been removed.");
    }

    if (!isTauriRuntime()) {
      deps.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    const overrideWorkspacePath = optionsOverride?.workspacePath?.trim() ?? "";
    if (deps.activeWorkspaceInfo()?.workspaceType === "remote" && !overrideWorkspacePath) {
      deps.setError(t("app.error.host_requires_local", currentLocale()));
      return false;
    }

    const dir = (overrideWorkspacePath || deps.activeWorkspacePath() || deps.projectDir()).trim();
    if (!dir) {
      deps.setError(t("app.error.pick_workspace_folder", currentLocale()));
      return false;
    }

      try {
        const source = deps.engineSource();
        const result = await engineDoctor({
          preferSidecar: source === "sidecar",
          opencodeBinPath: source === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
        });
        setEngineDoctorResult(result);
        setEngineDoctorCheckedAt(Date.now());

      if (!result.found) {
        deps.setError(
          deps.isWindowsPlatform()
            ? "OpenCode CLI not found. Install OpenCode for Windows or bundle opencode.exe with Veslo, then restart. If it is installed, ensure `opencode.exe` is on PATH (try `opencode --version` in PowerShell)."
            : "OpenCode CLI not found. Install with `brew install anomalyco/tap/opencode` or `curl -fsSL https://opencode.ai/install | bash`, then retry.",
        );
        return false;
      }

      if (!result.supportsServe) {
        const serveDetails = [result.serveHelpStdout, result.serveHelpStderr]
          .filter((value) => value && value.trim())
          .join("\n\n");
        const suffix = serveDetails ? `\n\nServe output:\n${serveDetails}` : "";
        deps.setError(
          `OpenCode CLI is installed, but \`opencode serve\` is unavailable. Update OpenCode and retry.${suffix}`
        );
        return false;
      }
    } catch (e) {
      setEngineInstallLogs(e instanceof Error ? e.message : safeStringify(e));
    }

    deps.setError(null);
    deps.setMigrationRepairResult(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.starting_engine");
    deps.setBusyStartedAt(Date.now());

    try {
      deps.setProjectDir(dir);
      if (!deps.authorizedDirs().length) {
        deps.setAuthorizedDirs([dir]);
      }

      const info = await engineStart(dir, {
        preferSidecar: deps.engineSource() === "sidecar",
        opencodeBinPath:
          deps.engineSource() === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
        runtime: deps.resolveEngineRuntime(),
        workspacePaths: deps.resolveWorkspacePaths(),
      });
      setEngine(info);

      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      setEngineAuth(auth ?? null);

      if (info.baseUrl) {
        const activeLocalWorkspace =
          deps.activeWorkspaceInfo()?.workspaceType === "local" ? deps.activeWorkspaceInfo() : null;
        const ok = await deps.connectToServer(
          info.baseUrl,
          dir,
          {
            workspaceId: activeLocalWorkspace?.id,
            workspaceType: "local",
            targetRoot: dir,
            reason: "host-start",
          },
          auth,
          { navigate: optionsOverride?.navigate ?? true },
        );
        if (!ok) return false;
      }

      deps.markOnboardingComplete();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function stopHost() {
    deps.setError(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.disconnecting");
    deps.setBusyStartedAt(Date.now());

    try {
      if (isTauriRuntime()) {
        const info = await engineStop();
        setEngine(info);
      }

      setEngineAuth(null);

      deps.setClient(null);
      deps.setConnectedVersion(null);
      deps.setSelectedSessionId(null);
      deps.setMessages([]);
      deps.setTodos([]);
      deps.setPendingPermissions([]);
      deps.setSessionStatusById({});
      deps.setSseConnected(false);

      deps.setStartupPreference(null);
      deps.setOnboardingStep(deps.resolveWelcomeOnboardingStep());

      deps.setView("session");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function reloadWorkspaceEngine() {
    if (CLOUD_ONLY_MODE) {
      return deps.blockLocalAction("cloud_only_local_disabled", "Reload is only available for remote workers.");
    }

    if (!isTauriRuntime()) {
      deps.setError("Reloading the engine requires the desktop app.");
      return false;
    }

    if (deps.activeWorkspaceDisplay().workspaceType !== "local") {
      deps.setError("Reload is only available for local workers.");
      return false;
    }

    const root = deps.activeWorkspacePath().trim();
    if (!root) {
      deps.setError("Pick a worker folder first.");
      return false;
    }

    deps.setError(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.reloading_engine");
    deps.setBusyStartedAt(Date.now());

    try {
      const runtime = engine()?.runtime ?? deps.resolveEngineRuntime();
      if (runtime === "veslo-orchestrator") {
        await orchestratorInstanceDispose(root);
        await deps.activateOrchestratorWorkspace({
          workspacePath: root,
          name: deps.activeWorkspaceInfo()?.displayName?.trim() || deps.activeWorkspaceInfo()?.name?.trim() || null,
        });

        const nextInfo = await engineInfo();
        setEngine(nextInfo);

        const username = nextInfo.opencodeUsername?.trim() ?? "";
        const password = nextInfo.opencodePassword?.trim() ?? "";
        const auth = username && password ? { username, password } : undefined;
        setEngineAuth(auth ?? null);

        if (nextInfo.baseUrl) {
          const ok = await deps.connectToServer(
            nextInfo.baseUrl,
            root,
            {
              workspaceId:
                deps.activeWorkspaceInfo()?.workspaceType === "local"
                  ? deps.activeWorkspaceInfo()?.id
                  : undefined,
              workspaceType: "local",
              targetRoot: root,
              reason: "engine-reload-orchestrator",
            },
            auth,
          );
          if (!ok) {
            deps.setError("Failed to reconnect after reload");
            return false;
          }
        }

        return true;
      }

      const info = await engineStop();
      setEngine(info);

      const nextInfo = await engineStart(root, {
        preferSidecar: deps.engineSource() === "sidecar",
        opencodeBinPath:
          deps.engineSource() === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
        runtime,
        workspacePaths: deps.resolveWorkspacePaths(),
      });
      setEngine(nextInfo);

      const username = nextInfo.opencodeUsername?.trim() ?? "";
      const password = nextInfo.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      setEngineAuth(auth ?? null);

      if (nextInfo.baseUrl) {
        const ok = await deps.connectToServer(
          nextInfo.baseUrl,
          root,
          {
            workspaceId:
              deps.activeWorkspaceInfo()?.workspaceType === "local"
                ? deps.activeWorkspaceInfo()?.id
                : undefined,
            workspaceType: "local",
            targetRoot: root,
            reason: "engine-reload",
          },
          auth,
        );
        if (!ok) {
          deps.setError("Failed to reconnect after reload");
          return false;
        }
      }

      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
      return false;
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  async function onInstallEngine() {
    deps.setError(null);
    setEngineInstallLogs(null);
    deps.setBusy(true);
    deps.setBusyLabel("status.installing_opencode");
    deps.setBusyStartedAt(Date.now());

    try {
      const result = await engineInstall();
      const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      setEngineInstallLogs(combined || null);

      if (!result.ok) {
        deps.setError(result.stderr.trim() || t("app.error.install_failed", currentLocale()));
      }

      await refreshEngineDoctor();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      deps.setError(addOpencodeCacheHint(message));
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
    }
  }

  return {
    // Reactive getters (signals)
    engine,
    setEngine,
    engineAuth,
    setEngineAuth,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    setEngineInstallLogs,
    sandboxDoctorResult,
    sandboxDoctorCheckedAt,
    sandboxDoctorBusy,
    // Methods
    refreshEngine,
    refreshEngineDoctor,
    refreshSandboxDoctor,
    startHost,
    stopHost,
    reloadWorkspaceEngine,
    onInstallEngine,
  };
}
