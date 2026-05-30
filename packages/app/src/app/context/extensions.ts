import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";
import { currentLocale, t } from "../../i18n";

import type {
  Client,
  HubMcpCard,
  HubMcpItem,
  HubSkillCard,
  HubSkillInstallTarget,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  SkillCard,
  SkillInventoryItem,
  SkillSaveResult,
} from "../types";
import { addOpencodeCacheHint, isTauriRuntime } from "../utils";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../utils/plugins";
import { buildSkillInventory, type BuildSkillInventoryInput, type SkillMutationTarget } from "../lib/skill-inventory";
import {
  importSkill,
  installGlobalSkillTemplate,
  installSkillTemplate,
  listLocalSkills,
  listLocalSkillsScoped as listLocalSkillsScopedCommand,
  readLocalSkill,
  readLocalSkillAtPath,
  uninstallSkill as uninstallSkillCommand,
  uninstallSkillAtPath,
  writeLocalSkill,
  writeLocalSkillAtPath,
  pickDirectory,
  readOpencodeConfig,
  writeOpencodeConfig,
  type LocalSkillCard,
  type LocalSkillListScope,
  type OpencodeConfigFile,
  type WorkspaceInfo,
} from "../lib/tauri";
import type {
  VesloServerCapabilities,
  VesloServerClient,
  VesloServerStatus,
} from "../lib/veslo-server";
import { readDenAuth } from "../lib/den-auth";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;
type ListLocalSkillsScoped = (projectDir: string, scope: LocalSkillListScope) => Promise<LocalSkillCard[]>;
type SkillInventoryRefreshResult = "published" | "stale" | "failed" | "aborted";
type LocalSkillInventoryWorkspace = { id: string; label: string; path: string };

const vesloServerClientIdentities = new WeakMap<object, string>();
let nextVesloServerClientIdentity = 1;

function resolveVesloServerClientIdentity(client: VesloServerClient | null) {
  if (!client || (typeof client !== "object" && typeof client !== "function")) return "none";
  const key = client as object;
  const existing = vesloServerClientIdentities.get(key);
  if (existing) return existing;
  const next = `client-${nextVesloServerClientIdentity}`;
  nextVesloServerClientIdentity += 1;
  vesloServerClientIdentities.set(key, next);
  return next;
}

function fingerprintSensitiveValue(value: string) {
  const normalized = value.trim();
  if (!normalized) return "none";

  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

async function loadSkillCreatorTemplate() {
  const mod = await import("../data/skill-creator.md?raw");
  return mod.default;
}

export function createExtensionsStore(options: {
  client: () => Client | null;
  projectDir: () => string;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  workspaces?: () => WorkspaceInfo[];
  extraSkillInventoryWorkspaces?: () => LocalSkillInventoryWorkspace[];
  vesloServerClient: () => VesloServerClient | null;
  vesloServerStatus: () => VesloServerStatus;
  vesloServerCapabilities: () => VesloServerCapabilities | null;
  vesloServerWorkspaceId: () => string | null;
  listLocalSkillsScoped?: ListLocalSkillsScoped;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onNotionSkillInstalled?: () => void;
}) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);

  const [skillInventory, setSkillInventory] = createSignal<SkillInventoryItem[]>([]);
  const [skillInventoryStatus, setSkillInventoryStatus] = createSignal<string | null>(null);

  const [hubSkills, setHubSkills] = createSignal<HubSkillCard[]>([]);
  const [hubSkillsStatus, setHubSkillsStatus] = createSignal<string | null>(null);
  const [hubMcpCards, setHubMcpCards] = createSignal<HubMcpCard[]>([]);
  const [hubMcpStatus, setHubMcpStatus] = createSignal<string | null>(null);

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginConfigPath, setPluginConfigPath] = createSignal<string | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  // Track in-flight requests to prevent duplicate calls
  let refreshSkillsInFlight = false;
  let refreshSkillInventoryInFlight = false;
  let refreshSkillInventoryPromise: Promise<SkillInventoryRefreshResult> | null = null;
  let refreshSkillInventoryInFlightContextKey = "";
  let refreshPluginsInFlight = false;
  let refreshHubSkillsInFlight = false;
  let refreshHubSkillsPromise: Promise<void> | null = null;
  let refreshHubSkillsInFlightContextKey = "";
  let refreshSkillsAborted = false;
  let refreshSkillInventoryAborted = false;
  let refreshPluginsAborted = false;
  let refreshHubSkillsAborted = false;
  let refreshHubMcpInFlight = false;
  let refreshHubMcpAborted = false;
  let skillsLoaded = false;
  let hubSkillsLoaded = false;
  let skillInventoryLoaded = false;
  let hubMcpLoaded = false;
  let skillsRoot = "";
  let skillInventoryContextKey = "";
  let hubSkillsRoot = "";
  let hubSkillsContextKey = "";
  let hubSkillsRevision = 0;
  let localSkillsRevision = 0;
  let hubMcpRoot = "";
  let hubMcpContextKey = "";

  const markHubSkillsSourceChanged = () => {
    hubSkillsRevision += 1;
  };

  const markLocalSkillsSourceChanged = () => {
    localSkillsRevision += 1;
  };

  async function refreshHubMcp(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const vesloClient = options.vesloServerClient();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloCapabilities?.hub?.mcp?.read &&
      typeof (vesloClient as any).listHubMcp === "function";
    const denAuth = readDenAuth();
    const denToken = denAuth?.token?.trim() ?? "";
    const denOrgId = denAuth?.orgId?.trim() ?? "";
    const nextContextKey = JSON.stringify({
      root,
      canUseVesloServer,
      denOrgId,
      hasDenToken: denToken.length > 0,
    });

    if (root !== hubMcpRoot || nextContextKey !== hubMcpContextKey) {
      hubMcpLoaded = false;
    }

    if (!optionsOverride?.force && hubMcpLoaded) return;
    if (refreshHubMcpInFlight) return;

    refreshHubMcpInFlight = true;
    refreshHubMcpAborted = false;

    try {
      setHubMcpStatus(null);
      const orgCatalogPlaceholder = translate("mcp.org_catalog_placeholder");

      if (canUseVesloServer) {
        if (!denToken || !denOrgId) {
          setHubMcpCards([]);
          setHubMcpStatus(orgCatalogPlaceholder);
          hubMcpRoot = root;
          hubMcpContextKey = nextContextKey;
          return;
        }

        const response = await (vesloClient as any).listHubMcp({
          denToken,
          denOrgId,
        });
        if (refreshHubMcpAborted) return;
        const next: HubMcpCard[] = Array.isArray(response?.items)
          ? response.items.map((entry: HubMcpItem) => ({
              id: String(entry.id ?? entry.name ?? ""),
              name: String(entry.name ?? ""),
              description: typeof entry.description === "string" ? entry.description : undefined,
              type: entry.config.type,
              url: typeof entry.config.url === "string" ? entry.config.url : undefined,
              command: Array.isArray(entry.config.command)
                ? entry.config.command.filter((part): part is string => typeof part === "string")
                : undefined,
              oauth: entry.config.oauth !== false,
            }))
          : [];
        setHubMcpCards(next);
        if (!next.length) setHubMcpStatus(orgCatalogPlaceholder);
        hubMcpLoaded = true;
        hubMcpRoot = root;
        hubMcpContextKey = nextContextKey;
        return;
      }

      if (refreshHubMcpAborted) return;
      setHubMcpCards([]);
      setHubMcpStatus(orgCatalogPlaceholder);
      hubMcpRoot = root;
      hubMcpContextKey = nextContextKey;
    } catch (e) {
      if (refreshHubMcpAborted) return;
      setHubMcpCards([]);
      setHubMcpStatus(e instanceof Error ? e.message : "Failed to load hub MCP.");
    } finally {
      refreshHubMcpInFlight = false;
    }
  }

  const resolveHubSkillsRefreshContext = () => {
    const root = options.activeWorkspaceRoot().trim();
    const vesloClient = options.vesloServerClient();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloCapabilities?.hub?.skills?.read &&
      typeof (vesloClient as any).listHubSkills === "function";
    const denAuth = readDenAuth();
    const denToken = denAuth?.token?.trim() ?? "";
    const denOrgId = denAuth?.orgId?.trim() ?? "";
    const denApiBase = denAuth?.denApiBase?.trim() ?? "";
    const denUserId = denAuth?.user?.id?.trim() ?? "";
    const vesloServerClientIdentity = canUseVesloServer ? resolveVesloServerClientIdentity(vesloClient) : "none";
    const contextKey = JSON.stringify({
      root,
      canUseVesloServer,
      vesloServerClientIdentity,
      denApiBase,
      denOrgId,
      denUserId,
      denTokenFingerprint: fingerprintSensitiveValue(denToken),
      hasDenToken: denToken.length > 0,
    });

    return {
      root,
      vesloClient,
      canUseVesloServer,
      denToken,
      denOrgId,
      contextKey,
    };
  };

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const { root, vesloClient, canUseVesloServer, denToken, denOrgId, contextKey } =
      resolveHubSkillsRefreshContext();

    if (root !== hubSkillsRoot || contextKey !== hubSkillsContextKey) {
      hubSkillsLoaded = false;
    }

    if (refreshHubSkillsInFlight) {
      await refreshHubSkillsPromise;
      const latestContext = resolveHubSkillsRefreshContext();
      if (hubSkillsContextKey !== latestContext.contextKey) {
        await refreshHubSkills(optionsOverride);
      }
      return;
    }
    if (!optionsOverride?.force && hubSkillsLoaded) return;

    refreshHubSkillsInFlight = true;
    refreshHubSkillsInFlightContextKey = contextKey;
    refreshHubSkillsAborted = false;
    refreshHubSkillsPromise = (async () => {
      try {
        setHubSkillsStatus(null);
        const orgCatalogPlaceholder = translate("skills.org_catalog_placeholder");

        if (canUseVesloServer) {
          if (!denToken || !denOrgId) {
            setHubSkills([]);
            setHubSkillsStatus(orgCatalogPlaceholder);
            hubSkillsLoaded = true;
            hubSkillsRoot = root;
            hubSkillsContextKey = contextKey;
            markHubSkillsSourceChanged();
            return;
          }

          const response = await (vesloClient as any).listHubSkills({
            denToken,
            denOrgId,
          });
          if (refreshHubSkillsAborted) return;
          const next: HubSkillCard[] = Array.isArray(response?.items)
            ? response.items.map((entry: any) => ({
                name: String(entry.name ?? ""),
                description: typeof entry.description === "string" ? entry.description : undefined,
                trigger: typeof entry.trigger === "string" ? entry.trigger : undefined,
                source: entry.source,
              }))
            : [];
          setHubSkills(next);
          if (!next.length) setHubSkillsStatus(orgCatalogPlaceholder);
          hubSkillsLoaded = true;
          hubSkillsRoot = root;
          hubSkillsContextKey = contextKey;
          markHubSkillsSourceChanged();
          void refreshHubMcp({ force: true });
          return;
        }

        if (refreshHubSkillsAborted) return;
        setHubSkills([]);
        setHubSkillsStatus(orgCatalogPlaceholder);
        hubSkillsLoaded = true;
        hubSkillsRoot = root;
        hubSkillsContextKey = contextKey;
        markHubSkillsSourceChanged();
        void refreshHubMcp({ force: true });
      } catch (e) {
        if (refreshHubSkillsAborted) return;
        hubSkillsLoaded = false;
        setHubSkills([]);
        hubSkillsRoot = root;
        hubSkillsContextKey = contextKey;
        markHubSkillsSourceChanged();
        setHubSkillsStatus(e instanceof Error ? e.message : "Failed to load hub skills.");
      } finally {
        refreshHubSkillsInFlight = false;
        refreshHubSkillsInFlightContextKey = "";
        refreshHubSkillsPromise = null;
      }
    })();

    await refreshHubSkillsPromise;
  }

  const localWorkspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.vesloWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    workspace.id;

  async function refreshSkillInventory(optionsOverride?: { force?: boolean }) {
    let forceRefresh = optionsOverride?.force === true;

    const normalizeLocalSkillInventoryWorkspace = (workspace: LocalSkillInventoryWorkspace) => ({
      id: workspace.id.trim(),
      label: workspace.label.trim(),
      path: workspace.path.trim(),
    });

    const getLocalSkillInventoryWorkspaces = () => {
      const configured = (options.workspaces?.() ?? [])
        .filter((workspace) => workspace.workspaceType === "local")
        .map((workspace) => ({
          id: workspace.id.trim(),
          label: localWorkspaceLabel(workspace),
          path: workspace.path.trim(),
        }))
        .filter((workspace) => workspace.id && workspace.path);
      const extras = (options.extraSkillInventoryWorkspaces?.() ?? [])
        .map(normalizeLocalSkillInventoryWorkspace)
        .filter((workspace) => workspace.id && workspace.path);
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      const result: LocalSkillInventoryWorkspace[] = [];
      for (const workspace of [...configured, ...extras]) {
        const pathKey = workspace.path.replace(/[/\\]+$/, "");
        if (seenIds.has(workspace.id) || seenPaths.has(pathKey)) continue;
        seenIds.add(workspace.id);
        seenPaths.add(pathKey);
        result.push(workspace);
      }
      return result;
    };

    const getSkillInventoryContextKey = (
      workspacesForContext: ReturnType<typeof getLocalSkillInventoryWorkspaces>,
      hubContextKey: string,
      revisions = {
        hubSkillsRevision,
        localSkillsRevision,
      },
    ) =>
      JSON.stringify({
        hub: {
          contextKey: hubContextKey,
          revision: revisions.hubSkillsRevision,
        },
        localRevision: revisions.localSkillsRevision,
        workspaces: workspacesForContext.map((workspace) => ({
          id: workspace.id,
          label: workspace.label,
          path: workspace.path,
        })),
      });

    const getSkillInventoryRefreshContextKey = (
      workspacesForContext: ReturnType<typeof getLocalSkillInventoryWorkspaces>,
      hubContextKey: string,
      localRevision = localSkillsRevision,
    ) =>
      JSON.stringify({
        hub: {
          contextKey: hubContextKey,
        },
        localRevision,
        workspaces: workspacesForContext.map((workspace) => ({
          id: workspace.id,
          label: workspace.label,
          path: workspace.path,
        })),
      });

    const getCurrentSkillInventoryContextKey = () => {
      const localWorkspaces = getLocalSkillInventoryWorkspaces();
      const hubContext = resolveHubSkillsRefreshContext();
      return getSkillInventoryContextKey(localWorkspaces, hubContext.contextKey);
    };

    const getCurrentSkillInventoryRefreshContextKey = () => {
      const localWorkspaces = getLocalSkillInventoryWorkspaces();
      const hubContext = resolveHubSkillsRefreshContext();
      return getSkillInventoryRefreshContextKey(localWorkspaces, hubContext.contextKey);
    };

    for (;;) {
      if (refreshSkillInventoryInFlight) {
        const inFlightContextKey = refreshSkillInventoryInFlightContextKey;
        const inFlightRefresh = refreshSkillInventoryPromise;
        const result = inFlightRefresh ? await inFlightRefresh : "stale";
        forceRefresh = false;
        if (result === "failed" || result === "aborted") {
          if (inFlightContextKey && getCurrentSkillInventoryRefreshContextKey() !== inFlightContextKey) continue;
          return;
        }
        if (result === "published" && getCurrentSkillInventoryContextKey() === skillInventoryContextKey) return;
        continue;
      }

      const localWorkspaces = getLocalSkillInventoryWorkspaces();
      const hubContext = resolveHubSkillsRefreshContext();
      const nextContextKey = getSkillInventoryContextKey(localWorkspaces, hubContext.contextKey);
      const nextRefreshContextKey = getSkillInventoryRefreshContextKey(localWorkspaces, hubContext.contextKey);
      const hubRefreshInFlightForCurrentContext =
        refreshHubSkillsInFlight && refreshHubSkillsInFlightContextKey === hubContext.contextKey;

      if (nextContextKey !== skillInventoryContextKey) {
        skillInventoryLoaded = false;
      }

      if (!forceRefresh && skillInventoryLoaded && !hubRefreshInFlightForCurrentContext) return;

      const refreshOptions = forceRefresh ? { force: true } : undefined;
      refreshSkillInventoryInFlight = true;
      refreshSkillInventoryInFlightContextKey = nextRefreshContextKey;
      refreshSkillInventoryAborted = false;
      refreshSkillInventoryPromise = (async (): Promise<SkillInventoryRefreshResult> => {
        try {
          setSkillInventoryStatus(null);
          await refreshHubSkills(refreshOptions);
          if (refreshSkillInventoryAborted) return "aborted";

          const refreshedHubContext = resolveHubSkillsRefreshContext();
          if (hubSkillsContextKey !== refreshedHubContext.contextKey) {
            await refreshHubSkills({ force: true });
            if (refreshSkillInventoryAborted) return "aborted";
          }

          const inventoryHubContext = resolveHubSkillsRefreshContext();
          const hasMatchingHubSkills = hubSkillsLoaded && hubSkillsContextKey === inventoryHubContext.contextKey;
          const inventoryContextAtStart = getSkillInventoryContextKey(localWorkspaces, inventoryHubContext.contextKey);

          const listScopedSkills = options.listLocalSkillsScoped ?? listLocalSkillsScopedCommand;
          const globalSkills = await listScopedSkills("", "global");
          if (refreshSkillInventoryAborted) return "aborted";

          const workspaceSkillsByWorkspaceId: BuildSkillInventoryInput["workspaceSkillsByWorkspaceId"] = {};

          for (const workspace of localWorkspaces) {
            const skills = await listScopedSkills(workspace.path, "workspace");
            if (refreshSkillInventoryAborted) return "aborted";
            workspaceSkillsByWorkspaceId[workspace.id] = {
              workspace: {
                id: workspace.id,
                label: workspace.label,
                path: workspace.path,
                kind: "local",
              },
              skills,
            };
          }

          const currentHubContext = resolveHubSkillsRefreshContext();
          const currentContextKey = getSkillInventoryContextKey(
            getLocalSkillInventoryWorkspaces(),
            currentHubContext.contextKey,
          );
          if (currentContextKey !== inventoryContextAtStart) {
            skillInventoryLoaded = false;
            return "stale";
          }

          const next = buildSkillInventory({
            globalSkills,
            workspaceSkillsByWorkspaceId,
            hubSkills: hasMatchingHubSkills ? hubSkills() : [],
          });
          if (refreshSkillInventoryAborted) return "aborted";

          setSkillInventory(next);
          if (!next.length) {
            setSkillInventoryStatus(translate("skills.no_skills_found"));
          } else if (!hasMatchingHubSkills && hubSkillsStatus()) {
            setSkillInventoryStatus(hubSkillsStatus());
          }
          skillInventoryLoaded = hasMatchingHubSkills;
          skillInventoryContextKey = inventoryContextAtStart;
          return "published";
        } catch (e) {
          if (refreshSkillInventoryAborted) return "aborted";
          skillInventoryLoaded = false;
          setSkillInventory([]);
          setSkillInventoryStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
          return "failed";
        } finally {
          refreshSkillInventoryInFlight = false;
          refreshSkillInventoryInFlightContextKey = "";
          refreshSkillInventoryPromise = null;
        }
      })();

      const result = await refreshSkillInventoryPromise;
      forceRefresh = false;
      if (result === "failed" || result === "aborted") {
        if (getCurrentSkillInventoryRefreshContextKey() !== nextRefreshContextKey) continue;
        return;
      }
      if (result === "published") return;
      continue;
    }
  }

  async function invalidateSkillRegistryInventory() {
    markHubSkillsSourceChanged();
    markLocalSkillsSourceChanged();
    skillInventoryLoaded = false;
    await refreshSkillInventory({ force: true });
  }

  async function installHubSkill(name: string, target: HubSkillInstallTarget): Promise<{ ok: boolean; message: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };
    if (!target) return { ok: false, message: translate("skills.install_target_required") };
    if (target.scope === "global") {
      return { ok: false, message: translate("skills.install_target_global_unavailable") };
    }

    const targetWorkspaceId = target.workspaceId.trim();
    if (!targetWorkspaceId) return { ok: false, message: translate("skills.install_target_required") };
    if (targetWorkspaceId !== options.activeWorkspaceId().trim()) {
      return { ok: false, message: translate("skills.install_target_switch_workspace") };
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.hub?.skills?.install &&
      typeof (vesloClient as any).installHubSkill === "function";

    if (!canUseVesloServer) {
      if (isRemoteWorkspace) {
        return { ok: false, message: "Veslo server unavailable. Connect to install skills." };
      }
      return { ok: false, message: "Hub install requires Veslo server." };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const result = await (vesloClient as any).installHubSkill(vesloWorkspaceId, trimmed);
      await refreshSkills({ force: true });
      await refreshHubSkills({ force: true });
      if (!result?.ok) {
        return { ok: false, message: "Install failed." };
      }
      return { ok: true, message: `Installed ${trimmed}.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function installHubMcp(name: string): Promise<{ ok: boolean; message: string; entry?: HubMcpCard }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "MCP name is required." };

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.hub?.mcp?.install &&
      typeof (vesloClient as any).installHubMcp === "function";

    if (!canUseVesloServer) {
      if (isRemoteWorkspace) {
        return { ok: false, message: "Veslo server unavailable. Connect to install MCP." };
      }
      return { ok: false, message: "Hub install requires Veslo server." };
    }

    options.setBusy(true);
    options.setError(null);
    setHubMcpStatus(null);

    try {
      const selectedEntry = hubMcpCards().find((entry) => entry.id === trimmed || entry.name === trimmed);
      const denAuth = readDenAuth();
      const denToken = denAuth?.token?.trim() ?? "";
      const denOrgId = denAuth?.orgId?.trim() ?? "";
      if (!denToken || !denOrgId) {
        return { ok: false, message: "Missing Den auth context." };
      }

      const result = await (vesloClient as any).installHubMcp(vesloWorkspaceId, trimmed, {
        denToken,
        denOrgId,
      });
      await refreshHubMcp({ force: true });
      if (!result?.ok) {
        return { ok: false, message: "Install failed." };
      }
      return { ok: true, message: `Installed ${trimmed}.`, ...(selectedEntry ? { entry: selectedEntry } : {}) };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.skills?.read;

    if (!root) {
      setSkills([]);
      markLocalSkillsSourceChanged();
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    // Prefer Veslo server when available
    if (canUseVesloServer) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
        const response = await vesloClient.listSkills(vesloWorkspaceId, {
          includeGlobal: isLocalWorkspace,
        });
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];
        setSkills(next);
        markLocalSkillsSourceChanged();
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        markLocalSkillsSourceChanged();
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    // Host/Tauri mode fallback: read directly from `.opencode/skills` or `.claude/skills`
    // so the UI still works even if the OpenCode engine is stopped or unreachable.
    if (root && isLocalWorkspace && isTauriRuntime()) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
        const local = await listLocalSkills(root);
        if (refreshSkillsAborted) return;

        const next: SkillCard[] = Array.isArray(local)
          ? local.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];

        setSkills(next);
        markLocalSkillsSourceChanged();
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        markLocalSkillsSourceChanged();
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    const c = options.client();
    if (!c) {
      setSkills([]);
      markLocalSkillsSourceChanged();
      setSkillsStatus("Veslo server unavailable. Connect to load skills.");
      return;
    }

    if (root !== skillsRoot) {
      skillsLoaded = false;
    }

    if (!optionsOverride?.force && skillsLoaded) {
      return;
    }

    if (refreshSkillsInFlight) {
      return;
    }

    refreshSkillsInFlight = true;
    refreshSkillsAborted = false;

    try {
      setSkillsStatus(null);

      if (refreshSkillsAborted) return;

      const rawClient = c as unknown as { _client?: { get: (input: { url: string }) => Promise<any> } };
      if (!rawClient._client) {
        throw new Error("OpenCode client unavailable.");
      }

      const result = await rawClient._client.get({ url: "/skill" });
      if (result?.data === undefined) {
        const err = result?.error;
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : translate("skills.failed_to_load");
        throw new Error(message);
      }
      const data = result.data as Array<{
        name: string;
        description: string;
        location: string;
      }>;

      if (refreshSkillsAborted) return;

      const next: SkillCard[] = Array.isArray(data)
        ? data.map((entry) => ({
            name: entry.name,
            description: entry.description,
            path: formatSkillPath(entry.location),
          }))
        : [];

      setSkills(next);
      markLocalSkillsSourceChanged();
      if (!next.length) {
        setSkillsStatus(translate("skills.no_skills_found"));
      }
      skillsLoaded = true;
      skillsRoot = root;
    } catch (e) {
      if (refreshSkillsAborted) return;
      setSkills([]);
      markLocalSkillsSourceChanged();
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.plugins?.read;

    // Skip if already in flight
    if (refreshPluginsInFlight) {
      return;
    }

    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      setPluginList([]);
      setSidebarPluginStatus("Global plugins require a local worker.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && canUseVesloServer) {
      setPluginConfig(null);
      setPluginConfigPath(`opencode.json (${isRemoteWorkspace ? "remote" : "veslo"} server)`);

      try {
        setPluginStatus(null);
        setSidebarPluginStatus(null);

        if (refreshPluginsAborted) return;

        const result = await vesloClient.listPlugins(vesloWorkspaceId, { includeGlobal: false });
        if (refreshPluginsAborted) return;

        const configItems = result.items.filter((item) => item.source === "config" && item.scope === "project");
        const list = configItems.map((item) => item.spec);
        setPluginList(list);
        setSidebarPluginList(list);

        if (!list.length) {
          setPluginStatus("No plugins configured yet.");
        }
      } catch (e) {
        if (refreshPluginsAborted) return;
        setPluginList([]);
        setSidebarPluginStatus("Failed to load plugins.");
        setSidebarPluginList([]);
        setPluginStatus(e instanceof Error ? e.message : "Failed to load plugins.");
      } finally {
        refreshPluginsInFlight = false;
      }

      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.plugins_host_only"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (!isLocalWorkspace && !canUseVesloServer) {
      setPluginStatus("Veslo server unavailable. Connect to manage plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Connect an Veslo server to load plugins.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.pick_project_for_active"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);

      if (refreshPluginsAborted) return;

      const config = await readOpencodeConfig(scope, targetDir);

      if (refreshPluginsAborted) return;

      setPluginConfig(config);
      setPluginConfigPath(config.path ?? null);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus(translate("skills.no_opencode_found"));
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.no_opencode_workspace"));
        return;
      }

      try {
        const next = parsePluginListFromContent(config.content ?? "");
        setSidebarPluginList(next);
      } catch {
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.failed_parse_opencode"));
      }

      loadPluginsFromConfig(config);
    } catch (e) {
      if (refreshPluginsAborted) return;
      setPluginConfig(null);
      setPluginConfigPath(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_load_opencode"));
      setSidebarPluginStatus(translate("skills.failed_load_active"));
      setSidebarPluginList([]);
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;
    const triggerName = stripPluginVersion(pluginName);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.plugins?.write;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus(translate("skills.enter_plugin_name"));
      }
      return;
    }

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseVesloServer) {
      try {
        setPluginStatus(null);
        await vesloClient.addPlugin(vesloWorkspaceId, pluginName);
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to add plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseVesloServer) {
      setPluginStatus("Veslo server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginName],
        };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus(translate("skills.plugin_already_listed"));
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  async function removePlugin(pluginName: string) {
    const name = pluginName.trim();
    if (!name) return;
    const triggerName = stripPluginVersion(name);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.plugins?.write;

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseVesloServer) {
      try {
        setPluginStatus(null);
        await vesloClient.removePlugin(vesloWorkspaceId, name);
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to remove plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseVesloServer) {
      setPluginStatus("Veslo server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";
      if (!raw.trim()) {
        setPluginStatus("No plugins configured yet.");
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setPluginStatus("Plugin not found.");
        return;
      }

      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  async function importLocalSkill() {
    const isLocalWorkspace = options.workspaceType() === "local";

    if (!isTauriRuntime()) {
      options.setError(translate("skills.desktop_required"));
      return;
    }

    if (!isLocalWorkspace) {
      options.setError("Local workers are required to import skills.");
      return;
    }

    const targetDir = options.projectDir().trim();
    if (!targetDir) {
      options.setError(translate("skills.pick_project_first"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: translate("skills.select_skill_folder") });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return;
      }

      const inferredName = sourceDir.split(/[\\/]/).filter(Boolean).pop();
      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        setSkillsStatus(result.stdout || translate("skills.imported"));
        options.markReloadRequired?.("skills", {
          type: "skill",
          name: inferredName,
          action: "added",
        });
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator(): Promise<{ ok: boolean; message: string }> {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.skills?.write;

    // Use Veslo server when available
    if (canUseVesloServer) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(translate("skills.installing_skill_creator"));

      try {
        const skillCreatorTemplate = await loadSkillCreatorTemplate();
        await vesloClient.upsertSkill(vesloWorkspaceId, {
          name: "skill-creator",
          content: skillCreatorTemplate,
        });
        const message = translate("skills.skill_creator_installed");
        setSkillsStatus(message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      } catch (e) {
        const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
        const message = addOpencodeCacheHint(raw);
        // Ensure we show feedback on the Skills page (not just the global error banner).
        setSkillsStatus(message);
        options.setError(message);
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    // Remote workspace without server
    if (isRemoteWorkspace) {
      const message = "Veslo server unavailable. Connect to install skills.";
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = "Local workers are required to install skills.";
      options.setError(message);
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const targetDir = options.activeWorkspaceRoot().trim();

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(translate("skills.installing_skill_creator"));

    try {
      const skillCreatorTemplate = await loadSkillCreatorTemplate();
      const result = await installSkillTemplate(targetDir, "skill-creator", skillCreatorTemplate, { overwrite: false });

      if (!result.ok && /already exists/i.test(result.stderr)) {
        const message = translate("skills.skill_creator_already_installed");
        setSkillsStatus(message);
        await refreshSkills({ force: true });
        return { ok: true, message };
      } else if (!result.ok) {
        const message = result.stderr || result.stdout || translate("skills.install_failed");
        setSkillsStatus(message);
        await refreshSkills({ force: true });
        return { ok: false, message };
      } else {
        const message = result.stdout || translate("skills.skill_creator_installed");
        setSkillsStatus(message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
      const message = addOpencodeCacheHint(raw);
      setSkillsStatus(message);
      options.setError(message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }

    // Should be unreachable, but keep TS happy.
    return { ok: false, message: translate("skills.install_failed") };
  }

  async function revealSkillsFolder() {
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(null);
      return;
    }

    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      const opencodeSkills = await join(root, ".opencode", "skills");
      const claudeSkills = await join(root, ".claude", "skills");
      const legacySkills = await join(root, ".opencode", "skill");

      const tryOpen = async (target: string) => {
        try {
          await openPath(target);
          return true;
        } catch {
          return false;
        }
      };

      // Prefer opening the folder. `revealItemInDir` expects a file path on macOS.
      if (await tryOpen(opencodeSkills)) return;
      if (await tryOpen(claudeSkills)) return;
      if (await tryOpen(legacySkills)) return;
      await revealItemInDir(opencodeSkills);
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.reveal_failed"));
    }
  }

  async function uninstallSkill(name: string) {
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    if (options.workspaceType() !== "local") {
      options.setError("Local workers are required to uninstall skills.");
      return;
    }

    const root = options.activeWorkspaceRoot().trim();

    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const result = await uninstallSkillCommand(root, trimmed);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.uninstall_failed"));
      } else {
        setSkillsStatus(result.stdout || translate("skills.uninstalled"));
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function readSkill(name: string, instancePath?: string): Promise<{ name: string; path: string; content: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const root = options.activeWorkspaceRoot().trim();

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.skills?.read &&
      typeof (vesloClient as any).getSkill === "function";

    if (canUseVesloServer) {
      try {
        setSkillsStatus(null);
        const result = await (vesloClient as VesloServerClient & { getSkill: any }).getSkill(
          vesloWorkspaceId,
          trimmed,
          { includeGlobal: isLocalWorkspace, ...(instancePath?.trim() ? { path: instancePath.trim() } : {}) },
        );
        return {
          name: result.item.name,
          path: result.item.path,
          content: result.content,
        };
      } catch (e) {
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
        return null;
      }
    }

    if (isRemoteWorkspace) {
      setSkillsStatus("Veslo server unavailable. Connect to view skills.");
      return null;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return null;
    }

    if (!isLocalWorkspace) {
      setSkillsStatus("Local workers are required to view skills.");
      return null;
    }

    try {
      setSkillsStatus(null);
      const localInstancePath = instancePath?.trim() ? skillEntryFilePathForMutationPath(instancePath) : undefined;
      const result = instancePath?.trim()
        ? await readLocalSkillAtPath(root, trimmed, localInstancePath!)
        : await readLocalSkill(root, trimmed);
      return { name: trimmed, path: result.path, content: result.content };
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      return null;
    }
  }

  const normalizeSkillMutationPath = (value: string | undefined) =>
    String(value ?? "").trim().replace(/\\/g, "/");

  const skillEntryFilePathForMutationPath = (value: string | undefined) => {
    const normalized = normalizeSkillMutationPath(value);
    if (!normalized) return "";
    if (/[\/](?:SKILL\.md|AGENTS\.md)$/i.test(normalized)) return normalized;
    return `${normalized}/SKILL.md`;
  };

  const isManagedSkillMutationPath = (value: string | undefined) =>
    normalizeSkillMutationPath(value).includes("/.opencode/skills/veslo-managed/");

  const activeSkillForMutationTarget = (target: SkillMutationTarget):
    | { skill: SkillCard; normalizedPath: string; entryFilePath: string }
    | { message: string } => {
    const name = target.name.trim();
    const normalizedPath = normalizeSkillMutationPath(target.path);
    if (!name || !normalizedPath) {
      return { message: translate("skills.failed_load_skill") };
    }
    if (target.scope !== "workspace") {
      return { message: translate("skills.uninstall_scope_ambiguous") };
    }
    const targetWorkspaceId = target.workspaceId?.trim();
    if (targetWorkspaceId && targetWorkspaceId !== options.activeWorkspaceId().trim()) {
      return { message: translate("skills.uninstall_not_active_workspace") };
    }

    const skill = skills().find((candidate) =>
      candidate.name === name && normalizeSkillMutationPath(candidate.path) === normalizedPath
    );
    if (!skill) {
      return { message: translate("skills.failed_load_skill") };
    }
    return { skill, normalizedPath, entryFilePath: skillEntryFilePathForMutationPath(skill.path) };
  };

  async function readSkillInstance(target: SkillMutationTarget): Promise<{ name: string; path: string; content: string } | null> {
    const resolved = activeSkillForMutationTarget(target);
    if ("message" in resolved) {
      setSkillsStatus(resolved.message);
      return null;
    }

    const result = await readSkill(resolved.skill.name, resolved.skill.path);
    if (!result) return null;
    if (skillEntryFilePathForMutationPath(result.path) !== resolved.entryFilePath) {
      setSkillsStatus(translate("skills.failed_load_skill"));
      return null;
    }
    return {
      name: resolved.skill.name,
      path: resolved.entryFilePath,
      content: result.content,
    };
  }

  async function saveSkillInstance(target: SkillMutationTarget, content: string): Promise<SkillSaveResult> {
    const resolved = activeSkillForMutationTarget(target);
    if ("message" in resolved) {
      setSkillsStatus(resolved.message);
      return { ok: false, message: resolved.message };
    }

    const current = await readSkill(resolved.skill.name, resolved.skill.path);
    if (!current || skillEntryFilePathForMutationPath(current.path) !== resolved.entryFilePath) {
      const message = translate("skills.failed_save_skill");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (isManagedSkillMutationPath(resolved.skill.path)) {
      const message = translate("skills.registry_action_pending");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    return saveSkill({
      name: resolved.skill.name,
      path: resolved.skill.path,
      content,
      description: resolved.skill.description,
    });
  }

  async function deleteSkillInstance(target: SkillMutationTarget): Promise<void> {
    const resolved = activeSkillForMutationTarget(target);
    if ("message" in resolved) {
      setSkillsStatus(resolved.message);
      return;
    }

    if (isManagedSkillMutationPath(resolved.skill.path)) {
      setSkillsStatus(translate("skills.registry_action_pending"));
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.skills?.write &&
      typeof (vesloClient as any).deleteSkill === "function";

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      if (canUseVesloServer) {
        await (vesloClient as VesloServerClient & {
          deleteSkill: (workspaceId: string, name: string, options?: { path?: string }) => Promise<unknown>;
        }).deleteSkill(vesloWorkspaceId, resolved.skill.name, { path: resolved.skill.path });
      } else {
        if (isRemoteWorkspace) {
          throw new Error("Veslo server unavailable. Connect to delete skills.");
        }
        if (!isTauriRuntime()) {
          throw new Error(translate("skills.desktop_required"));
        }
        if (!isLocalWorkspace) {
          throw new Error("Local workers are required to delete skills.");
        }
        const result = await uninstallSkillAtPath(root, resolved.skill.name, resolved.entryFilePath);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || translate("skills.uninstall_failed"));
        }
      }

      setSkillsStatus(translate("skills.uninstalled"));
      options.markReloadRequired?.("skills", { type: "skill", name: resolved.skill.name, action: "removed" });
      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function copySkillInstanceToGlobal(
    target: SkillMutationTarget,
    optionsOverride?: { deleteSource?: boolean },
  ): Promise<SkillSaveResult> {
    const name = target.name.trim();
    const entryFilePath = skillEntryFilePathForMutationPath(target.path);
    if (!name || !entryFilePath) {
      const message = translate("skills.failed_load_skill");
      setSkillsStatus(message);
      return { ok: false, message };
    }
    if (target.scope !== "workspace") {
      const message = translate("skills.copy_to_global_unavailable");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (isManagedSkillMutationPath(target.path)) {
      const message = translate("skills.registry_action_pending");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const targetWorkspaceId = target.workspaceId?.trim() ?? "";
    const isActiveWorkspaceTarget = !targetWorkspaceId || targetWorkspaceId === options.activeWorkspaceId().trim();
    const configuredWorkspace = targetWorkspaceId
      ? (options.workspaces?.() ?? []).find((workspace) => workspace.id === targetWorkspaceId) ?? null
      : null;
    const sourceWorkspaceType = isActiveWorkspaceTarget
      ? options.workspaceType()
      : configuredWorkspace?.workspaceType ?? null;
    const sourceRoot = isActiveWorkspaceTarget
      ? options.activeWorkspaceRoot().trim()
      : configuredWorkspace?.path?.trim() || configuredWorkspace?.directory?.trim() || "";

    if (sourceWorkspaceType !== "local" || !sourceRoot) {
      const message = translate("skills.copy_to_global_workspace_local_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    // Cross-location transfers are retarget operations: one active source per skill.
    const deleteSource = true;
    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const current = await readLocalSkillAtPath(sourceRoot, name, entryFilePath);
      if (!current || skillEntryFilePathForMutationPath(current.path) !== entryFilePath) {
        const message = translate("skills.failed_load_skill");
        setSkillsStatus(message);
        return { ok: false, message };
      }

      const installResult = await installGlobalSkillTemplate(name, current.content, { overwrite: false });
      if (!installResult.ok) {
        const message = installResult.stderr || installResult.stdout || translate("skills.failed_save_skill");
        setSkillsStatus(message);
        return { ok: false, message };
      }

      if (deleteSource) {
        const deleteResult = await uninstallSkillAtPath(sourceRoot, name, entryFilePath);
        if (!deleteResult.ok) {
          throw new Error(deleteResult.stderr || deleteResult.stdout || translate("skills.uninstall_failed"));
        }
      }

      const message = translate(deleteSource ? "skills.moved_to_global" : "skills.copied_to_global");
      setSkillsStatus(message);
      if (isActiveWorkspaceTarget) {
        options.markReloadRequired?.("skills", {
          type: "skill",
          name,
          action: deleteSource ? "updated" : "added",
        });
        await refreshSkills({ force: true });
      }
      await refreshSkillInventory({ force: true });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      const hintedMessage = addOpencodeCacheHint(message);
      options.setError(hintedMessage);
      return { ok: false, message: hintedMessage };
    } finally {
      options.setBusy(false);
    }
  }

  async function copySkillInstanceToWorkspace(
    target: SkillMutationTarget,
    workspaceId: string,
  ): Promise<SkillSaveResult> {
    const trimmed = target.name.trim();
    const normalizedPath = normalizeSkillMutationPath(target.path);
    const entryFilePath = skillEntryFilePathForMutationPath(target.path);
    if (!trimmed || !normalizedPath || !entryFilePath) {
      const message = translate("skills.failed_load_skill");
      setSkillsStatus(message);
      return { ok: false, message };
    }
    if (target.scope !== "user-global") {
      const message = translate("skills.copy_to_workspace_unavailable");
      setSkillsStatus(message);
      return { ok: false, message };
    }
    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const targetWorkspaceId = workspaceId.trim();
    if (!targetWorkspaceId) {
      const message = translate("skills.install_workspace_target_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const configuredWorkspace = (options.workspaces?.() ?? []).find((workspace) => workspace.id === targetWorkspaceId) ?? null;
    const isActiveWorkspace = targetWorkspaceId === options.activeWorkspaceId().trim();
    const targetWorkspaceType = configuredWorkspace?.workspaceType ?? (isActiveWorkspace ? options.workspaceType() : null);
    const targetDir = (
      configuredWorkspace?.path?.trim() ||
      configuredWorkspace?.directory?.trim() ||
      (isActiveWorkspace ? options.activeWorkspaceRoot().trim() : "")
    );

    if (targetWorkspaceType !== "local" || !targetDir) {
      const message = translate("skills.install_workspace_target_local_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const current = await readLocalSkillAtPath(targetDir, trimmed, entryFilePath);
      if (normalizeSkillMutationPath(current.path) !== entryFilePath) {
        const message = translate("skills.failed_load_skill");
        setSkillsStatus(message);
        return { ok: false, message };
      }

      const installResult = await installSkillTemplate(targetDir, trimmed, current.content, { overwrite: false });
      if (!installResult.ok) {
        const message = installResult.stderr || installResult.stdout || translate("skills.failed_save_skill");
        setSkillsStatus(message);
        return { ok: false, message };
      }

      const deleteResult = await uninstallSkillAtPath(targetDir, trimmed, entryFilePath);
      if (!deleteResult.ok) {
        throw new Error(deleteResult.stderr || deleteResult.stdout || translate("skills.uninstall_failed"));
      }

      const message = translate("skills.copied_to_workspace");
      setSkillsStatus(message);
      if (isActiveWorkspace) {
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "added" });
        await refreshSkills({ force: true });
      }
      await refreshSkillInventory({ force: true });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      const hintedMessage = addOpencodeCacheHint(message);
      options.setError(hintedMessage);
      return { ok: false, message: hintedMessage };
    } finally {
      options.setBusy(false);
    }
  }

  async function saveSkill(input: { name: string; path?: string; content: string; description?: string }): Promise<SkillSaveResult> {
    const trimmed = input.name.trim();
    if (!trimmed) return { ok: false, message: translate("skills.bundle_missing_name") };

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      const message = translate("skills.pick_workspace_first");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const vesloClient = options.vesloServerClient();
    const vesloWorkspaceId = options.vesloServerWorkspaceId();
    const vesloCapabilities = options.vesloServerCapabilities();
    const canUseVesloServer =
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.skills?.write;

    if (canUseVesloServer) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);
      try {
        await vesloClient.upsertSkill(vesloWorkspaceId, {
          name: trimmed,
          ...(input.path?.trim() ? { path: input.path.trim() } : {}),
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        const message = "Saved.";
        setSkillsStatus(message);
        return { ok: true, message };
      } catch (e) {
        const message = e instanceof Error ? e.message : translate("skills.unknown_error");
        const hintedMessage = addOpencodeCacheHint(message);
        options.setError(hintedMessage);
        return { ok: false, message: hintedMessage };
      } finally {
        options.setBusy(false);
      }
    }

    if (isRemoteWorkspace) {
      const message = "Veslo server unavailable. Connect to edit skills.";
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = "Local workers are required to edit skills.";
      setSkillsStatus(message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);
    try {
      const localInstancePath = input.path?.trim() ? skillEntryFilePathForMutationPath(input.path) : undefined;
      const result = localInstancePath
        ? await writeLocalSkillAtPath(root, trimmed, localInstancePath, input.content)
        : await writeLocalSkill(root, trimmed, input.content);
      const message = result.stderr || result.stdout || translate("skills.unknown_error");
      if (!result.ok) {
        setSkillsStatus(message);
        await refreshSkills({ force: true });
        return { ok: false, message };
      } else {
        const successMessage = result.stdout || "Saved.";
        setSkillsStatus(successMessage);
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        return { ok: true, message: successMessage };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      const hintedMessage = addOpencodeCacheHint(message);
      options.setError(hintedMessage);
      return { ok: false, message: hintedMessage };
    } finally {
      options.setBusy(false);
    }
  }

  function abortRefreshes() {
    refreshSkillsAborted = true;
    refreshSkillInventoryAborted = true;
    refreshPluginsAborted = true;
    refreshHubSkillsAborted = true;
    refreshHubMcpAborted = true;
  }

  return {
    skills,
    skillsStatus,
    skillInventory,
    skillInventoryStatus,
    hubSkills,
    hubSkillsStatus,
    hubMcpCards,
    hubMcpStatus,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshSkillInventory,
    invalidateSkillRegistryInventory,
    refreshHubSkills,
    refreshHubMcp,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    readSkillInstance,
    saveSkillInstance,
    deleteSkillInstance,
    copySkillInstanceToGlobal,
    copySkillInstanceToWorkspace,
    installHubMcp,
    abortRefreshes,
  };
}
