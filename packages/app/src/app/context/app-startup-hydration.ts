import {
  createEffect,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";

import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";

import { resolveNativeWindowDecorationsVisible } from "../components/titlebar-menu-layout";
import {
  DEFAULT_MODEL,
  ENGINE_CUSTOM_BIN_PATH_PREF_KEY,
  ENGINE_SOURCE_EXPLICIT_PREF_KEY,
  ENGINE_SOURCE_PREF_KEY,
  HIDE_TITLEBAR_PREF_KEY,
  IDLE_SUSPEND_MS_PREF_KEY,
  MAX_ENGINES_PREF_KEY,
  SESSION_MODEL_SELECTOR_PREF_KEY,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "../constants";
import {
  MODEL_VARIANT_DEFAULT_MIGRATION_KEY,
  resolveStartupModelVariant,
} from "../lib/model-variant";
import {
  parseStoredEngineSourceExplicitPreference,
  resolveStoredEngineSourcePreference,
  type EngineSourcePreference,
} from "../lib/engine-source";
import {
  setWindowDecorations,
  setWindowTitleBarStyle,
  updaterEnvironment,
  type UpdaterEnvironment,
} from "../lib/tauri";
import {
  clearVesloServerSettings,
  hydrateVesloServerSettingsFromEnv,
  readVesloConnectInviteFromSearch,
  readVesloServerSettings,
  type VesloServerSettings,
} from "../lib/veslo-server";
import {
  UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY,
  UPDATE_INSTALL_STATE_KEY,
  parseUpdateInstallState,
  resolveUpdateAutoDownloadDefaultOffMigration,
  resolveUpdateInstallStartupStatus,
  resolveUpdateStartupPreferences,
  type UpdateStatus,
} from "./updater";
import { hydrateDenAuthFromDesktopSnapshot } from "../lib/den-auth";
import { clearStartupPreference, readStartupPreference } from "../utils";
import { createStartupGuard } from "../utils/startup-guard";
import {
  applyThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "../theme";
import type {
  EngineRuntime,
  ModelRef,
  OnboardingStep,
  StartupPreference,
} from "../types";

type StartupCleanup = () => void;

type PendingSessionDraftStartupController = {
  hydrateActivePendingDraft: () => Promise<unknown>;
  markActivePendingDraftStorageReady: () => void;
};

type StartupWorkspaceStore = {
  bootstrapOnboarding: () => Promise<unknown>;
};

type NotionStatus = "disconnected" | "connecting" | "connected" | "error";

export type AppStartupHydrationDeps = {
  cloudOnlyMode: Accessor<boolean>;
  isTauriRuntime: () => boolean;
  isWindowsPlatform: () => boolean;
  isMacPlatform: () => boolean;
  booting: Accessor<boolean>;
  setBooting: Setter<boolean>;
  setStartupPreference: Setter<StartupPreference | null>;
  setRememberStartupChoice: Setter<boolean>;
  setVesloServerSettings: Setter<VesloServerSettings>;
  pendingSessionDraftController: PendingSessionDraftStartupController;
  themeMode: Accessor<ThemeMode>;
  hydrateSubagentDecorations: () => void;
  markSubagentDecorationsReady: () => void;
  baseUrl: Accessor<string>;
  setBaseUrl: Setter<string>;
  clientDirectory: Accessor<string>;
  setClientDirectory: Setter<string>;
  workspaceProjectDir: Accessor<string>;
  engineSource: Accessor<EngineSourcePreference>;
  engineSourceExplicit: Accessor<boolean>;
  updateEngineSource: (
    value: EngineSourcePreference,
    options?: { explicit?: boolean },
  ) => void;
  engineCustomBinPath: Accessor<string>;
  setEngineCustomBinPath: Setter<string>;
  engineRuntime: Accessor<EngineRuntime>;
  setEngineRuntime: Setter<EngineRuntime>;
  defaultModel: Accessor<ModelRef>;
  setDefaultModel: Setter<ModelRef>;
  setLegacyDefaultModel: Setter<ModelRef>;
  showThinking: Accessor<boolean>;
  setShowThinking: Setter<boolean>;
  sessionModelSelectorEnabled: Accessor<boolean>;
  setSessionModelSelectorEnabled: Setter<boolean>;
  maxEngines: Accessor<number>;
  setMaxEngines: Setter<number>;
  idleSuspendMs: Accessor<number>;
  setIdleSuspendMs: Setter<number>;
  hideTitlebar: Accessor<boolean>;
  setHideTitlebar: Setter<boolean>;
  modelVariant: Accessor<string | null>;
  setModelVariant: Setter<string | null>;
  modelVariantPreferenceReady: Accessor<boolean>;
  setModelVariantPreferenceReady: Setter<boolean>;
  updatePreferencesReady: Accessor<boolean>;
  setUpdatePreferencesReady: Setter<boolean>;
  updateAutoCheck: Accessor<boolean>;
  setUpdateAutoCheck: Setter<boolean>;
  updateAutoDownload: Accessor<boolean>;
  setUpdateAutoDownload: Setter<boolean>;
  updateStatus: Accessor<UpdateStatus>;
  setUpdateStatus: Setter<UpdateStatus>;
  setUpdateEnv: Setter<UpdaterEnvironment | null>;
  launchUpdateCheckTriggered: Accessor<boolean>;
  setLaunchUpdateCheckTriggered: Setter<boolean>;
  setAppVersion: Setter<string | null>;
  checkForUpdates: (options: { quiet: boolean }) => Promise<unknown>;
  refreshMcpServers: () => Promise<unknown>;
  setNotionStatus: Setter<NotionStatus>;
  setNotionStatusDetail: Setter<string | null>;
  setNotionSkillInstalled: Setter<boolean>;
  formatMcpConnectingLabel: () => string;
  consumeDesktopDeepLinkUrls: (urls: string[] | null | undefined) => void;
  consumeWebDeepLinkUrl: (
    currentUrl: string,
    replaceUrl: (cleanedUrl: string) => void,
  ) => void;
  onboardingStep: Accessor<OnboardingStep>;
  setOnboardingStep: Setter<OnboardingStep>;
  routedClient: Accessor<unknown>;
  workspaceStore: StartupWorkspaceStore;
  reportError: (error: unknown, context: string) => void;
};

export function createAppStartupHydration(deps: AppStartupHydrationDeps) {
  onMount(async () => {
    const mountCleanupFns: StartupCleanup[] = [];
    const startupGuard = createStartupGuard({
      timeoutMs: 15_000,
      onTimeout: () => {
        console.warn("[boot] app startup timed out after 15s - forcing boot complete");
        deps.setBooting(false);
      },
    });
    onCleanup(() => {
      startupGuard.dispose();
      for (const cleanup of mountCleanupFns.splice(0)) {
        cleanup();
      }
    });

    hydrateCloudOnlyStartup(deps);
    hydrateStartupPreference(deps);
    hydrateUpdatePreferences(deps);

    await deps.pendingSessionDraftController.hydrateActivePendingDraft();
    deps.pendingSessionDraftController.markActivePendingDraftStorageReady();

    mountSystemThemeSubscription(deps);
    hydrateLocalStoragePreferences(deps);

    if (deps.isTauriRuntime()) {
      await hydrateTauriStartup(deps, mountCleanupFns);
    } else {
      runWebDeepLinkStartup(deps);
    }

    await hydrateDesktopAuthSnapshot(deps);

    void deps.workspaceStore.bootstrapOnboarding().finally(() => {
      startupGuard.complete();
      deps.setBooting(false);
    });
  });

  createPersistentPreferenceEffects(deps);
}
function hydrateCloudOnlyStartup(deps: AppStartupHydrationDeps) {
  if (typeof window === "undefined" || !deps.cloudOnlyMode()) {
    return;
  }

  const invite = readVesloConnectInviteFromSearch(window.location.search);
  if (invite) {
    return;
  }

  clearStartupPreference();
  deps.setRememberStartupChoice(false);
  try {
    for (const key of [
      "veslo.baseUrl",
      "veslo.clientDirectory",
      "veslo.projectDir",
      "veslo.onboardingComplete",
    ]) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
  clearVesloServerSettings();
  hydrateVesloServerSettingsFromEnv();
  deps.setVesloServerSettings(readVesloServerSettings());
}

function hydrateStartupPreference(deps: AppStartupHydrationDeps) {
  const startupPref = readStartupPreference();
  if (!startupPref) {
    return;
  }

  deps.setRememberStartupChoice(true);
  deps.setStartupPreference(startupPref);
}

function hydrateUpdatePreferences(deps: AppStartupHydrationDeps) {
  if (typeof window === "undefined") {
    deps.setUpdatePreferencesReady(true);
    return;
  }

  try {
    const storedUpdateAutoCheck = window.localStorage.getItem("veslo.updateAutoCheck");
    const storedUpdateAutoDownload = window.localStorage.getItem("veslo.updateAutoDownload");
    const autoDownloadMigration = resolveUpdateAutoDownloadDefaultOffMigration({
      storedAutoDownload: storedUpdateAutoDownload,
      migrationComplete:
        window.localStorage.getItem(UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY) === "1",
    });
    if (autoDownloadMigration.writeAutoDownload) {
      window.localStorage.setItem(
        "veslo.updateAutoDownload",
        autoDownloadMigration.storedAutoDownload ?? "0",
      );
    }
    if (autoDownloadMigration.writeMigration) {
      window.localStorage.setItem(UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY, "1");
    }
    const startupUpdatePreferences = resolveUpdateStartupPreferences({
      storedAutoCheck: storedUpdateAutoCheck,
      storedAutoDownload: autoDownloadMigration.storedAutoDownload,
    });
    deps.setUpdateAutoCheck(startupUpdatePreferences.autoCheck);
    deps.setUpdateAutoDownload(startupUpdatePreferences.autoDownload);
  } catch {
    // ignore
  } finally {
    deps.setUpdatePreferencesReady(true);
  }
}

function mountSystemThemeSubscription(deps: AppStartupHydrationDeps) {
  const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
    if (deps.themeMode() !== "system") return;
    applyThemeMode(isDark ? "dark" : "light");
  });

  onCleanup(() => {
    unsubscribeTheme();
  });

  createEffect(() => {
    const next = deps.themeMode();
    persistThemeMode(next);
    applyThemeMode(next);
  });
}

function hydrateLocalStoragePreferences(deps: AppStartupHydrationDeps) {
  if (typeof window === "undefined") {
    deps.markSubagentDecorationsReady();
    return;
  }

  try {
    deps.hydrateSubagentDecorations();

    // In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.
    // OpenCode is assigned a random port on every restart, so the stored URL is
    // always stale after a relaunch. The correct baseUrl is provided by engine_info().
    // Web mode still needs the cached value since it connects to a fixed server URL.
    if (!deps.isTauriRuntime()) {
      const storedBaseUrl = window.localStorage.getItem("veslo.baseUrl");
      if (storedBaseUrl) {
        deps.setBaseUrl(storedBaseUrl);
      }
    }

    const storedClientDir = window.localStorage.getItem(
      "veslo.clientDirectory",
    );
    if (storedClientDir) {
      deps.setClientDirectory(storedClientDir);
    }

    const storedEngineSource = window.localStorage.getItem(ENGINE_SOURCE_PREF_KEY);
    const storedEngineSourceExplicit = parseStoredEngineSourceExplicitPreference(
      window.localStorage.getItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY),
    );
    const storedEngineCustomBinPath = window.localStorage.getItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY);
    if (storedEngineCustomBinPath) {
      deps.setEngineCustomBinPath(storedEngineCustomBinPath);
    }
    const restoredEngineSource = resolveStoredEngineSourcePreference({
      isTauriRuntime: deps.isTauriRuntime(),
      storedSource: storedEngineSource,
      storedCustomBinPath: storedEngineCustomBinPath,
      storedSourceExplicit: storedEngineSourceExplicit,
    });
    deps.updateEngineSource(restoredEngineSource.source, {
      explicit: restoredEngineSource.explicit,
    });

    const storedEngineRuntime = window.localStorage.getItem(
      "veslo.engineRuntime",
    );
    if (storedEngineRuntime === "direct" || storedEngineRuntime === "veslo-orchestrator") {
      deps.setEngineRuntime(storedEngineRuntime);
    }

    deps.setDefaultModel(DEFAULT_MODEL);
    deps.setLegacyDefaultModel(DEFAULT_MODEL);

    const storedThinking = window.localStorage.getItem(THINKING_PREF_KEY);
    if (storedThinking != null) {
      try {
        const parsed = JSON.parse(storedThinking);
        if (typeof parsed === "boolean") {
          deps.setShowThinking(parsed);
        }
      } catch {
        // ignore
      }
    }

    const storedSessionModelSelector = window.localStorage.getItem(SESSION_MODEL_SELECTOR_PREF_KEY);
    if (storedSessionModelSelector != null) {
      try {
        const parsed = JSON.parse(storedSessionModelSelector);
        if (typeof parsed === "boolean") deps.setSessionModelSelectorEnabled(parsed);
      } catch {
        // ignore malformed local preference
      }
    }

    const storedMax = window.localStorage.getItem(MAX_ENGINES_PREF_KEY);
    if (storedMax != null) {
      try {
        const parsed = JSON.parse(storedMax);
        if (typeof parsed === "number" && parsed >= 1 && parsed <= 16) {
          deps.setMaxEngines(parsed);
        }
      } catch {
        // ignore
      }
    }
    const storedIdle = window.localStorage.getItem(IDLE_SUSPEND_MS_PREF_KEY);
    if (storedIdle != null) {
      try {
        const parsed = JSON.parse(storedIdle);
        if (typeof parsed === "number" && parsed >= 0) {
          deps.setIdleSuspendMs(parsed);
        }
      } catch {
        // ignore
      }
    }

    const storedHideTitlebar = window.localStorage.getItem(HIDE_TITLEBAR_PREF_KEY);
    if (storedHideTitlebar != null) {
      try {
        const parsed = JSON.parse(storedHideTitlebar);
        if (typeof parsed === "boolean") {
          deps.setHideTitlebar(parsed);
        }
      } catch {
        // ignore
      }
    }

    try {
      const startupVariant = resolveStartupModelVariant({
        storedVariant: window.localStorage.getItem(VARIANT_PREF_KEY),
        storedMigrationVersion: window.localStorage.getItem(MODEL_VARIANT_DEFAULT_MIGRATION_KEY),
      });
      deps.setModelVariant(startupVariant.variant);
      if (startupVariant.persistVariant) {
        window.localStorage.setItem(VARIANT_PREF_KEY, startupVariant.variant);
      }
      if (startupVariant.persistMigrationVersion) {
        window.localStorage.setItem(MODEL_VARIANT_DEFAULT_MIGRATION_KEY, startupVariant.persistMigrationVersion);
      }
    } finally {
      deps.setModelVariantPreferenceReady(true);
    }

    const storedUpdateCheckedAt = window.localStorage.getItem(
      "veslo.updateLastCheckedAt",
    );
    if (storedUpdateCheckedAt) {
      const parsed = Number(storedUpdateCheckedAt);
      if (Number.isFinite(parsed) && parsed > 0) {
        deps.setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
      }
    }

    const storedNotionStatus = window.localStorage.getItem("veslo.notionStatus");
    if (
      storedNotionStatus === "disconnected" ||
      storedNotionStatus === "connected" ||
      storedNotionStatus === "connecting" ||
      storedNotionStatus === "error"
    ) {
      deps.setNotionStatus(storedNotionStatus);
    }

    const storedNotionDetail = window.localStorage.getItem("veslo.notionStatusDetail");
    if (storedNotionDetail) {
      deps.setNotionStatusDetail(storedNotionDetail);
    } else if (storedNotionStatus === "connecting") {
      deps.setNotionStatusDetail(deps.formatMcpConnectingLabel());
    }

    void deps.refreshMcpServers().catch((e) => deps.reportError(e, "mcp.refreshServers"));

    const storedNotionSkillInstalled = window.localStorage.getItem("veslo.notionSkillInstalled");
    if (storedNotionSkillInstalled === "1") {
      deps.setNotionSkillInstalled(true);
    }
  } catch {
    // ignore
  }

  deps.markSubagentDecorationsReady();
}

async function hydrateTauriStartup(
  deps: AppStartupHydrationDeps,
  mountCleanupFns: StartupCleanup[],
) {
  let currentAppVersion: string | null = null;
  try {
    currentAppVersion = await getVersion();
    deps.setAppVersion(currentAppVersion);
  } catch {
    // ignore
  }

  if (typeof window !== "undefined") {
    try {
      const installStartup = resolveUpdateInstallStartupStatus({
        storedState: parseUpdateInstallState(window.localStorage.getItem(UPDATE_INSTALL_STATE_KEY)),
        currentVersion: currentAppVersion,
      });

      if (installStartup.action === "clear" || installStartup.action === "stale") {
        window.localStorage.removeItem(UPDATE_INSTALL_STATE_KEY);
      }

      if (installStartup.action === "recover" || installStartup.action === "stale") {
        deps.setUpdateStatus(installStartup.status);
        deps.setLaunchUpdateCheckTriggered(true);
      }
    } catch {
      // ignore
    }
  }

  scheduleUpdaterStartup(deps);

  try {
    mountCleanupFns.push(await mountDesktopDeepLinkWorkflow(deps));
  } catch {
    // ignore
  }
}

function scheduleUpdaterStartup(deps: AppStartupHydrationDeps) {
  void updaterEnvironment()
    .then((env) => {
      deps.setUpdateEnv(env);
    })
    .catch(() => {
      // ignore
    })
    .then(() => {
      if (deps.launchUpdateCheckTriggered()) {
        return;
      }
      deps.setLaunchUpdateCheckTriggered(true);
      return deps.checkForUpdates({ quiet: true }).catch((e) => deps.reportError(e, "updates.check"));
    });
}

async function mountDesktopDeepLinkWorkflow(deps: AppStartupHydrationDeps): Promise<StartupCleanup> {
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  deps.consumeDesktopDeepLinkUrls(await getCurrent());
  const unlisten = await onOpenUrl((urls) => {
    deps.consumeDesktopDeepLinkUrls(urls);
  });
  // Single-instance plugin emits this event when a second Veslo instance
  // is launched with deep-link arguments (typical macOS browser handoff).
  // The original instance focuses its window via the Rust side; we still
  // need to deliver the URL payload to the auth/remote-connect handlers.
  const unlistenSingleInstance = await listen<string[]>("deep-link://new-url", (event) => {
    deps.consumeDesktopDeepLinkUrls(event.payload);
  });

  return () => {
    unlisten();
    unlistenSingleInstance();
  };
}

function runWebDeepLinkStartup(deps: AppStartupHydrationDeps) {
  const currentUrl = typeof window === "undefined" ? "" : window.location.href;
  if (currentUrl) {
    deps.consumeWebDeepLinkUrl(currentUrl, (cleanedUrl) => {
      window.history.replaceState({}, "", cleanedUrl);
    });
  }
}

async function hydrateDesktopAuthSnapshot(deps: AppStartupHydrationDeps) {
  if (!deps.isTauriRuntime()) {
    return;
  }

  try {
    const hydrationPromise = hydrateDenAuthFromDesktopSnapshot().catch(() => false);
    const hydrationResult = await Promise.race([
      hydrationPromise.then(() => "hydrated" as const),
      new Promise<"timed-out">((resolve) => {
        window.setTimeout(() => {
          resolve("timed-out");
        }, 1500);
      }),
    ]);
    if (hydrationResult === "timed-out") {
      void hydrationPromise.then((imported) => {
        if (!imported || deps.onboardingStep() !== "auth") {
          return;
        }
        // If the synchronous boot path already established a client by
        // the time the delayed hydration finishes, the retry bootstrap
        // is redundant and would race the user's current session view
        // through bootstrapOnboarding -> connectToServer.
        if (deps.routedClient()) {
          return;
        }
        deps.setOnboardingStep("connecting");
        deps.setBooting(true);
        void deps.workspaceStore.bootstrapOnboarding().finally(() => {
          deps.setBooting(false);
        });
      });
    }
  } catch {
    // ignore desktop auth snapshot hydration failures
  }
}

function createPersistentPreferenceEffects(deps: AppStartupHydrationDeps) {
  createEffect(() => {
    if (typeof window === "undefined") return;
    // In Tauri desktop the orchestrator port rotates on every `pnpm dev`
    // restart and the live URL always comes from `engineInfo()` IPC.
    // Persisting it to localStorage here only pollutes the cache (the read
    // path above already skips localStorage in Tauri) and creates
    // a stale value that a future regression could read by accident.
    if (deps.isTauriRuntime()) return;
    try {
      window.localStorage.setItem("veslo.baseUrl", deps.baseUrl());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "veslo.clientDirectory",
        deps.clientDirectory(),
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("veslo.projectDir", deps.workspaceProjectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ENGINE_SOURCE_PREF_KEY, deps.engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (deps.engineSourceExplicit()) {
        window.localStorage.setItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY, "1");
      } else {
        window.localStorage.removeItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = deps.engineCustomBinPath().trim();
      if (value) {
        window.localStorage.setItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("veslo.engineRuntime", deps.engineRuntime());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.updatePreferencesReady()) return;
    try {
      window.localStorage.setItem(
        "veslo.updateAutoCheck",
        deps.updateAutoCheck() ? "1" : "0",
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.updatePreferencesReady()) return;
    try {
      window.localStorage.setItem(
        "veslo.updateAutoDownload",
        deps.updateAutoDownload() ? "1" : "0",
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        THINKING_PREF_KEY,
        JSON.stringify(deps.showThinking()),
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        SESSION_MODEL_SELECTOR_PREF_KEY,
        JSON.stringify(deps.sessionModelSelectorEnabled()),
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MAX_ENGINES_PREF_KEY, JSON.stringify(deps.maxEngines()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(IDLE_SUSPEND_MS_PREF_KEY, JSON.stringify(deps.idleSuspendMs()));
    } catch {
      // ignore
    }
  });

  persistTitlebarPreference(deps);

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.modelVariantPreferenceReady()) return;
    try {
      const value = deps.modelVariant();
      if (value) {
        window.localStorage.setItem(VARIANT_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(VARIANT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const state = deps.updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem(
          "veslo.updateLastCheckedAt",
          String(state.lastCheckedAt),
        );
      } catch {
        // ignore
      }
    }
  });
}

function persistTitlebarPreference(deps: AppStartupHydrationDeps) {
  createEffect(() => {
    if (typeof window === "undefined") return;
    const hide = deps.hideTitlebar();
    try {
      window.localStorage.setItem(HIDE_TITLEBAR_PREF_KEY, JSON.stringify(hide));
    } catch {
      // ignore
    }
    if (deps.isTauriRuntime()) {
      setWindowDecorations(
        resolveNativeWindowDecorationsVisible({
          tauri: true,
          windows: deps.isWindowsPlatform(),
          hideTitlebar: hide,
        }),
      ).catch((e) => deps.reportError(e, "titlebar.setDecorations"));
    }
  });

  createEffect(() => {
    if (!deps.isTauriRuntime() || !deps.isMacPlatform()) return;
    const titlebarHidden = deps.hideTitlebar();
    if (titlebarHidden) return;
    setWindowTitleBarStyle("overlay").catch((error) => {
      console.error("[app.titlebar] Failed to apply macOS overlay titlebar style", {
        runtime: "tauri",
        platform: "macOS",
        hideTitlebar: titlebarHidden,
        style: "overlay",
        error: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    });
  });
}
