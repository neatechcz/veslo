import { createMemo } from "solid-js";

import { currentLocale, t } from "../i18n";
import { CLOUD_ONLY_MODE } from "./lib/cloud-policy";
import { unwrap } from "./lib/opencode";
import { normalizeModelVariant } from "./lib/model-variant";
import { isTauriRuntime, isWindowsPlatform, preferredSessionWorkspaceRoot } from "./utils";
import type { EngineSourcePreference } from "./lib/engine-source";
import type { PluginScope } from "./types";
import type { OnboardingViewProps } from "./pages/onboarding";
import type { DashboardViewProps } from "./pages/dashboard";
import type { SessionViewProps } from "./pages/session";
import type { VesloServerStatus } from "./lib/veslo-server";

export type DashboardViewAdapterProps = Omit<DashboardViewProps, "onOpenFeedback">;
export type SessionViewAdapterProps = Omit<SessionViewProps, "onOpenFeedback">;

type DashboardWorkspaceType = "local" | "remote" | string | null | undefined;
const STATUS_SEPARATOR = ` ${String.fromCharCode(183)} `;

export type HeaderConnectedVersionInput = {
  connectedVersion?: string | null;
  developerMode: boolean;
  appVersion?: string | null;
  vesloServerDiagnosticsVersion?: string | null;
};

export function resolveHeaderConnectedVersion(input: HeaderConnectedVersionInput): string | null {
  const fallbackVersion = input.connectedVersion?.trim() ?? "";
  if (!input.developerMode) {
    return fallbackVersion || null;
  }

  const vesloVersion = input.appVersion?.trim() || input.vesloServerDiagnosticsVersion?.trim() || "";
  if (!vesloVersion) {
    return fallbackVersion || null;
  }

  const normalizedVersion = vesloVersion.startsWith("v") ? vesloVersion : `v${vesloVersion}`;
  return `Veslo ${normalizedVersion}`;
}

export type HeaderStatusInput = {
  clientConnected: boolean;
  headerConnectedVersion: string | null;
  sseConnected: boolean;
  connectedLabel: string;
  disconnectedLabel: string;
  liveLabel: string;
};

export function resolveHeaderStatus(input: HeaderStatusInput): string {
  if (!input.clientConnected || !input.headerConnectedVersion) return input.disconnectedLabel;
  const bits = [`${input.connectedLabel}${STATUS_SEPARATOR}${input.headerConnectedVersion}`];
  if (input.sseConnected) bits.push(input.liveLabel);
  return bits.join(STATUS_SEPARATOR);
}

export type BusyHintInput = {
  busy: boolean;
  busyLabel?: string | null;
  busySeconds: number;
  translateBusyLabel: (key: string) => string;
};

export function resolveBusyHint(input: BusyHintInput): string | null {
  if (!input.busy || !input.busyLabel) return null;
  const label = input.translateBusyLabel(input.busyLabel);
  return input.busySeconds > 0 ? `${label}${STATUS_SEPARATOR}${input.busySeconds}s` : label;
}

export type LocalHostLabelInput = {
  engine?: { hostname?: string | null; port?: number | string | null } | null;
  baseUrl: string;
  fallback?: string;
};

export function resolveLocalHostLabel(input: LocalHostLabelInput): string {
  const info = input.engine;
  if (info?.hostname && info?.port) {
    return `${info.hostname}:${info.port}`;
  }

  try {
    return new URL(input.baseUrl).host;
  } catch {
    return input.fallback ?? "localhost:4096";
  }
}

export type DashboardViewAccessInput = {
  workspaceType: DashboardWorkspaceType;
  vesloServerStatus: VesloServerStatus | string;
  vesloServerCanWriteSkills: boolean;
  vesloServerCanWritePlugins: boolean;
  tauriRuntime: boolean;
};

export type DashboardViewAccess = {
  canUseDesktopTools: boolean;
  canInstallSkillCreator: boolean;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  skillsAccessHint: string | null;
  pluginsAccessHint: string | null;
};

export function resolveDashboardViewAccess(input: DashboardViewAccessInput): DashboardViewAccess {
  const isRemoteWorkspace = input.workspaceType === "remote";
  const canUseDesktopTools = input.tauriRuntime && !isRemoteWorkspace;
  const canInstallSkillCreator = isRemoteWorkspace ? input.vesloServerCanWriteSkills : input.tauriRuntime;
  const canEditPlugins = isRemoteWorkspace ? input.vesloServerCanWritePlugins : input.tauriRuntime;
  const canUseGlobalPluginScope = !isRemoteWorkspace && input.tauriRuntime;
  const skillsAccessHint = isRemoteWorkspace
    ? input.vesloServerStatus === "disconnected"
      ? "Veslo server unavailable. Add the server URL/token in Advanced to manage skills."
      : input.vesloServerStatus === "limited"
        ? "Veslo server needs a host token to install/update skills. Add it in Advanced and reconnect."
        : input.vesloServerCanWriteSkills
          ? null
          : "Veslo server is read-only for skills. Add a host token in Advanced to enable installs."
    : null;
  const pluginsAccessHint = isRemoteWorkspace
    ? input.vesloServerStatus === "disconnected"
      ? "Veslo server unavailable. Plugins are read-only."
      : input.vesloServerStatus === "limited"
        ? "Veslo server needs a token to edit plugins."
        : input.vesloServerCanWritePlugins
          ? null
          : "Veslo server is read-only for plugins."
    : null;

  return {
    canUseDesktopTools,
    canInstallSkillCreator,
    canEditPlugins,
    canUseGlobalPluginScope,
    skillsAccessHint,
    pluginsAccessHint,
  };
}

export type AppViewPropsScope = Record<string, any>;

export type AppViewPropsAdapter = {
  onboardingProps: () => OnboardingViewProps;
  dashboardProps: () => DashboardViewAdapterProps;
  sessionProps: () => SessionViewAdapterProps;
};

export function createAppViewProps(deps: AppViewPropsScope): AppViewPropsAdapter {
  const {
    connectedVersion,
    developerMode,
    appVersion,
    vesloServerDiagnostics,
    routedClient,
    sseConnected,
    busy,
    busyLabel,
    busySeconds,
    engine,
    baseUrl,
    startupPreference,
    onboardingStep,
    rememberStartupChoice,
    clientDirectory,
    vesloServerSettings,
    newAuthorizedDir,
    workspaceStore,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    error,
    migrationRepairUnavailableReason,
    showRemoteActions,
    setClientDirectory,
    updateVesloServerSettings,
    setLocale,
    setTab,
    setView,
    setThemeMode,
    startDesktopBrowserSignIn,
    resumeDesktopBrowserSignIn,
    authCompleteExchangeBusy,
    denKeepSignedIn,
    setDenKeepSignedInPreference,
    themeMode,
    activeWorkspaceDisplay,
    vesloServerStatus,
    vesloServerCanWriteSkills,
    vesloServerCanWritePlugins,
    tab,
    settingsTab,
    setSettingsTab,
    currentView,
    setSessionBrowseScope,
    authenticatedUser,
    logoutLocalDenAuth,
    newTaskDisabled,
    sessionStore,
    vesloServerUrl,
    hydratedVesloServerClient,
    vesloReconnectBusy,
    reconnectVesloServer,
    vesloServerHostInfo,
    devtoolsCapabilities,
    resolvedDevtoolsWorkspaceId,
    vesloAuditEntries,
    vesloAuditStatus,
    vesloAuditError,
    opencodeConnectStatus,
    orchestratorStatusState,
    opencodeRouterInfoState,
    resetVesloServerSettings,
    testVesloServerConnection,
    canReloadWorkspace,
    reloadWorkspaceEngine,
    refreshWorkspaceConfigForPath,
    scheduledAutomationStore,
    soulDataStore,
    reloadBusy,
    reloadError,
    readyEngineWorkspaceIds,
    handleActivateWorkspace,
    openCreateRemoteWorkspace,
    openNewSessionWithDirectory,
    pendingSessionDraftController,
    sidebarWorkspaceGroups,
    unreadSessionIds,
    workspaceSessionPagingById,
    subagentDecorationsBySessionId,
    archivedSessionIds,
    activeSessionStatusById,
    busySessionByWorkspaceId,
    archiveSidebarSessionAndClearActive,
    reportError,
    setError,
    safeStringify,
    unarchiveSession,
    loadMoreWorkspaceSidebarSessions,
    activeSessionId,
    activeWorkspaceLastSessionId,
    openRenameWorkspace,
    openWorkspaceConnectionSettings,
    refreshSkills,
    refreshSkillInventory,
    refreshSkillImportCandidates,
    refreshHubSkills,
    refreshPlugins,
    skills,
    skillsStatus,
    skillInventory,
    skillInventoryStatus,
    skillImportCandidates,
    skillImportStatus,
    hubSkills,
    hubSkillsStatus,
    installSkillCreator,
    installHubSkill,
    uninstallSkill,
    readSkill,
    saveSkill,
    readSkillInstanceFiles,
    readSkillInstance,
    saveSkillInstance,
    setSkillInstanceEnabled,
    deleteSkillInstance,
    removeSkillInstance,
    batchRemoveSkillInstances,
    restoreSkillInstance,
    copySkillInstanceToGlobal,
    copySkillInstanceToWorkspace,
    importSkillCandidates,
    pluginScope,
    setPluginScope,
    pluginConfigPath,
    pluginConfig,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    isPluginInstalledByName,
    localizedSuggestedPlugins,
    addPlugin,
    removePlugin,
    createSessionAndOpen,
    setPrompt,
    selectSession,
    managedAiAccessBusy,
    managedAiAccess,
    managedAiAccessMessage,
    managedAiAccessProviderLabel,
    managedAiAccessDefaultModelLabel,
    showThinking,
    setShowThinking,
    hideTitlebar,
    setHideTitlebar,
    maxEngines,
    setMaxEngines,
    idleSuspendMs,
    setIdleSuspendMs,
    formatModelVariantLabel,
    modelVariant,
    setModelVariant,
    updateAutoDownload,
    setUpdateAutoDownload,
    setUpdateAutoCheck,
    updateStatus,
    updateEnv,
    checkForUpdates,
    downloadUpdate,
    retryUpdateDownload,
    installUpdateAndRestart,
    anyActiveRuns,
    engineSource,
    updateEngineSource,
    engineCustomBinPath,
    setEngineCustomBinPath,
    engineRuntime,
    setEngineRuntime,
    stopHost,
    restartLocalServer,
    openResetModal,
    resetModalBusy,
    clearStartupPreference,
    setStartupPreference,
    setRememberStartupChoice,
    toggleDenKeepSignedIn,
    pendingPermissions,
    events,
    repairOpencodeCache,
    cacheRepairBusy,
    cacheRepairResult,
    cleanupVesloDockerContainers,
    dockerCleanupBusy,
    dockerCleanupResult,
    resetAppConfigDefaults,
    notionStatus,
    notionStatusDetail,
    notionError,
    notionBusy,
    connectNotion,
    sessionArchives,
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    localizedMcpQuickConnect,
    hubMcpCards,
    hubMcpStatus,
    refreshHubMcp,
    installHubMcpAndActivate,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    refreshMcpServers,
    activePendingDraftKey,
    activePendingDraftMeta,
    composerTargetController,
    resolveSelectedSessionBrowseScope,
    resolveSessionDirectory,
    selectedSession,
    activeUiConversationRef,
    activeWorkspaceHasRoutingEntry,
    sessionsLoadedForActiveWorkspace,
    chooseFolderForCurrentSession,
    engineReady,
    vesloServerWorkspaceId,
    sidebarPluginList,
    sidebarPluginStatus,
    sessionCapabilitiesSnapshot,
    sessionCapabilitiesStatus,
    sessionCapabilitiesError,
    reloadRequired,
    reloadTrigger,
    reloadCopy,
    activeReloadBlockingSessions,
    forceStopActiveSessionsAndReload,
    clearReloadRequired,
    sendPrompt,
    replaceUserMessage,
    clearComposerDraftForSession,
    abortSession,
    undoLastUserMessage,
    redoLastUserMessage,
    compactCurrentSession,
    lastPromptSent,
    retryLastPrompt,
    selectedSessionDisplayTitle,
    visibleMessages,
    activeTodos,
    groupMessageParts,
    summarizeStep,
    expandedStepIds,
    setExpandedStepIds,
    expandedTimelineSectionIds,
    setExpandedTimelineSectionIds,
    expandedTimelineDetailIds,
    setExpandedTimelineDetailIds,
    expandedSidebarSections,
    setExpandedSidebarSections,
    activeArtifacts,
    activeArtifactFamilies,
    activeWorkingFiles,
    activeAuthorizedDirs,
    activeComposerBusy,
    prompt,
    composerDraft,
    setComposerDraft,
    activePermissionMemo,
    permissionReplyBusy,
    respondPermissionForAppViewProps,
    respondPermissionAndRemember,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    tryNotionPromptVisible,
    notionIsActive,
    managedAiAccessBlockedReason,
    listAgents,
    listCommands,
    selectedSessionAgent,
    setSessionAgent,
    saveSessionExport,
    selectedSessionHistoryUnavailable,
    selectedSessionHistoryRetrying,
    retryUnavailableHistory,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    loadEarlierMessages,
    workspaceProjectDir,
    deleteSessionById,
    setTryNotionPromptVisible,
    setNotionSkillInstalled,
    visibleSelectedSessionStatus,
    renameSessionTitle,
    sessionReconnectNotice,
    setSessionReconnectNotice,
  } = deps;

  const headerConnectedVersion = createMemo(() =>
    resolveHeaderConnectedVersion({
      connectedVersion: connectedVersion(),
      developerMode: developerMode(),
      appVersion: appVersion(),
      vesloServerDiagnosticsVersion: vesloServerDiagnostics()?.version ?? null,
    }),
  );

  const headerStatus = createMemo(() =>
    resolveHeaderStatus({
      clientConnected: Boolean(routedClient()),
      headerConnectedVersion: headerConnectedVersion(),
      sseConnected: sseConnected(),
      connectedLabel: t("status.connected", currentLocale()),
      disconnectedLabel: t("status.disconnected", currentLocale()),
      liveLabel: t("status.live", currentLocale()),
    }),
  );

  const busyHint = createMemo(() =>
    resolveBusyHint({
      busy: busy(),
      busyLabel: busyLabel(),
      busySeconds: busySeconds(),
      translateBusyLabel: (key) => t(key, currentLocale()),
    }),
  );

  const localHostLabel = createMemo(() =>
    resolveLocalHostLabel({
      engine: engine(),
      baseUrl: baseUrl(),
    }),
  );

  const onboardingProps = () => ({
    startupPreference: startupPreference(),
    onboardingStep: onboardingStep(),
    language: currentLocale(),
    rememberStartupChoice: rememberStartupChoice(),
    busy: busy(),
    clientDirectory: clientDirectory(),
    vesloHostUrl: vesloServerSettings().urlOverride ?? "",
    vesloToken: vesloServerSettings().token ?? "",
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    activeWorkspacePath: workspaceStore.activeWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    canRepairMigration: workspaceStore.canRepairOpencodeMigration(),
    migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
    migrationRepairBusy: workspaceStore.migrationRepairBusy(),
    migrationRepairResult: workspaceStore.migrationRepairResult(),
    isWindows: isWindowsPlatform(),
    showRemoteActions: showRemoteActions(),
    onClientDirectoryChange: setClientDirectory,
    onVesloHostUrlChange: (value: string) =>
      updateVesloServerSettings({
        ...vesloServerSettings(),
        urlOverride: value,
      }),
    onVesloTokenChange: (value: string) =>
      updateVesloServerSettings({
        ...vesloServerSettings(),
        token: value,
      }),
    onSelectStartup: workspaceStore.onSelectStartup,
    onSetLanguage: setLocale,
    onConfirmLanguage: async () => {
      setLocale(currentLocale());
      await workspaceStore.onConfirmLanguage();
    },
    onRememberStartupToggle: workspaceStore.onRememberStartupToggle,
    onStartHost: workspaceStore.onStartHost,
    onRepairMigration: workspaceStore.onRepairOpencodeMigration,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onImportWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToWelcome: workspaceStore.onBackToWelcome,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => {
      setTab("settings");
      setView("dashboard");
    },
    themeMode: themeMode(),
    setThemeMode,
    onSignInWithBrowser: startDesktopBrowserSignIn,
    onResumeBrowserSignIn: resumeDesktopBrowserSignIn,
    authExchangeBusy: authCompleteExchangeBusy(),
    keepSignedIn: denKeepSignedIn(),
    onKeepSignedInChange: setDenKeepSignedInPreference,
  } satisfies OnboardingViewProps);

  const dashboardProps = () => {
    const workspaceType = activeWorkspaceDisplay().workspaceType;
    const vesloStatus = vesloServerStatus();
    const dashboardAccess = resolveDashboardViewAccess({
      workspaceType,
      vesloServerStatus: vesloStatus,
      vesloServerCanWriteSkills: vesloServerCanWriteSkills(),
      vesloServerCanWritePlugins: vesloServerCanWritePlugins(),
      tauriRuntime: isTauriRuntime(),
    });
    const {
      canUseDesktopTools,
      canInstallSkillCreator,
      canEditPlugins,
      canUseGlobalPluginScope,
      skillsAccessHint,
      pluginsAccessHint,
    } = dashboardAccess;

    return {
      tab: tab(),
      setTab,
      settingsTab: settingsTab(),
      setSettingsTab,
      view: currentView(),
      setView,
      setSessionBrowseScope,
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(routedClient()),
      authenticatedUser: authenticatedUser(),
      onLogout: logoutLocalDenAuth,
      onSignIn: startDesktopBrowserSignIn,
      busy: busy(),
      busyHint: busyHint(),
      busyLabel: busyLabel(),
      newTaskDisabled: newTaskDisabled(),
      pendingPermissionCountByWs: sessionStore.pendingPermissionCountByWs(),
      headerStatus: headerStatus(),
      error: error(),
      vesloServerStatus: vesloStatus,
      vesloServerUrl: vesloServerUrl(),
      vesloServerClient: hydratedVesloServerClient(),
      vesloReconnectBusy: vesloReconnectBusy(),
      reconnectVesloServer,
      vesloServerSettings: vesloServerSettings(),
      vesloServerHostInfo: vesloServerHostInfo(),
      vesloServerCapabilities: devtoolsCapabilities(),
      vesloServerDiagnostics: vesloServerDiagnostics(),
      vesloServerWorkspaceId: resolvedDevtoolsWorkspaceId(),
      vesloAuditEntries: vesloAuditEntries(),
      vesloAuditStatus: vesloAuditStatus(),
      vesloAuditError: vesloAuditError(),
      opencodeConnectStatus: opencodeConnectStatus(),
      engineInfo: workspaceStore.engine(),
      orchestratorStatus: orchestratorStatusState(),
      opencodeRouterInfo: opencodeRouterInfoState(),
      engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
      updateVesloServerSettings,
      resetVesloServerSettings,
      testVesloServerConnection,
      canReloadWorkspace: canReloadWorkspace(),
      reloadWorkspaceEngine,
      reloadScheduledAutomationsSource: scheduledAutomationStore.reloadScheduledJobsSource,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      activeWorkspaceDisplay: activeWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
      readyEngineWorkspaceIds: readyEngineWorkspaceIds(),
      activateWorkspace: handleActivateWorkspace,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => {
        if (CLOUD_ONLY_MODE) {
          openCreateRemoteWorkspace();
          return;
        }
        workspaceStore.setCreateWorkspaceOpen(true);
      },
      openCreateRemoteWorkspace,
      openNewSessionWithDirectory,
      openDirectorySessionFromPicker: () => {
        void pendingSessionDraftController.openDirectorySessionFromPicker();
      },
      openPendingDirectoryDraftInWorkspace: (workspaceId: string) => {
        void pendingSessionDraftController.openPendingDirectoryDraftInWorkspace(workspaceId);
      },
      importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
      importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
      workspaceSessionGroups: sidebarWorkspaceGroups(),
      unreadSessionIds: unreadSessionIds(),
      workspaceSessionPagingById: workspaceSessionPagingById(),
      subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
      archivedSessionIds: archivedSessionIds(),
      sessionStatusById: activeSessionStatusById(),
      busySessionByWorkspaceId: busySessionByWorkspaceId(),
      archiveSession: (workspaceId: string, sessionId: string) =>
        archiveSidebarSessionAndClearActive(workspaceId, sessionId).catch((error: unknown) => {
          reportError(error, "sessionArchives.archiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      unarchiveSession: (workspaceId: string, sessionId: string) =>
        unarchiveSession(workspaceId, sessionId).catch((error: unknown) => {
          reportError(error, "sessionArchives.unarchiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      loadMoreWorkspaceSidebarSessions,
      isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
      selectedSessionId: activeSessionId(),
      lastWorkspaceSessionId: activeWorkspaceLastSessionId(),
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      automationItems: scheduledAutomationStore.automationItems(),
      automationWorkspaces: scheduledAutomationStore.automationWorkspaces(),
      defaultAutomationWorkspaceId: scheduledAutomationStore.defaultAutomationWorkspaceId(),
      scheduledJobs: scheduledAutomationStore.scheduledJobs(),
      scheduledJobsSource: scheduledAutomationStore.scheduledJobsSource(),
      scheduledJobsSourceReady: scheduledAutomationStore.scheduledJobsSourceReady(),
      scheduledJobsStatus: scheduledAutomationStore.scheduledJobsStatus(),
      scheduledJobsBusy: scheduledAutomationStore.scheduledJobsBusy(),
      scheduledJobsUpdatedAt: scheduledAutomationStore.scheduledJobsUpdatedAt(),
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        scheduledAutomationStore.refreshScheduledJobs(options).catch((e: unknown) => reportError(e, "scheduled.refresh")),
      createAutomation: scheduledAutomationStore.createAutomation,
      updateAutomation: scheduledAutomationStore.updateAutomation,
      deleteAutomation: scheduledAutomationStore.deleteAutomation,
      runAutomation: scheduledAutomationStore.runAutomation,
      soulOverview: soulDataStore.soulOverview(),
      soulOverviewError: soulDataStore.soulOverviewError(),
      soulOverviewBusy: soulDataStore.soulOverviewBusy(),
      soulClient: soulDataStore.soulClient(),
      soulServerConnected: soulDataStore.soulServerConnected(),
      soulAuthContext: soulDataStore.soulAuthContext(),
      soulStatusByWorkspaceId: soulDataStore.soulStatusByWorkspaceId(),
      soulWorkspaceMap: soulDataStore.soulWorkspaceMap(),
      activeSoulStatus: soulDataStore.activeSoulStatus(),
      activeSoulHeartbeats: soulDataStore.activeSoulHeartbeats(),
      soulStatusBusy: soulDataStore.soulStatusBusy(),
      soulHeartbeatsBusy: soulDataStore.soulHeartbeatsBusy(),
      soulError: soulDataStore.soulError(),
      refreshSoulData: (options?: { force?: boolean }) => soulDataStore.refreshSoulData(options).catch((e: unknown) => reportError(e, "soul.refresh")),
      runSoulPrompt: soulDataStore.runSoulPrompt,
      activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
      isRemoteWorkspace: workspaceStore.activeWorkspaceDisplay().workspaceType === "remote",
      refreshSkills: (options?: { force?: boolean }) => refreshSkills(options).catch((e: unknown) => reportError(e, "skills.refresh")),
      refreshSkillInventory: (options?: { force?: boolean }) =>
        refreshSkillInventory(options).catch((e: unknown) => reportError(e, "skills.refreshInventory")),
      refreshSkillImportCandidates: (options?: { force?: boolean }) =>
        refreshSkillImportCandidates(options).catch((e: unknown) => reportError(e, "skills.refreshImportCandidates")),
      refreshHubSkills: (options?: { force?: boolean }) => refreshHubSkills(options).catch((e: unknown) => reportError(e, "skills.refreshHub")),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch((e: unknown) => reportError(e, "plugins.refresh")),
      skills: skills(),
      skillsStatus: skillsStatus(),
      skillInventory: skillInventory(),
      skillInventoryStatus: skillInventoryStatus(),
      skillImportCandidates: skillImportCandidates(),
      skillImportStatus: skillImportStatus(),
      hubSkills: hubSkills(),
      hubSkillsStatus: hubSkillsStatus(),
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      installSkillCreator,
      installHubSkill,
      uninstallSkill,
      readSkill,
      saveSkill,
      readSkillInstanceFiles,
      readSkillInstance,
      saveSkillInstance,
      setSkillInstanceEnabled,
      deleteSkillInstance,
      removeSkillInstance,
      batchRemoveSkillInstances,
      restoreSkillInstance,
      copySkillInstanceToGlobal,
      copySkillInstanceToWorkspace,
      importSkillCandidates,
      pluginsAccessHint,
      canEditPlugins,
      canUseGlobalPluginScope,
      pluginScope: pluginScope(),
      setPluginScope,
      pluginConfigPath: pluginConfigPath() ?? pluginConfig()?.path ?? null,
      pluginList: pluginList(),
      pluginInput: pluginInput(),
      setPluginInput,
      pluginStatus: pluginStatus(),
      activePluginGuide: activePluginGuide(),
      setActivePluginGuide,
      isPluginInstalled: isPluginInstalledByName,
      suggestedPlugins: localizedSuggestedPlugins(),
      addPlugin,
      removePlugin,
      createSessionAndOpen,
      setPrompt,
      selectSession: selectSession,
      aiAccessBusy: managedAiAccessBusy(),
      aiAccessConfigured: Boolean(managedAiAccess()),
      aiAccessMessage: managedAiAccessMessage(),
      aiAccessProviderLabel: managedAiAccessProviderLabel(),
      aiAccessDefaultModelLabel: managedAiAccessDefaultModelLabel(),
      aiAccessAllowedModels: managedAiAccess()?.allowedModels ?? [],
      showThinking: showThinking(),
      toggleShowThinking: () => setShowThinking((v: boolean) => !v),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v: boolean) => !v),
      maxEngines: maxEngines(),
      setMaxEngines: (n: number) => setMaxEngines(Math.max(1, Math.min(64, Math.floor(n)))),
      idleSuspendMs: idleSuspendMs(),
      setIdleSuspendMs: (ms: number) => setIdleSuspendMs(Math.max(0, Math.floor(ms))),
      modelVariantLabel: formatModelVariantLabel(modelVariant()),
      modelVariant: normalizeModelVariant(modelVariant()) ?? "none",
      setModelVariant: (value: string) => setModelVariant(value),
      updateAutoDownload: updateAutoDownload(),
      toggleUpdateAutoDownload: () =>
        setUpdateAutoDownload((v: boolean) => {
          const next = !v;
          if (next) {
            setUpdateAutoCheck(true);
          }
          return next;
        }),
      updateStatus: updateStatus(),
      updateEnv: updateEnv(),
      appVersion: appVersion(),
      checkForUpdates: () => checkForUpdates(),
      downloadUpdate: () => downloadUpdate(),
      retryUpdateDownload: () => retryUpdateDownload(),
      installUpdateAndRestart,
      anyActiveRuns: anyActiveRuns(),
      engineSource: engineSource(),
      setEngineSource: (value: EngineSourcePreference) => updateEngineSource(value, { explicit: true }),
      engineCustomBinPath: engineCustomBinPath(),
      setEngineCustomBinPath,
      engineRuntime: engineRuntime(),
      setEngineRuntime,
      isWindows: isWindowsPlatform(),
      developerMode: developerMode(),
      stopHost,
      restartLocalServer,
      openResetModal,
      resetModalBusy: resetModalBusy(),
      onResetStartupPreference: () => {
        clearStartupPreference();
        setStartupPreference(null);
        setRememberStartupChoice(false);
      },
      themeMode: themeMode(),
      setThemeMode,
      denKeepSignedIn: denKeepSignedIn(),
      toggleDenKeepSignedIn,
      pendingPermissions: pendingPermissions(),
      events: events(),
      workspaceDebugEvents: workspaceStore.workspaceDebugEvents(),
      clearWorkspaceDebugEvents: workspaceStore.clearWorkspaceDebugEvents,
      safeStringify,
      repairOpencodeMigration: workspaceStore.repairOpencodeMigration,
      migrationRepairBusy: workspaceStore.migrationRepairBusy(),
      migrationRepairResult: workspaceStore.migrationRepairResult(),
      migrationRepairAvailable: workspaceStore.canRepairOpencodeMigration(),
      migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
      repairOpencodeCache,
      cacheRepairBusy: cacheRepairBusy(),
      cacheRepairResult: cacheRepairResult(),
      cleanupVesloDockerContainers,
      dockerCleanupBusy: dockerCleanupBusy(),
      dockerCleanupResult: dockerCleanupResult(),
      resetAppConfigDefaults,
      notionStatus: notionStatus(),
      notionStatusDetail: notionStatusDetail(),
      notionError: notionError(),
      notionBusy: notionBusy(),
      connectNotion,
      sessionArchives: sessionArchives(),
      onUnarchiveArchivedSession: (workspaceId: string, sessionId: string, workspaceIdentity?: string | null) =>
        unarchiveSession(workspaceId, sessionId, workspaceIdentity).catch((error: unknown) => {
          reportError(error, "sessionArchives.unarchiveSettings");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      mcpServers: mcpServers(),
      mcpStatus: mcpStatus(),
      mcpLastUpdatedAt: mcpLastUpdatedAt(),
      mcpStatuses: mcpStatuses(),
      mcpConnectingName: mcpConnectingName(),
      selectedMcp: selectedMcp(),
      setSelectedMcp,
      quickConnect: localizedMcpQuickConnect(),
      hubMcpCards: hubMcpCards(),
      hubMcpStatus: hubMcpStatus(),
      refreshHubMcp: () => refreshHubMcp().catch((e: unknown) => reportError(e, "skills.refreshHubMcp")),
      installHubMcp: (name: string) => installHubMcpAndActivate(name).catch((e: unknown) => {
        reportError(e, "skills.installHubMcp");
        return { ok: false, message: e instanceof Error ? e.message : safeStringify(e) };
      }),
      connectMcp,
      authorizeMcp,
      logoutMcpAuth,
      removeMcp,
      refreshMcpServers,
      showMcpReloadBanner: false,
      mcpReloadBlocked: anyActiveRuns(),
      reloadMcpEngine: () => reloadWorkspaceEngine(),
      language: currentLocale(),
      setLanguage: setLocale,
    } satisfies DashboardViewAdapterProps;
  };

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = routedClient();
    if (!activeClient) return [];
    try {
      const directory = workspaceProjectDir().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result as string[];
    } catch {
      return [];
    }
  };

  const sessionProps = () => ({
    selectedSessionId: activeSessionId(),
    activePendingDraftKey: activePendingDraftKey(),
    activePendingDraftMeta: activePendingDraftMeta(),
    composerTargetOptions: composerTargetController.composerTargetOptions(),
    activeComposerTargetId: composerTargetController.activeComposerTargetId(),
    switchComposerTarget: composerTargetController.switchComposerTarget,
    setView,
    setSessionBrowseScope,
    tab: tab(),
    setTab,
    setSettingsTab,
    activeWorkspaceDisplay: activeWorkspaceDisplay(),
    activeWorkspaceRoot:
      (activeSessionId() ? resolveSelectedSessionBrowseScope(activeSessionId()!)?.workspaceRoot : null) ||
      preferredSessionWorkspaceRoot(
        resolveSessionDirectory(selectedSession() ?? { id: "", directory: "" }),
        workspaceStore.activeWorkspaceRoot().trim(),
      ),
    workspaces: workspaceStore.workspaces(),
    workspacesHydrated: workspaceStore.workspacesHydrated(),
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    activeUiConversationRef: activeUiConversationRef(),
    activeWorkspaceHasRoutingEntry: activeWorkspaceHasRoutingEntry(),
    activeWorkspaceSessionsLoaded: sessionsLoadedForActiveWorkspace(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    readyEngineWorkspaceIds: readyEngineWorkspaceIds(),
    activateWorkspace: handleActivateWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    openCreateWorkspace: () => {
      if (CLOUD_ONLY_MODE) {
        openCreateRemoteWorkspace();
        return;
      }
      workspaceStore.setCreateWorkspaceOpen(true);
    },
    openCreateRemoteWorkspace,
    openNewSessionWithDirectory,
    openDirectorySessionFromPicker: () => {
      void pendingSessionDraftController.openDirectorySessionFromPicker();
    },
    openPendingDirectoryDraftInWorkspace: (workspaceId: string) => {
      void pendingSessionDraftController.openPendingDirectoryDraftInWorkspace(workspaceId);
    },
    canChooseSessionFolder:
      (() => {
        if (!isTauriRuntime()) return false;
        const sessionId = activeSessionId();
        if (!sessionId) return false;
        if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "local") return false;
        const session = selectedSession();
        const sourceRoot = preferredSessionWorkspaceRoot(
          session ? resolveSessionDirectory(session) : "",
          workspaceStore.activeWorkspaceRoot().trim(),
        );
        return workspaceStore.isPrivateWorkspacePath(sourceRoot);
      })(),
    chooseFolderForCurrentSession,
    showRemoteActions: showRemoteActions(),
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
    engineReady: engineReady(),
    clientConnected: Boolean(routedClient()),
    authenticatedUser: authenticatedUser(),
    onLogout: logoutLocalDenAuth,
    onSignIn: startDesktopBrowserSignIn,
    vesloServerStatus: vesloServerStatus(),
    startupPreference: startupPreference(),
    hideTitlebar: hideTitlebar(),
    vesloServerClient: hydratedVesloServerClient(),
    vesloServerSettings: vesloServerSettings(),
    vesloServerHostInfo: vesloServerHostInfo(),
    vesloServerWorkspaceId: vesloServerWorkspaceId(),
    engineInfo: workspaceStore.engine(),
    stopHost,
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    updateStatus: updateStatus(),
    updateEnv: updateEnv(),
    updateAutoDownload: updateAutoDownload(),
    anyActiveRuns: anyActiveRuns(),
    downloadUpdate: () => downloadUpdate(),
    retryUpdateDownload: () => retryUpdateDownload(),
    installUpdateAndRestart,
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    mcpServers: mcpServers(),
    mcpStatuses: mcpStatuses(),
    mcpStatus: mcpStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
    sessionCapabilities: sessionCapabilitiesSnapshot(),
    sessionCapabilitiesStatus: sessionCapabilitiesStatus(),
    sessionCapabilitiesError: sessionCapabilitiesError(),
    showSkillReloadBanner: reloadRequired() && reloadTrigger()?.type === "skill",
    reloadBannerTitle: reloadCopy().title,
    reloadBannerBody: reloadCopy().body,
    reloadBannerBlocked: activeReloadBlockingSessions().length > 0,
    reloadBannerActiveCount: activeReloadBlockingSessions().length,
    canReloadWorkspace: canReloadWorkspace(),
    reloadWorkspaceEngine,
    refreshWorkspaceConfig: refreshWorkspaceConfigForPath,
    forceStopActiveConversations: forceStopActiveSessionsAndReload,
    dismissReloadBanner: clearReloadRequired,
    reloadBusy: reloadBusy(),
    reloadError: reloadError(),
    createSessionAndOpen: createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    replaceUserMessageAsync: replaceUserMessage,
    clearComposerDraftForSession,
    abortSession: abortSession,
    sessionRevertMessageId: selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage: undoLastUserMessage,
    redoLastUserMessage: redoLastUserMessage,
    compactSession: compactCurrentSession,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    newTaskDisabled: newTaskDisabled(),
    pendingPermissionCountByWs: sessionStore.pendingPermissionCountByWs(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
    unreadSessionIds: unreadSessionIds(),
    workspaceSessionPagingById: workspaceSessionPagingById(),
    subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
    archivedSessionIds: archivedSessionIds(),
    archiveSession: (workspaceId: string, sessionId: string) =>
      archiveSidebarSessionAndClearActive(workspaceId, sessionId).catch((error: unknown) => {
        reportError(error, "sessionArchives.archiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    unarchiveSession: (workspaceId: string, sessionId: string) =>
      unarchiveSession(workspaceId, sessionId).catch((error: unknown) => {
        reportError(error, "sessionArchives.unarchiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    loadMoreWorkspaceSidebarSessions,
    isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
    soulStatusByWorkspaceId: soulDataStore.soulStatusByWorkspaceId(),
    openRenameWorkspace,
    selectSession: selectSession,
    selectedSessionTitle: selectedSessionDisplayTitle(),
    messages: visibleMessages(),
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    showThinking: showThinking(),
    groupMessageParts,
    summarizeStep,
    expandedStepIds: expandedStepIds(),
    setExpandedStepIds: setExpandedStepIds,
    expandedTimelineSectionIds: expandedTimelineSectionIds(),
    setExpandedTimelineSectionIds: setExpandedTimelineSectionIds,
    expandedTimelineDetailIds: expandedTimelineDetailIds(),
    setExpandedTimelineDetailIds: setExpandedTimelineDetailIds,
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    artifacts: activeArtifacts(),
    artifactFamilies: activeArtifactFamilies(),
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
    busy: activeComposerBusy(),
    prompt: prompt(),
    setPrompt: setPrompt,
    reconnectNotice: sessionReconnectNotice(),
    clearReconnectNotice: () => setSessionReconnectNotice(null),
    composerDraft: composerDraft(),
    setComposerDraft: setComposerDraft,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermissionForAppViewProps,
    respondPermissionAndRemember: respondPermissionAndRemember,
    activeQuestion: activeQuestion(),
    questionReplyBusy: questionReplyBusy(),
    respondQuestion: respondQuestion,
    safeStringify: safeStringify,
    showTryNotionPrompt: tryNotionPromptVisible() && notionIsActive(),
    aiAccessBlockedReason: managedAiAccessBlockedReason(),
    listAgents: listAgents,
    listCommands: listCommands,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    saveSession: saveSessionExport,
    sessionStatusById: activeSessionStatusById(),
    busySessionByWorkspaceId: busySessionByWorkspaceId(),
    historyUnavailable: selectedSessionHistoryUnavailable(),
    historyUnavailableRetrying: selectedSessionHistoryRetrying(),
    retryUnavailableHistory,
    hasEarlierMessages: selectedSessionHasEarlierMessages(),
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
    loadEarlierMessages,
    searchFiles: searchWorkspaceFiles,
    deleteSession: deleteSessionById,
    onTryNotionPrompt: () => {
      setPrompt("setup my crm");
      setTryNotionPromptVisible(false);
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("veslo.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
    },
    sessionStatus: visibleSelectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  } satisfies SessionViewAdapterProps);


  return {
    onboardingProps,
    dashboardProps,
    sessionProps,
  };
}
