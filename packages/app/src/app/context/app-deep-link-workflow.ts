import {
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";

import type { StartupPreference } from "../types";
import {
  parseRemoteConnectDeepLink,
  parseSharedBundleDeepLink,
  stripRemoteConnectQuery,
  stripSharedBundleQuery,
  type SharedBundleDeepLink,
} from "../lib/deep-links";
import {
  hydrateVesloServerSettingsFromEnv,
  normalizeVesloServerUrl,
  readVesloBundleInviteFromSearch,
  readVesloConnectInviteFromSearch,
  stripVesloBundleInviteFromUrl,
  stripVesloConnectInviteFromUrl,
  type VesloServerClient,
  type VesloServerSettings,
  type VesloServerStatus,
} from "../lib/veslo-server";
import {
  buildImportPayloadFromBundle,
  fetchSharedBundle,
  type SharedBundleV1,
} from "../lib/shared-bundles";
import type { VesloServerInfo } from "../lib/tauri";

export type RemoteWorkspaceDefaults = {
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

type WindowLocationTarget = {
  location: { href: string; search: string };
  history: {
    state?: unknown;
    replaceState: (state: unknown, title: string, url?: string | URL | null) => void;
  };
};

type SharedBundleImportClient = Pick<VesloServerClient, "importWorkspace">;

export type AppDeepLinkWorkflowDeps = {
  booting: Accessor<boolean>;
  startupPreference: Accessor<StartupPreference | string>;
  setStartupPreference: (value: StartupPreference) => void;
  onboardingStep: Accessor<string>;
  setOnboardingStep: (value: string) => void;
  vesloServerSettings: Accessor<VesloServerSettings>;
  setVesloServerSettings: (value: VesloServerSettings) => void;
  readVesloServerSettings?: () => VesloServerSettings;
  writeVesloServerSettings?: (value: VesloServerSettings) => VesloServerSettings;
  activeVesloServerHostInfo: Accessor<Pick<VesloServerInfo, "baseUrl" | "clientToken"> | null>;
  vesloServerClient: Accessor<SharedBundleImportClient | null>;
  vesloServerWorkspaceId: Accessor<string | null>;
  vesloServerStatus: Accessor<VesloServerStatus | string>;
  workspace: {
    createRemoteWorkspaceOpen: Accessor<boolean>;
    setCreateRemoteWorkspaceOpen: (open: boolean) => void;
    createRemoteWorkspaceFlow: (input: {
      vesloHostUrl: string;
      vesloToken: string;
      directory: string | null;
      displayName: string | null;
      manageBusy?: boolean;
      closeModal?: boolean;
    }) => Promise<boolean> | boolean;
  };
  setView: (view: "dashboard") => void;
  setTab: (tab: "scheduled") => void;
  setError: (message: string | null) => void;
  queueAuthCompleteDeepLink: (rawUrl: string) => boolean;
  quickAddWorkerEnabled?: Accessor<boolean>;
  cloudOnlyMode?: Accessor<boolean>;
  fetchSharedBundle?: (bundleUrl: string) => Promise<SharedBundleV1>;
  buildImportPayloadFromBundle?: typeof buildImportPayloadFromBundle;
  refreshSkills: (options?: { force?: boolean }) => Promise<unknown>;
  refreshHubSkills: (options?: { force?: boolean }) => Promise<unknown>;
  addOpencodeCacheHint: (message: string) => string;
  safeStringify: (value: unknown) => string;
  consoleLog?: (message: string) => void;
  timers?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
};

export function createAppDeepLinkWorkflow(deps: AppDeepLinkWorkflowDeps) {
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingSharedBundleInvite, setPendingSharedBundleInvite] =
    createSignal<SharedBundleDeepLink | null>(null);
  const [sharedBundleImportBusy, setSharedBundleImportBusy] = createSignal(false);
  const [sharedBundleNoticeShown, setSharedBundleNoticeShown] = createSignal(false);
  const seenDesktopDeepLinkUrls = new Set<string>();

  const readSettings = deps.readVesloServerSettings ?? (() => deps.vesloServerSettings());
  const writeSettings = deps.writeVesloServerSettings ?? ((value) => value);
  const loadSharedBundle = deps.fetchSharedBundle ?? fetchSharedBundle;
  const buildImportPayload = deps.buildImportPayloadFromBundle ?? buildImportPayloadFromBundle;
  const now = deps.timers?.now ?? (() => Date.now());
  const sleep = deps.timers?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const queueSharedBundleDeepLink = (rawUrl: string): boolean => {
    const parsed = parseSharedBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingSharedBundleInvite(parsed);
    setSharedBundleNoticeShown(false);
    return true;
  };

  const consumeDesktopDeepLinkUrls = (urls: string[] | null | undefined) => {
    if (!Array.isArray(urls)) {
      return;
    }
    for (const url of urls) {
      if (typeof url !== "string" || url.length === 0) continue;
      if (seenDesktopDeepLinkUrls.has(url)) continue;
      seenDesktopDeepLinkUrls.add(url);
      if (
        deps.queueAuthCompleteDeepLink(url) ||
        queueRemoteConnectDeepLink(url) ||
        queueSharedBundleDeepLink(url)
      ) {
        break;
      }
    }
  };

  const consumeWebDeepLinkUrl = (
    currentUrl: string,
    replaceUrl: (cleanedUrl: string) => void,
  ) => {
    if (!currentUrl) {
      return;
    }
    deps.queueAuthCompleteDeepLink(currentUrl);
    queueRemoteConnectDeepLink(currentUrl);
    queueSharedBundleDeepLink(currentUrl);
    const remoteStripped = stripRemoteConnectQuery(currentUrl) ?? currentUrl;
    const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;
    if (bundleStripped !== currentUrl) {
      replaceUrl(bundleStripped);
    }
  };

  const hydrateStartupInvites = (windowTarget: WindowLocationTarget | undefined) => {
    if (!windowTarget) {
      return;
    }
    hydrateVesloServerSettingsFromEnv();

    const stored = readSettings();
    const invite = readVesloConnectInviteFromSearch(windowTarget.location.search);
    const bundleInvite = readVesloBundleInviteFromSearch(windowTarget.location.search);

    if (!invite) {
      deps.setVesloServerSettings(stored);
    } else {
      const merged: VesloServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeSettings(merged);
      deps.setVesloServerSettings(next);

      if (invite.startup === "server") {
        deps.setStartupPreference("server");
        if (untrack(deps.onboardingStep) !== "language") {
          deps.setOnboardingStep("server");
        }
      }
    }

    if (bundleInvite?.bundleUrl) {
      setPendingSharedBundleInvite({
        bundleUrl: bundleInvite.bundleUrl,
        intent: bundleInvite.intent,
        source: bundleInvite.source,
        orgId: bundleInvite.orgId,
        label: bundleInvite.label,
      });
      setSharedBundleNoticeShown(false);
    }

    const cleanedConnect = stripVesloConnectInviteFromUrl(windowTarget.location.href);
    const cleaned = stripVesloBundleInviteFromUrl(cleanedConnect);
    if (cleaned !== windowTarget.location.href) {
      windowTarget.history.replaceState(windowTarget.history.state ?? null, "", cleaned);
    }
  };

  const flushPendingRemoteConnectDeepLink = () => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || deps.booting()) {
      return;
    }

    deps.setView("dashboard");
    deps.setTab("scheduled");
    setDeepLinkRemoteWorkspaceDefaults(pending);
    deps.workspace.setCreateRemoteWorkspaceOpen(true);
    setPendingRemoteConnectDeepLink(null);
  };

  const clearRemoteDefaultsWhenModalCloses = () => {
    if (deps.workspace.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  };

  const resolveSharedBundleWorkerTarget = () => {
    const pref = deps.startupPreference();
    const hostInfo = deps.activeVesloServerHostInfo();
    const settings = deps.vesloServerSettings();

    const localHostUrl = normalizeVesloServerUrl(hostInfo?.baseUrl ?? "") ?? "";
    const localToken = hostInfo?.clientToken?.trim() ?? "";
    const serverHostUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
    const serverToken = settings.token?.trim() ?? "";

    if (pref === "server") {
      return {
        hostUrl: serverHostUrl || localHostUrl,
        token: serverToken || localToken,
      };
    }

    if (pref === "local") {
      return {
        hostUrl: localHostUrl || serverHostUrl,
        token: localToken || serverToken,
      };
    }

    if (localHostUrl) {
      return {
        hostUrl: localHostUrl,
        token: localToken || serverToken,
      };
    }

    return {
      hostUrl: serverHostUrl,
      token: serverToken || localToken,
    };
  };

  const waitForSharedBundleImportTarget = async (timeoutMs = 20_000) => {
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
      const client = deps.vesloServerClient();
      const workspaceId = deps.vesloServerWorkspaceId();
      if (client && workspaceId && deps.vesloServerStatus() === "connected") {
        return { client, workspaceId };
      }
      await sleep(200);
    }
    throw new Error("Veslo worker is not ready yet.");
  };

  const createWorkerForSharedBundle = async (request: SharedBundleDeepLink, bundle: SharedBundleV1) => {
    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error("Share link detected. Configure an Veslo worker host and token, then open the link again.");
    }

    const label = (request.label?.trim() || bundle.name?.trim() || "Shared setup").slice(0, 80);
    const ok = await deps.workspace.createRemoteWorkspaceFlow({
      vesloHostUrl: hostUrl,
      vesloToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this share link.");
    }
  };

  const importSharedBundleInvite = async (
    request: SharedBundleDeepLink,
    options?: { isCancelled?: () => boolean },
  ) => {
    const isCancelled = options?.isCancelled ?? (() => false);
    setSharedBundleImportBusy(true);
    try {
      const bundle = await loadSharedBundle(request.bundleUrl);
      if (isCancelled()) return;

      if (request.intent === "new_worker") {
        await createWorkerForSharedBundle(request, bundle);
        if (isCancelled()) return;
      }

      const { client, workspaceId } = await waitForSharedBundleImportTarget();
      if (isCancelled()) return;

      const { payload, importedSkillsCount } = buildImportPayload(bundle);
      await client.importWorkspace(workspaceId, payload);
      await deps.refreshSkills({ force: true });
      await deps.refreshHubSkills({ force: true });
      deps.setError(null);
      if (importedSkillsCount > 0) {
        (deps.consoleLog ?? console.log)(`[veslo] imported ${importedSkillsCount} skills from share bundle`);
      }
    } catch (error) {
      if (!isCancelled()) {
        const message = error instanceof Error ? error.message : deps.safeStringify(error);
        deps.setError(deps.addOpencodeCacheHint(message));
      }
    } finally {
      if (!isCancelled()) {
        setSharedBundleImportBusy(false);
        setPendingSharedBundleInvite(null);
        setSharedBundleNoticeShown(false);
      }
    }
  };

  const startPendingSharedBundleImport = () => {
    const request = pendingSharedBundleInvite();
    if (!request || deps.booting()) {
      return;
    }

    if (sharedBundleImportBusy()) {
      return;
    }

    if (request.intent === "import_current") {
      const client = deps.vesloServerClient();
      const workspaceId = deps.vesloServerWorkspaceId();
      const connected = deps.vesloServerStatus() === "connected";
      if (!client || !workspaceId || !connected) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          deps.setError("Share link detected. Connect to a writable Veslo worker to import this bundle.");
        }
        return;
      }
    } else {
      const target = resolveSharedBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          deps.setError("Share link detected. Configure an Veslo host and token to create a new worker.");
        }
        return;
      }
    }

    let cancelled = false;
    void importSharedBundleInvite(request, { isCancelled: () => cancelled });

    onCleanup(() => {
      cancelled = true;
    });
  };

  const openCreateRemoteWorkspace = () => {
    if (!deps.quickAddWorkerEnabled?.()) {
      deps.workspace.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = normalizeVesloServerUrl(target.hostUrl ?? "") ?? "";
    const token = target.token?.trim() ?? "";
    const defaults: RemoteWorkspaceDefaults = {
      vesloHostUrl: hostUrl || null,
      vesloToken: token || null,
      directory: null,
      displayName: null,
    };

    const requiresToken = !deps.cloudOnlyMode?.();
    if (!hostUrl || (requiresToken && !token)) {
      setDeepLinkRemoteWorkspaceDefaults(defaults);
      deps.workspace.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    void (async () => {
      const ok = await deps.workspace.createRemoteWorkspaceFlow({
        vesloHostUrl: hostUrl,
        vesloToken: token,
        directory: null,
        displayName: null,
      });
      if (ok) return;
      setDeepLinkRemoteWorkspaceDefaults(defaults);
      deps.workspace.setCreateRemoteWorkspaceOpen(true);
    })();
  };

  createEffect(() => {
    hydrateStartupInvites(typeof window === "undefined" ? undefined : window);
  });

  createEffect(flushPendingRemoteConnectDeepLink);
  createEffect(clearRemoteDefaultsWhenModalCloses);
  createEffect(startPendingSharedBundleImport);

  return {
    deepLinkRemoteWorkspaceDefaults,
    pendingRemoteConnectDeepLink,
    pendingSharedBundleInvite,
    sharedBundleImportBusy,
    sharedBundleNoticeShown,
    queueRemoteConnectDeepLink,
    queueSharedBundleDeepLink,
    consumeDesktopDeepLinkUrls,
    consumeWebDeepLinkUrl,
    hydrateStartupInvites,
    flushPendingRemoteConnectDeepLink,
    clearRemoteDefaultsWhenModalCloses,
    resolveSharedBundleWorkerTarget,
    waitForSharedBundleImportTarget,
    importSharedBundleInvite,
    openCreateRemoteWorkspace,
  };
}
