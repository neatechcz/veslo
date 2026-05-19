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
  SkillInstance,
  SkillInventoryItem,
  ManagedSkillSource,
  SkillSaveResult,
  WorkspaceSkillRolloutRemovalPolicy,
} from "../types";
import { addOpencodeCacheHint, isTauriRuntime } from "../utils";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../utils/plugins";
import {
  buildSkillInventory,
  type BuildSkillInventoryInput,
  type SkillInventorySkillInput,
  type SkillMutationTarget,
} from "../lib/skill-inventory";
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
  VesloDisabledSkillRecord,
  VesloSkillBatchRemoveResponse,
  VesloSkillMaterializationRequestOptions,
  VesloSkillRemovalItem,
  VesloSkillRemovalScope,
  VesloServerStatus,
} from "../lib/veslo-server";
import { readDenAuth } from "../lib/den-auth";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;
type ListLocalSkillsScoped = (projectDir: string, scope: LocalSkillListScope) => Promise<LocalSkillCard[]>;
type SkillInventoryRefreshResult = "published" | "stale" | "failed" | "aborted";
type LocalSkillInventoryWorkspace = { id: string; label: string; path: string };
type ManagedSkillMutationTarget = SkillMutationTarget & {
  registry?: SkillInstance["registry"];
  restoreTarget?: SkillInstance["restoreTarget"];
};

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

import type { WorkspaceRouting } from "./workspace-routing";

export function createExtensionsStore(options: {
  client: () => Client | null;
  routing: WorkspaceRouting;
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
      setHubMcpStatus(e instanceof Error ? e.message : __vesloIndirectT("ui.indirect.failed_to_load_hub_mcp_1s9f65", __vesloIndirectLocale()));
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
        setHubSkillsStatus(e instanceof Error ? e.message : __vesloIndirectT("ui.indirect.failed_to_load_hub_skills_1u0vcu", __vesloIndirectLocale()));
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

    const getSkillRemovalClient = () => {
      const vesloClient = options.vesloServerClient();
      if (
        options.vesloServerStatus() === "connected" &&
        vesloClient &&
        typeof (vesloClient as Record<string, unknown>).listSkillRemovals === "function"
      ) {
        return vesloClient as VesloServerClient & {
          listSkillRemovals: (params?: {
            scope?: VesloSkillRemovalScope;
            workspaceId?: string;
            includeRestored?: boolean;
          }) => Promise<{ items: VesloSkillRemovalItem[] }>;
        };
      }
      return null;
    };

    const removedSkillInputFromRecord = (
      record: VesloSkillRemovalItem,
      fallback: { scope: VesloSkillRemovalScope; workspaceId?: string },
    ): SkillInventorySkillInput | null => {
      const id = record.id?.trim() ?? "";
      const name = record.name?.trim() ?? "";
      const scope = record.scope === "workspace" || record.scope === "user-global"
        ? record.scope
        : fallback.scope;
      if (!id || !name || record.status === "restored") return null;
      const path = record.path?.trim() || `veslo-removal:${id}`;
      return {
        name,
        path,
        scope,
        source: "unknown",
        lifecycle: "removed",
        removedAt: record.removedAt,
        removeReason: record.reason,
        restoreTarget: {
          scope,
          ...(scope === "workspace" ? { workspaceId: record.workspaceId?.trim() || fallback.workspaceId } : {}),
          removalId: id,
        },
        readable: false,
        writable: false,
      };
    };

    const listRemovedSkillInputs = async (
      client: ReturnType<typeof getSkillRemovalClient>,
      params: { scope: VesloSkillRemovalScope; workspaceId?: string },
    ): Promise<SkillInventorySkillInput[]> => {
      if (!client) return [];
      try {
        const response = await client.listSkillRemovals(params);
        return Array.isArray(response.items)
          ? response.items
              .map((record) => removedSkillInputFromRecord(record, params))
              .filter((record): record is SkillInventorySkillInput => Boolean(record))
          : [];
      } catch {
        return [];
      }
    };

    type SkillMaterializationEntryLike = {
      installationId?: string;
      skillId?: string;
      name?: string;
      versionId?: string;
      packageSha256?: string;
      source?: string;
      target?: string;
      removalPolicy?: string;
      skillDir?: string;
    };

    type SkillMaterializationStatusLike = {
      rootDir?: string;
      materializedSkills?: SkillMaterializationEntryLike[];
    };

    type SkillMaterializationClient = VesloServerClient & {
      getGlobalSkillMaterializationStatus?: () => Promise<SkillMaterializationStatusLike>;
      getWorkspaceSkillMaterializationStatus?: (workspaceId: string) => Promise<SkillMaterializationStatusLike>;
      syncGlobalSkillMaterialization?: (options?: VesloSkillMaterializationRequestOptions) => Promise<unknown>;
      syncWorkspaceSkillMaterialization?: (
        workspaceId: string,
        options?: VesloSkillMaterializationRequestOptions,
      ) => Promise<unknown>;
    };

    const getSkillMaterializationClient = (): SkillMaterializationClient | null => {
      const vesloClient = options.vesloServerClient();
      if (options.vesloServerStatus() !== "disconnected" && vesloClient) {
        return vesloClient as SkillMaterializationClient;
      }
      return null;
    };

    const materializedSkillEntryPath = (value: string | undefined) => {
      const normalized = String(value ?? "").trim().replace(/\\/g, "/");
      if (!normalized) return "";
      if (/[\/](?:SKILL\.md|AGENTS\.md)$/i.test(normalized)) return normalized;
      return `${normalized}/SKILL.md`;
    };

    const inventoryScopeFromManagedSource = (
      source: ManagedSkillSource | undefined,
      fallback: SkillInventorySkillInput["scope"],
    ): SkillInventorySkillInput["scope"] => {
      if (source === "personal") return "user-global";
      if (source === "workspace") return "workspace";
      if (source === "organization" || source === "platform") return source;
      return fallback;
    };

    const registryMetadataFromMaterializationEntry = (
      entry: SkillMaterializationEntryLike,
    ): SkillInventorySkillInput["registry"] | null => {
      const installationId = entry.installationId?.trim() ?? "";
      if (!installationId) return null;
      const normalizeMaterializationSource = (): ManagedSkillSource => {
        const source = entry.source?.trim();
        if (source === "personal" || source === "workspace" || source === "organization" || source === "platform") {
          return source;
        }
        return entry.target === "workspace" ? "workspace" : "personal";
      };
      const normalizeMaterializationRemovalPolicy = (): WorkspaceSkillRolloutRemovalPolicy => {
        const removalPolicy = entry.removalPolicy?.trim();
        if (removalPolicy === "user_removable" || removalPolicy === "admin_removable" || removalPolicy === "locked") {
          return removalPolicy;
        }
        return "user_removable";
      };
      const common = {
        ...(entry.skillId?.trim() ? { skillId: entry.skillId.trim() } : {}),
        ...(entry.versionId?.trim() ? { versionId: entry.versionId.trim() } : {}),
        ...(entry.packageSha256?.trim() ? { packageSha256: entry.packageSha256.trim() } : {}),
        source: normalizeMaterializationSource(),
        removalPolicy: normalizeMaterializationRemovalPolicy(),
      };
      if (installationId.startsWith("rollout:")) {
        const policyId = installationId.slice("rollout:".length).trim();
        return policyId ? { ...common, policyId } : null;
      }
      return {
        ...common,
        installationId,
      };
    };

    const materializationRegistryIndex = (
      status: SkillMaterializationStatusLike | null | undefined,
    ): Map<string, NonNullable<SkillInventorySkillInput["registry"]>> => {
      const index = new Map<string, NonNullable<SkillInventorySkillInput["registry"]>>();
      const rootDir = status?.rootDir?.trim() ?? "";
      for (const entry of status?.materializedSkills ?? []) {
        const name = entry.name?.trim() ?? "";
        const skillDir = entry.skillDir?.trim() || (rootDir && name ? `${rootDir}/${name}` : "");
        const path = materializedSkillEntryPath(skillDir);
        const registry = registryMetadataFromMaterializationEntry(entry);
        if (path && registry) index.set(path, registry);
      }
      return index;
    };

    const loadGlobalMaterializationRegistryIndex = async () => {
      const client = getSkillMaterializationClient();
      if (typeof client?.getGlobalSkillMaterializationStatus !== "function") {
        return new Map<string, NonNullable<SkillInventorySkillInput["registry"]>>();
      }
      try {
        return materializationRegistryIndex(await client.getGlobalSkillMaterializationStatus());
      } catch {
        return new Map<string, NonNullable<SkillInventorySkillInput["registry"]>>();
      }
    };

    const loadWorkspaceMaterializationRegistryIndex = async (workspaceId: string) => {
      const client = getSkillMaterializationClient();
      if (!workspaceId || typeof client?.getWorkspaceSkillMaterializationStatus !== "function") {
        return new Map<string, NonNullable<SkillInventorySkillInput["registry"]>>();
      }
      try {
        return materializationRegistryIndex(await client.getWorkspaceSkillMaterializationStatus(workspaceId));
      } catch {
        return new Map<string, NonNullable<SkillInventorySkillInput["registry"]>>();
      }
    };

    const loadDisabledSkillRecords = async (
      workspacesForInventory: ReturnType<typeof getLocalSkillInventoryWorkspaces>,
    ): Promise<VesloDisabledSkillRecord[]> => {
      const vesloClient = options.vesloServerClient();
      if (options.vesloServerStatus() !== "connected" || typeof vesloClient?.listDisabledSkills !== "function") {
        return [];
      }

      const workspaceIds = Array.from(
        new Set(
          workspacesForInventory
            .map((workspace) => workspace.id.trim())
            .filter(Boolean),
        ),
      );

      const requests = workspaceIds.length > 0 ? workspaceIds.map((workspaceId) => ({ workspaceId })) : [undefined];
      const records: VesloDisabledSkillRecord[] = [];
      for (const request of requests) {
        try {
          const response = await vesloClient.listDisabledSkills(request);
          if (Array.isArray(response.items)) records.push(...response.items);
        } catch {
          // Disabled-state inventory is additive UI metadata; keep skills visible if the API is unavailable.
        }
      }

      const byId = new Map<string, VesloDisabledSkillRecord>();
      for (const record of records) {
        if (record?.id) byId.set(record.id, record);
      }
      return Array.from(byId.values());
    };

    const skillInputScope = (
      skill: SkillInventorySkillInput,
      fallbackScope: NonNullable<SkillInventorySkillInput["scope"]>,
    ): NonNullable<SkillInventorySkillInput["scope"]> =>
      skill.scope ?? inventoryScopeFromManagedSource(skill.registry?.source, fallbackScope) ?? fallbackScope;

    const disabledRecordMatchesSkillInput = (
      record: VesloDisabledSkillRecord,
      skill: SkillInventorySkillInput,
      fallbackScope: NonNullable<SkillInventorySkillInput["scope"]>,
      workspaceId?: string,
    ) => {
      const scope = skillInputScope(skill, fallbackScope);
      if (record.scope !== scope) return false;
      if (record.scope === "workspace" && record.workspaceId?.trim() && record.workspaceId.trim() !== workspaceId) {
        return false;
      }

      const recordPath = materializedSkillEntryPath(record.path);
      const skillPath = materializedSkillEntryPath(skill.path);
      if (recordPath && skillPath && recordPath === skillPath) return true;

      const recordRegistry = record.registry;
      const skillRegistry = skill.registry;
      if (recordRegistry?.policyId && recordRegistry.policyId === skillRegistry?.policyId) return true;
      if (recordRegistry?.installationId && recordRegistry.installationId === skillRegistry?.installationId) return true;

      return record.name?.trim() === skill.name?.trim();
    };

    const attachDisabledSkillState = (
      skills: SkillInventorySkillInput[],
      disabledRecords: VesloDisabledSkillRecord[],
      fallbackScope: NonNullable<SkillInventorySkillInput["scope"]>,
      workspaceId?: string,
    ): SkillInventorySkillInput[] => {
      if (!disabledRecords.length) return skills;
      return skills.map((skill) => {
        const disabled = disabledRecords.some((record) =>
          disabledRecordMatchesSkillInput(record, skill, fallbackScope, workspaceId),
        );
        return disabled ? { ...skill, enabled: false, disabledReason: "user" } : skill;
      });
    };

    const attachMaterializationRegistryMetadata = (
      skills: SkillInventorySkillInput[],
      registryByPath: Map<string, NonNullable<SkillInventorySkillInput["registry"]>>,
    ): SkillInventorySkillInput[] => {
      if (!registryByPath.size) return skills;
      return skills.map((skill) => {
        const path = materializedSkillEntryPath(skill.path);
        const registry = registryByPath.get(path);
        if (!registry) return skill;
        return {
          ...skill,
          path,
          registry: {
            ...skill.registry,
            ...registry,
          },
          scope: inventoryScopeFromManagedSource(registry.source, skill.scope),
          writable: false,
        };
      });
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
        const rerunAfterInFlight = forceRefresh;
        const result = inFlightRefresh ? await inFlightRefresh : "stale";
        forceRefresh = rerunAfterInFlight;
        if (rerunAfterInFlight) continue;
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
          const disabledSkillRecords = await loadDisabledSkillRecords(localWorkspaces);
          if (refreshSkillInventoryAborted) return "aborted";

          const listScopedSkills = options.listLocalSkillsScoped ?? listLocalSkillsScopedCommand;
          const removalClient = getSkillRemovalClient();
          const globalSkills = attachDisabledSkillState(
            attachMaterializationRegistryMetadata(
              await listScopedSkills("", "global"),
              await loadGlobalMaterializationRegistryIndex(),
            ),
            disabledSkillRecords,
            "user-global",
          );
          globalSkills.push(...(await listRemovedSkillInputs(removalClient, { scope: "user-global" })));
          if (refreshSkillInventoryAborted) return "aborted";

          const workspaceSkillsByWorkspaceId: BuildSkillInventoryInput["workspaceSkillsByWorkspaceId"] = {};

          for (const workspace of localWorkspaces) {
            const skills = attachDisabledSkillState(
              attachMaterializationRegistryMetadata(
                await listScopedSkills(workspace.path, "workspace"),
                await loadWorkspaceMaterializationRegistryIndex(workspace.id),
              ),
              disabledSkillRecords,
              "workspace",
              workspace.id,
            );
            skills.push(...(await listRemovedSkillInputs(removalClient, {
              scope: "workspace",
              workspaceId: workspace.id,
            })));
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
    if (!trimmed) return { ok: false, message: __vesloIndirectT("ui.indirect.skill_name_is_required_5te74i", __vesloIndirectLocale()) };
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
        return { ok: false, message: __vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_install_sk_7q26rj", __vesloIndirectLocale()) };
      }
      return { ok: false, message: __vesloIndirectT("ui.indirect.hub_install_requires_veslo_server_yn3vz5", __vesloIndirectLocale()) };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const result = await (vesloClient as any).installHubSkill(vesloWorkspaceId, trimmed);
      await refreshSkills({ force: true });
      await refreshHubSkills({ force: true });
      if (!result?.ok) {
        return { ok: false, message: __vesloIndirectT("ui.indirect.install_failed_1etsn4", __vesloIndirectLocale()) };
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
    if (!trimmed) return { ok: false, message: __vesloIndirectT("ui.indirect.mcp_name_is_required_1eoxeh", __vesloIndirectLocale()) };

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
        return { ok: false, message: __vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_install_mc_wnm5lf", __vesloIndirectLocale()) };
      }
      return { ok: false, message: __vesloIndirectT("ui.indirect.hub_install_requires_veslo_server_yn3vz5", __vesloIndirectLocale()) };
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
        return { ok: false, message: __vesloIndirectT("ui.indirect.missing_den_auth_context_1l81wa", __vesloIndirectLocale()) };
      }

      const result = await (vesloClient as any).installHubMcp(vesloWorkspaceId, trimmed, {
        denToken,
        denOrgId,
      });
      await refreshHubMcp({ force: true });
      if (!result?.ok) {
        return { ok: false, message: __vesloIndirectT("ui.indirect.install_failed_1etsn4", __vesloIndirectLocale()) };
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
              registry: entry.registry,
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
              registry: entry.registry,
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

    const c = options.routing.active();
    if (!c) {
      setSkills([]);
      markLocalSkillsSourceChanged();
      setSkillsStatus(__vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_load_skill_1whzfl", __vesloIndirectLocale()));
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
      setPluginStatus(__vesloIndirectT("ui.indirect.global_plugins_are_only_available_for_local_wo_1cc1zl", __vesloIndirectLocale()));
      setPluginList([]);
      setSidebarPluginStatus(__vesloIndirectT("ui.indirect.global_plugins_require_a_local_worker_1pmhql", __vesloIndirectLocale()));
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
          setPluginStatus(__vesloIndirectT("plugins.no_plugins_yet", __vesloIndirectLocale()));
        }
      } catch (e) {
        if (refreshPluginsAborted) return;
        setPluginList([]);
        setSidebarPluginStatus(__vesloIndirectT("ui.indirect.failed_to_load_plugins_i1skhr", __vesloIndirectLocale()));
        setSidebarPluginList([]);
        setPluginStatus(e instanceof Error ? e.message : __vesloIndirectT("ui.indirect.failed_to_load_plugins_i1skhr", __vesloIndirectLocale()));
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
      setPluginStatus(__vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_manage_plu_1vx4p1", __vesloIndirectLocale()));
      setPluginList([]);
      setSidebarPluginStatus(__vesloIndirectT("ui.indirect.connect_an_veslo_server_to_load_plugins_g3md41", __vesloIndirectLocale()));
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
      setPluginStatus(__vesloIndirectT("ui.indirect.global_plugins_are_only_available_for_local_wo_1cc1zl", __vesloIndirectLocale()));
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
        setPluginStatus(e instanceof Error ? e.message : __vesloIndirectT("ui.indirect.failed_to_add_plugin_p52vxh", __vesloIndirectLocale()));
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseVesloServer) {
      setPluginStatus(__vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_manage_plu_1vx4p1", __vesloIndirectLocale()));
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
      setPluginStatus(__vesloIndirectT("ui.indirect.global_plugins_are_only_available_for_local_wo_1cc1zl", __vesloIndirectLocale()));
      return;
    }

    if (pluginScope() === "project" && canUseVesloServer) {
      try {
        setPluginStatus(null);
        await vesloClient.removePlugin(vesloWorkspaceId, name);
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : __vesloIndirectT("ui.indirect.failed_to_remove_plugin_1fuges", __vesloIndirectLocale()));
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseVesloServer) {
      setPluginStatus(__vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_manage_plu_1vx4p1", __vesloIndirectLocale()));
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
        setPluginStatus(__vesloIndirectT("plugins.no_plugins_yet", __vesloIndirectLocale()));
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setPluginStatus(__vesloIndirectT("ui.indirect.plugin_not_found_1yk6mg", __vesloIndirectLocale()));
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
      const message = __vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_install_sk_7q26rj", __vesloIndirectLocale());
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = __vesloIndirectT("ui.indirect.local_workers_are_required_to_install_skills_1v84gi", __vesloIndirectLocale());
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
      setSkillsStatus(__vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_view_skill_1fomxi", __vesloIndirectLocale()));
      return null;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return null;
    }

    if (!isLocalWorkspace) {
      setSkillsStatus(__vesloIndirectT("ui.indirect.local_workers_are_required_to_view_skills_sfpklk", __vesloIndirectLocale()));
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

  const managedSkillMutationUnavailable = (message: string): SkillSaveResult => {
    setSkillsStatus(message);
    return { ok: false, message };
  };

  const resolveDenRegistryContext = () => {
    const denAuth = readDenAuth();
    return {
      denApiBase: denAuth?.denApiBase?.trim() ?? "",
      denToken: denAuth?.token?.trim() ?? "",
      denOrgId: denAuth?.orgId?.trim() ?? "",
      denUserId: denAuth?.user?.id?.trim() ?? "",
    };
  };

  const requireDenRegistryContext = (): SkillSaveResult | null => {
    const { denToken, denOrgId, denUserId } = resolveDenRegistryContext();
    if (denToken && denOrgId && denUserId) return null;
    return managedSkillMutationUnavailable(translate("skills.managed_den_context_required"));
  };

  const registryMutationClient = <TMethod extends string>(
    method: TMethod,
  ): (VesloServerClient & Record<TMethod, (...args: unknown[]) => Promise<unknown>>) | null => {
    const vesloClient = options.vesloServerClient();
    if (
      options.vesloServerStatus() === "connected" &&
      vesloClient &&
      typeof (vesloClient as Record<string, unknown>)[method] === "function"
    ) {
      return vesloClient as VesloServerClient & Record<TMethod, (...args: unknown[]) => Promise<unknown>>;
    }
    return null;
  };

  const managedSkillMaterializationClient = (): (VesloServerClient & {
    syncGlobalSkillMaterialization?: (options?: VesloSkillMaterializationRequestOptions) => Promise<unknown>;
    syncWorkspaceSkillMaterialization?: (
      workspaceId: string,
      options?: VesloSkillMaterializationRequestOptions,
    ) => Promise<unknown>;
  }) | null => {
    const vesloClient = options.vesloServerClient();
    if (options.vesloServerStatus() === "connected" && vesloClient) {
      return vesloClient;
    }
    return null;
  };

  const managedSkillTargetAffectsActiveRuntime = (target: ManagedSkillMutationTarget) => {
    if (target.scope === "user-global" || target.scope === "platform") return true;
    if (target.scope !== "workspace" && target.scope !== "organization") return false;
    const targetWorkspaceId = target.workspaceId?.trim() || target.restoreTarget?.workspaceId?.trim() || "";
    if (!targetWorkspaceId) return target.scope === "workspace" || target.scope === "organization";
    const activeWorkspaceId = options.activeWorkspaceId().trim();
    const vesloWorkspaceId = options.vesloServerWorkspaceId()?.trim() ?? "";
    return targetWorkspaceId === activeWorkspaceId || Boolean(vesloWorkspaceId && targetWorkspaceId === vesloWorkspaceId);
  };

  async function setSkillInstanceEnabled(target: SkillMutationTarget, enabled: boolean): Promise<SkillSaveResult> {
    const name = target.name.trim();
    const path = skillEntryFilePathForMutationPath(target.path);
    if (!name || !path) {
      const message = translate("skills.failed_load_skill");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const vesloClient = options.vesloServerClient();
    if (
      options.vesloServerStatus() !== "connected" ||
      !vesloClient ||
      typeof vesloClient.setSkillEnabledState !== "function"
    ) {
      return managedSkillMutationUnavailable(translate("skills.recoverable_remove_server_required"));
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      await vesloClient.setSkillEnabledState({
        enabled,
        target: {
          name,
          scope: target.scope,
          path,
          ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
          ...(target.registry ? { registry: target.registry } : {}),
        },
      });
      options.markReloadRequired?.("skills", { type: "skill", name, action: "updated" });
      await refreshSkills({ force: true });
      await refreshSkillInventory({ force: true });
      const message = __vesloIndirectT("ui.indirect.saved_1caget", __vesloIndirectLocale());
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

  const syncMaterializationAfterManagedSkillMutation = async (target: ManagedSkillMutationTarget) => {
    const client = managedSkillMaterializationClient();
    if (!client) return;

    const scope = target.restoreTarget?.scope ?? target.scope;
    const workspaceId =
      target.restoreTarget?.workspaceId?.trim() ||
      target.workspaceId?.trim() ||
      (scope === "workspace"
        ? options.vesloServerWorkspaceId()?.trim() || options.activeWorkspaceId().trim()
        : "");
    const syncOptions = resolveDenRegistryContext();

    if (
      (scope === "user-global" || (scope === "organization" && !workspaceId)) &&
      typeof client.syncGlobalSkillMaterialization === "function"
    ) {
      await client.syncGlobalSkillMaterialization(syncOptions);
    }

    if (
      workspaceId &&
      (scope === "workspace" || scope === "organization") &&
      typeof client.syncWorkspaceSkillMaterialization === "function"
    ) {
      await client.syncWorkspaceSkillMaterialization(workspaceId, syncOptions);
    }
  };

  const refreshAfterManagedSkillMutation = async (
    target: ManagedSkillMutationTarget,
    action: NonNullable<ReloadTrigger["action"]>,
  ) => {
    if (managedSkillTargetAffectsActiveRuntime(target)) {
      options.markReloadRequired?.("skills", { type: "skill", name: target.name.trim(), action });
    }
    await syncMaterializationAfterManagedSkillMutation(target);
    await refreshHubSkills({ force: true });
    await refreshSkillInventory({ force: true });
  };

  const refreshAfterLocalRecoverableSkillMutation = async (
    target: ManagedSkillMutationTarget,
    action: NonNullable<ReloadTrigger["action"]>,
  ) => {
    if (managedSkillTargetAffectsActiveRuntime(target)) {
      options.markReloadRequired?.("skills", { type: "skill", name: target.name.trim(), action });
    }
    await refreshSkills({ force: true });
    await refreshSkillInventory({ force: true });
  };

  async function removeWorkspaceFilesystemSkillInstance(target: SkillMutationTarget): Promise<SkillSaveResult> {
    const name = target.name.trim();
    const path = target.path.trim();
    if (!name || !path) {
      return managedSkillMutationUnavailable(translate("skills.failed_load_skill"));
    }
    if (target.scope !== "workspace") {
      return managedSkillMutationUnavailable(translate("skills.uninstall_scope_ambiguous"));
    }
    if (isManagedSkillMutationPath(path)) {
      return managedSkillMutationUnavailable(translate("skills.registry_action_pending"));
    }

    const vesloClient = registryMutationClient("deleteSkill");
    const workspaceId =
      target.workspaceId?.trim() ||
      options.vesloServerWorkspaceId()?.trim() ||
      options.activeWorkspaceId().trim();
    if (!vesloClient || !workspaceId) {
      return managedSkillMutationUnavailable(translate("skills.recoverable_remove_server_required"));
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      await vesloClient.deleteSkill(workspaceId, name, { path: skillEntryFilePathForMutationPath(path) });
      const message = translate("skills.uninstalled");
      setSkillsStatus(message);
      await refreshAfterLocalRecoverableSkillMutation({ ...target, name, path, workspaceId }, "removed");
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

  async function removeUserGlobalFilesystemSkillInstance(target: ManagedSkillMutationTarget): Promise<SkillSaveResult> {
    const name = target.name.trim();
    const path = target.path.trim();
    const entryFilePath = skillEntryFilePathForMutationPath(path);
    if (!name || !entryFilePath) return managedSkillMutationUnavailable(translate("skills.failed_load_skill"));

    const vesloClient = registryMutationClient("deleteGlobalSkill");
    if (!vesloClient) {
      return managedSkillMutationUnavailable(translate("skills.user_global_recoverable_remove_unavailable"));
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      await vesloClient.deleteGlobalSkill(name, { path: entryFilePath, reason: "user-requested" });
      const message = translate("skills.uninstalled");
      setSkillsStatus(message);
      await refreshAfterLocalRecoverableSkillMutation({ ...target, name, path: entryFilePath }, "removed");
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

  async function removeSkillInstance(target: ManagedSkillMutationTarget): Promise<SkillSaveResult> {
    const name = target.name.trim();
    if (!name) return managedSkillMutationUnavailable(translate("skills.failed_load_skill"));

    const registry = target.registry;
    if (registry?.removalPolicy === "locked") {
      return managedSkillMutationUnavailable(translate("skills.managed_remove_locked"));
    }

    const installationId = registry?.installationId?.trim() ?? "";
    const policyId = registry?.policyId?.trim() ?? "";

    if (installationId) {
      const missingContext = requireDenRegistryContext();
      if (missingContext) return missingContext;

      const vesloClient = registryMutationClient("deleteRegistrySkillInstallation");
      if (!vesloClient) {
        return managedSkillMutationUnavailable(translate("skills.managed_remove_server_required"));
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await vesloClient.deleteRegistrySkillInstallation(installationId, resolveDenRegistryContext());
        const message = translate("skills.uninstalled");
        setSkillsStatus(message);
        await refreshAfterManagedSkillMutation(target, "removed");
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

    if (policyId) {
      const missingContext = requireDenRegistryContext();
      if (missingContext) return missingContext;

      const vesloClient = registryMutationClient("updateRegistrySkillRolloutPolicy");
      if (!vesloClient) {
        return managedSkillMutationUnavailable(translate("skills.managed_rollout_server_required"));
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await vesloClient.updateRegistrySkillRolloutPolicy(policyId, {
          enabled: false,
          ...resolveDenRegistryContext(),
        });
        const message = translate("skills.uninstalled");
        setSkillsStatus(message);
        await refreshAfterManagedSkillMutation(target, "removed");
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

    if (isManagedSkillMutationPath(target.path)) {
      return managedSkillMutationUnavailable(translate("skills.registry_action_pending"));
    }

    if (target.scope === "workspace") {
      return removeWorkspaceFilesystemSkillInstance(target);
    }

    if (target.scope === "user-global") {
      return removeUserGlobalFilesystemSkillInstance(target);
    }

    return managedSkillMutationUnavailable(translate("skills.remove_location_unavailable"));
  }

  async function batchRemoveSkillInstances(targets: ManagedSkillMutationTarget[]): Promise<SkillSaveResult> {
    const validTargets = targets.map((target) => ({
      ...target,
      name: target.name.trim(),
      path: skillEntryFilePathForMutationPath(target.path),
      workspaceId: target.workspaceId?.trim() || undefined,
      registry: target.registry
        ? {
            ...target.registry,
            installationId: target.registry.installationId?.trim(),
            policyId: target.registry.policyId?.trim(),
          }
        : undefined,
    }));
    if (validTargets.length === 0 || validTargets.some((target) => !target.name)) {
      return managedSkillMutationUnavailable(translate("skills.remove_location_unavailable"));
    }
    if (validTargets.some((target) => target.registry?.removalPolicy === "locked")) {
      return managedSkillMutationUnavailable(translate("skills.managed_remove_locked"));
    }

    const vesloClient = registryMutationClient("batchRemoveSkills");
    if (!vesloClient) {
      return managedSkillMutationUnavailable(translate("skills.recoverable_remove_server_required"));
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const response = await vesloClient.batchRemoveSkills({
        ...resolveDenRegistryContext(),
        items: validTargets.map((target, index) => {
          const installationId = target.registry?.installationId?.trim() ?? "";
          const policyId = target.registry?.policyId?.trim() ?? "";
          return {
            id: `${target.scope}:${target.workspaceId ?? ""}:${target.name}:${target.path || index}`,
            name: target.name,
            scope: target.scope,
            ...(target.path ? { path: target.path } : {}),
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
            reason: "user-requested",
            ...(installationId || policyId
              ? {
                  registry: {
                    ...(installationId ? { installationId } : {}),
                    ...(policyId ? { policyId } : {}),
                  },
                }
              : {}),
          };
        }),
      }) as VesloSkillBatchRemoveResponse;
      const baseMessage = response.ok
        ? translate("skills.bulk_removed")
        : translate("skills.bulk_remove_partial");
      const firstFailure = response.results.find((result) => !result.ok);
      const message = !response.ok && firstFailure && "message" in firstFailure
        ? `${baseMessage} ${firstFailure.message}`
        : baseMessage;
      setSkillsStatus(message);
      if (!response.ok) options.setError(addOpencodeCacheHint(message));
      const succeededRemovalIds = new Set(
        response.results
          .filter((result) => result.ok)
          .map((result) => result.id?.trim())
          .filter((id): id is string => Boolean(id)),
      );
      for (const [index, target] of validTargets.entries()) {
        const targetId = `${target.scope}:${target.workspaceId ?? ""}:${target.name}:${target.path || index}`;
        if (!succeededRemovalIds.has(targetId)) continue;
        if (managedSkillTargetAffectsActiveRuntime(target)) {
          options.markReloadRequired?.("skills", { type: "skill", name: target.name, action: "removed" });
        }
        await syncMaterializationAfterManagedSkillMutation(target);
      }
      await refreshHubSkills({ force: true });
      await refreshSkills({ force: true });
      await refreshSkillInventory({ force: true });
      return { ok: response.ok, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      const hintedMessage = addOpencodeCacheHint(message);
      options.setError(hintedMessage);
      return { ok: false, message: hintedMessage };
    } finally {
      options.setBusy(false);
    }
  }

  async function restoreSkillInstance(target: ManagedSkillMutationTarget): Promise<SkillSaveResult> {
    const name = target.name.trim();
    if (!name) return managedSkillMutationUnavailable(translate("skills.failed_load_skill"));

    const registry = target.registry;
    if (registry?.removalPolicy === "locked") {
      return managedSkillMutationUnavailable(translate("skills.managed_restore_locked"));
    }

    const installationId = registry?.installationId?.trim() ?? "";
    const policyId = registry?.policyId?.trim() ?? "";
    const removalId = target.restoreTarget?.removalId?.trim() ?? "";

    if (removalId) {
      const vesloClient = registryMutationClient("restoreSkillRemoval");
      if (!vesloClient) {
        return managedSkillMutationUnavailable(translate("skills.restore_location_unavailable"));
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await vesloClient.restoreSkillRemoval(removalId);
        const message = translate("skills.restored");
        setSkillsStatus(message);
        await refreshAfterLocalRecoverableSkillMutation(target, "added");
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

    if (installationId) {
      const missingContext = requireDenRegistryContext();
      if (missingContext) return missingContext;

      const vesloClient = registryMutationClient("restoreRegistrySkillInstallation");
      if (!vesloClient) {
        return managedSkillMutationUnavailable(translate("skills.managed_restore_server_required"));
      }

      const denContext = resolveDenRegistryContext();
      const registryMetadata = registry ?? {};
      const restoreScope = target.restoreTarget?.scope ?? target.scope;
      const restoreWorkspaceId = target.restoreTarget?.workspaceId?.trim() || target.workspaceId?.trim() || undefined;
      const restoreOrgId =
        target.restoreTarget?.orgId?.trim() || (restoreScope === "organization" ? denContext.denOrgId : undefined);
      const restoreOwnerUserId =
        restoreScope === "user-global" || registryMetadata.source === "personal" ? denContext.denUserId : undefined;
      const versionId = registryMetadata.versionId?.trim() || undefined;

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await vesloClient.restoreRegistrySkillInstallation(installationId, {
          ...denContext,
          ...(restoreOrgId ? { orgId: restoreOrgId } : {}),
          ...(restoreOwnerUserId ? { ownerUserId: restoreOwnerUserId } : {}),
          ...(restoreWorkspaceId ? { workspaceId: restoreWorkspaceId } : {}),
          ...(versionId ? { versionId } : {}),
        });
        const message = translate("skills.restored");
        setSkillsStatus(message);
        await refreshAfterManagedSkillMutation(target, "added");
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

    if (policyId) {
      const missingContext = requireDenRegistryContext();
      if (missingContext) return missingContext;

      const vesloClient = registryMutationClient("updateRegistrySkillRolloutPolicy");
      if (!vesloClient) {
        return managedSkillMutationUnavailable(translate("skills.managed_rollout_server_required"));
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await vesloClient.updateRegistrySkillRolloutPolicy(policyId, {
          enabled: true,
          ...resolveDenRegistryContext(),
        });
        const message = translate("skills.restored");
        setSkillsStatus(message);
        await refreshAfterManagedSkillMutation(target, "added");
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

    return managedSkillMutationUnavailable(translate("skills.restore_location_unavailable"));
  }

  async function deleteSkillInstance(target: SkillMutationTarget): Promise<void> {
    await removeSkillInstance(target);
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
        const message = __vesloIndirectT("ui.indirect.saved_1caget", __vesloIndirectLocale());
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
      const message = __vesloIndirectT("ui.indirect.veslo_server_unavailable_connect_to_edit_skill_f47jbk", __vesloIndirectLocale());
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = __vesloIndirectT("ui.indirect.local_workers_are_required_to_edit_skills_uvlvll", __vesloIndirectLocale());
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
        const successMessage = result.stdout || __vesloIndirectT("ui.indirect.saved_1caget", __vesloIndirectLocale());
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
    setSkillInstanceEnabled,
    deleteSkillInstance,
    removeSkillInstance,
    batchRemoveSkillInstances,
    restoreSkillInstance,
    copySkillInstanceToGlobal,
    copySkillInstanceToWorkspace,
    installHubMcp,
    abortRefreshes,
  };
}
