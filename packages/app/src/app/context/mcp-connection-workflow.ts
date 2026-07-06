import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client";
import { parse } from "jsonc-parser";

import type { McpDirectoryInfo } from "../constants";
import type { DenAuthState } from "../lib/den-auth";
import type { createClient as createOpencodeClient, unwrap as unwrapOpencodeResult } from "../lib/opencode";
import type { McpServersRefreshOptions } from "../lib/mcp-server-refresh";
import {
  createMcpRuntimeStatusRefresher,
  mcpRuntimeTokenRefreshCandidates,
} from "../lib/mcp-runtime-status-refresh";
import type { ExecResult, OpencodeConfigFile } from "../lib/tauri";
import type { VesloServerCapabilities, VesloServerClient } from "../lib/veslo-server";
import type { Client, HubMcpCard, McpServerEntry, McpStatusMap } from "../types";

type WorkspaceType = "local" | "remote" | string;

type VesloServerAuthState = {
  token?: string | null;
};

type McpInstallResult = {
  ok: boolean;
  message: string;
  entry?: HubMcpCard | null;
};

type McpConnectionFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

export type McpConnectionWorkflowDeps = {
  workspaceType: () => WorkspaceType;
  workspaceProjectDir: () => string;
  setWorkspaceProjectDir: (projectDir: string) => void;
  isTauriRuntime: () => boolean;
  routedClient: () => Client | null | undefined;
  createClient: typeof createOpencodeClient;
  setClient: (client: Client) => void;
  vesloServerStatus: () => string;
  vesloServerClient: () => VesloServerClient | null | undefined;
  vesloServerWorkspaceId: () => string | null | undefined;
  setVesloServerWorkspaceId: (workspaceId: string | null) => void;
  vesloCapabilities: () => VesloServerCapabilities | null | undefined;
  vesloServerBaseUrl: () => string;
  vesloServerAuth: () => VesloServerAuthState;
  activeWorkspaceId: () => string;
  activeRuntimeActivityId: () => string | null | undefined;
  activeWorkspaceRuntimeReady: () => boolean;
  mcpServers: () => McpServerEntry[];
  selectedMcp: () => string | null | undefined;
  setSelectedMcp: (name: string | null) => void;
  setMcpStatus: (status: string | null) => void;
  setMcpConnectingName: (name: string | null) => void;
  setMcpStatuses: (statuses: McpStatusMap) => void;
  setMcpAuthEntry: (entry: McpDirectoryInfo | null) => void;
  setMcpAuthNeedsReload: (needsReload: boolean) => void;
  setMcpAuthModalOpen: (open: boolean) => void;
  setNotionStatus: (status: "disconnected" | "connecting" | "connected" | "error") => void;
  setNotionStatusDetail: (detail: string | null) => void;
  setNotionError: (error: string | null) => void;
  notionBusy: () => boolean;
  setNotionBusy: (busy: boolean) => void;
  setNotionSkillInstalled: (installed: boolean) => void;
  setTryNotionPromptVisible: (visible: boolean) => void;
  localizedMcpQuickConnect: () => McpDirectoryInfo[];
  hubMcpCards: () => HubMcpCard[];
  refreshMcpServers: (options?: McpServersRefreshOptions) => Promise<void>;
  installHubMcp: (name: string) => Promise<McpInstallResult>;
  readOpencodeConfig: (scope: "project" | "global", projectDir: string) => Promise<OpencodeConfigFile>;
  writeOpencodeConfig: (scope: "project" | "global", projectDir: string, content: string) => Promise<ExecResult>;
  removeMcpFromConfig: (projectDir: string, name: string) => Promise<void>;
  canRemoveMcpFromProjectConfig: (entry: McpServerEntry | undefined) => boolean;
  quickConnectEntryKey: (entry: Pick<McpDirectoryInfo, "id" | "name">) => string;
  validateMcpServerName: (name: string) => string;
  readDenAuth: () => DenAuthState | null;
  fetch: (input: string, init?: RequestInit) => Promise<McpConnectionFetchResponse>;
  openDesktopAuthUrl: (url: string) => Promise<void>;
  unwrap: typeof unwrapOpencodeResult;
  currentLocale: () => string;
  translate: (key: string, locale: string) => string;
  normalizeDirectoryQueryPath: (directory: string) => string;
  recordPerfLog: (
    enabled: boolean,
    scope: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  finishPerf: (
    enabled: boolean,
    scope: string,
    event: string,
    startedAt: number,
    payload?: Record<string, unknown>,
  ) => void;
  developerMode: () => boolean;
  perfNow: () => number;
  safeStringify: (value: unknown) => string;
};

export type McpConnectionWorkflow = ReturnType<typeof createMcpConnectionWorkflow>;

const messageFromUnknownError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function createMcpConnectionWorkflow(deps: McpConnectionWorkflowDeps) {
  const tr = (key: string) => deps.translate(key, deps.currentLocale());

  const resolveWritableVesloMcpContext = async () => {
    const vesloClient = deps.vesloServerClient();
    let vesloWorkspaceId = deps.vesloServerWorkspaceId();
    const vesloCapabilities = deps.vesloCapabilities();
    if (!vesloWorkspaceId && vesloClient && deps.vesloServerStatus() === "connected") {
      try {
        const response = await vesloClient.listWorkspaces();
        const match = response.items?.[0];
        if (match?.id) {
          vesloWorkspaceId = match.id;
          deps.setVesloServerWorkspaceId(match.id);
        }
      } catch {
        // ignore
      }
    }
    const canUseVesloServer = Boolean(
      deps.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.write,
    );

    return {
      canUseVesloServer,
      vesloClient,
      vesloWorkspaceId,
    };
  };

  async function connectNotion() {
    if (deps.workspaceType() !== "local") {
      deps.setNotionError("Notion connections are only available for local workspaces.");
      return;
    }

    const projectDir = deps.workspaceProjectDir().trim();
    if (!projectDir) {
      deps.setNotionError("Pick a workspace folder first.");
      return;
    }

    const vesloClient = deps.vesloServerClient();
    const vesloWorkspaceId = deps.vesloServerWorkspaceId();
    const vesloCapabilities = deps.vesloCapabilities();
    const canUseVesloServer =
      deps.vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.write;

    if (!canUseVesloServer && !deps.isTauriRuntime()) {
      deps.setNotionError("Notion connections require the desktop app.");
      return;
    }

    if (deps.notionBusy()) return;

    deps.setNotionBusy(true);
    deps.setNotionError(null);
    deps.setNotionStatus("connecting");
    deps.setNotionStatusDetail(tr("mcp.connecting"));
    deps.setNotionSkillInstalled(false);

    try {
      if (canUseVesloServer) {
        await vesloClient.mcp.add(vesloWorkspaceId, {
          name: "notion",
          config: {
            type: "remote",
            url: "https://mcp.notion.com/mcp",
            enabled: true,
          },
        });
      } else {
        const config = await deps.readOpencodeConfig("project", projectDir);
        const raw = config.content ?? "";
        const nextConfig = raw.trim()
          ? (parse(raw) as Record<string, unknown>)
          : { $schema: "https://opencode.ai/config.json" };

        const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp
          ? { ...(nextConfig.mcp as Record<string, unknown>) }
          : {};
        mcp.notion = {
          type: "remote",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
        };

        nextConfig.mcp = mcp;
        const formatted = JSON.stringify(nextConfig, null, 2);

        const result = await deps.writeOpencodeConfig("project", projectDir, `${formatted}\n`);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
      }

      await deps.refreshMcpServers({ mode: "explicit", reason: "notion-connect" });
      deps.setNotionStatusDetail(tr("mcp.connecting"));
      try {
        window.localStorage.setItem("veslo.notionStatus", "connecting");
        window.localStorage.setItem("veslo.notionStatusDetail", tr("mcp.connecting"));
        window.localStorage.setItem("veslo.notionSkillInstalled", "0");
      } catch {
        // ignore
      }
    } catch (e) {
      deps.setNotionStatus("error");
      deps.setNotionError(messageFromUnknownError(e, "Failed to connect Notion."));
    } finally {
      deps.setNotionBusy(false);
    }
  }

  const mcpRuntimeStatusRefresher = createMcpRuntimeStatusRefresher<Client>({
    activeWorkspaceId: () => deps.activeWorkspaceId(),
    activeRuntimeActivityId: deps.activeRuntimeActivityId,
    activeWorkspaceRuntimeReady: deps.activeWorkspaceRuntimeReady,
    workspaceProjectDir: () => deps.workspaceProjectDir(),
    client: deps.routedClient,
    currentEntries: () => deps.mcpServers(),
    loadStatus: async (activeClient, directory) =>
      deps.unwrap(await activeClient.mcp.status({ directory })) as McpStatusMap,
    refreshRuntimeTokens: async ({ entries, status }) => {
      const candidates = mcpRuntimeTokenRefreshCandidates(status, entries);
      if (!candidates.length) return false;

      const vesloClient = deps.vesloServerClient();
      const vesloWorkspaceId = deps.vesloServerWorkspaceId();
      const denAuth = deps.readDenAuth();
      const denToken = denAuth?.token?.trim() ?? "";
      const denOrgId = denAuth?.orgId?.trim() ?? "";
      if (
        deps.vesloServerStatus() !== "connected" ||
        !vesloClient ||
        !vesloWorkspaceId ||
        !deps.vesloCapabilities()?.mcp?.write ||
        !denToken ||
        !denOrgId ||
        typeof vesloClient.mcp.refreshRuntimeToken !== "function"
      ) {
        return false;
      }

      let refreshed = false;
      for (const name of candidates) {
        try {
          await vesloClient.mcp.refreshRuntimeToken(vesloWorkspaceId, name, {
            denToken,
            denOrgId,
          });
          refreshed = true;
          deps.recordPerfLog(deps.developerMode(), "workspace.mcp", "runtime-token-refresh", { name });
        } catch (error) {
          deps.recordPerfLog(deps.developerMode(), "workspace.mcp", "runtime-token-refresh-failed", {
            name,
            error: error instanceof Error ? error.message : deps.safeStringify(error),
          });
        }
      }
      if (refreshed) {
        await deps.refreshMcpServers({ mode: "explicit", reason: "mcp-runtime-token-refresh" });
      }
      return refreshed;
    },
    setStatuses: deps.setMcpStatuses,
    recordEvent: (event, payload) =>
      deps.recordPerfLog(deps.developerMode(), "workspace.mcp", event, payload),
  });

  function scheduleMcpRuntimeStatusRefresh(projectDir: string, entries: McpServerEntry[]) {
    mcpRuntimeStatusRefresher.schedule(projectDir, entries);
  }

  async function ensureMcpRuntimeContext() {
    const projectDir = deps.workspaceProjectDir().trim();

    let activeClient = deps.routedClient();
    if (!activeClient) {
      const vesloBaseUrl = deps.vesloServerBaseUrl().trim();
      const auth = deps.vesloServerAuth();
      if (vesloBaseUrl && auth.token) {
        const opencodeUrl = `${vesloBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = deps.createClient(opencodeUrl, undefined, { token: auth.token, mode: "veslo" });
        deps.setClient(activeClient);
      }
    }
    if (!activeClient) {
      throw new Error(tr("mcp.connect_server_first"));
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = deps.unwrap(await activeClient.path.get());
        const discoveredRaw = deps.normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          deps.setWorkspaceProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      throw new Error(tr("mcp.pick_workspace_first"));
    }

    return { activeClient, resolvedProjectDir };
  }

  function buildMcpAddConfig(entry: McpDirectoryInfo): McpLocalConfig | McpRemoteConfig {
    const entryType = entry.type ?? "remote";
    if (entryType === "remote") {
      if (!entry.url) {
        throw new Error("Missing MCP URL.");
      }
      const oauth: McpRemoteConfig["oauth"] =
        entry.oauth === false ? false : typeof entry.oauth === "object" ? entry.oauth : {};
      return {
        type: "remote",
        url: entry.url,
        enabled: true,
        oauth,
        ...(entry.headers ? { headers: entry.headers } : {}),
      };
    }

    if (!entry.command?.length) {
      throw new Error("Missing MCP command.");
    }

    return {
      type: "local",
      command: entry.command,
      enabled: true,
    };
  }

  function directoryInfoFromHubMcpCard(entry: NonNullable<McpInstallResult["entry"]>): McpDirectoryInfo {
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description ?? "",
      type: entry.type,
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      oauth: entry.oauth,
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.authorization ? { authorization: entry.authorization } : {}),
      provider: entry.provider,
      source: entry.source,
    };
  }

  function findHubMcpForInstalledEntry(entry: McpServerEntry) {
    return deps.hubMcpCards().find((candidate) => {
      const candidateId = candidate.id?.trim() ?? "";
      const candidateName = candidate.name.trim();
      return (
        candidateId === entry.name ||
        candidateName === entry.name ||
        deps.quickConnectEntryKey({ id: candidate.id, name: candidate.name }) === entry.name
      );
    }) ?? null;
  }

  async function startServerManagedMcpOAuth(entry: McpDirectoryInfo): Promise<boolean> {
    if (entry.authorization?.type !== "veslo-server-oauth") {
      return false;
    }

    const denAuth = deps.readDenAuth();
    const denApiBase = denAuth?.denApiBase?.trim().replace(/\/+$/, "") ?? "";
    const denToken = denAuth?.token?.trim() ?? "";
    if (!denApiBase || !denToken) {
      throw new Error("Sign in to Veslo before connecting this provider.");
    }

    const startPath = entry.authorization.startPath.trim();
    if (!startPath.startsWith("/v1/")) {
      throw new Error("Invalid provider authorization path.");
    }

    const response = await deps.fetch(`${denApiBase}${startPath}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${denToken}`,
      },
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(details || `Provider authorization failed (${response.status})`);
    }

    const payload = await response.json().catch(() => null) as { authorizeUrl?: unknown } | null;
    if (!payload || typeof payload.authorizeUrl !== "string" || !payload.authorizeUrl.trim()) {
      throw new Error("Provider authorization did not return a browser URL.");
    }

    deps.setMcpStatus(tr("mcp.auth.follow_browser_steps"));
    try {
      await deps.openDesktopAuthUrl(payload.authorizeUrl);
    } catch (error) {
      deps.recordPerfLog(deps.developerMode(), "mcp.oauth", "browser-open-failed", {
        provider: entry.authorization.provider,
        connectorId: entry.authorization.connectorId,
        message: error instanceof Error ? error.message : deps.safeStringify(error),
      });
    }
    return true;
  }

  async function activateInstalledMcp(entry: McpDirectoryInfo, slug = deps.quickConnectEntryKey(entry)) {
    const { activeClient, resolvedProjectDir } = await ensureMcpRuntimeContext();
    const status = deps.unwrap(
      await activeClient.mcp.add({
        directory: resolvedProjectDir,
        name: slug,
        config: buildMcpAddConfig(entry),
      }),
    );

    deps.setMcpStatuses(status as McpStatusMap);
    await deps.refreshMcpServers({ mode: "explicit", reason: "mcp-activate-installed" });

    if (await startServerManagedMcpOAuth(entry)) {
      deps.setMcpAuthEntry(null);
      deps.setMcpAuthNeedsReload(true);
      deps.setMcpAuthModalOpen(false);
    } else if (entry.oauth) {
      deps.setMcpAuthEntry(entry);
      deps.setMcpAuthNeedsReload(true);
      deps.setMcpAuthModalOpen(true);
    } else {
      deps.setMcpStatus(tr("mcp.connected"));
    }

    await deps.refreshMcpServers({ mode: "explicit", reason: "mcp-activate-installed-complete" });
  }

  async function connectMcp(entry: McpDirectoryInfo) {
    const startedAt = deps.perfNow();
    const isRemoteWorkspace =
      deps.workspaceType() === "remote" ||
      (!deps.isTauriRuntime() && deps.vesloServerStatus() === "connected");
    const projectDir = deps.workspaceProjectDir().trim();
    const entryType = entry.type ?? "remote";

    deps.recordPerfLog(deps.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { canUseVesloServer, vesloClient, vesloWorkspaceId } = await resolveWritableVesloMcpContext();

    if (isRemoteWorkspace && !canUseVesloServer) {
      deps.setMcpStatus("Veslo server unavailable. MCP config is read-only.");
      deps.finishPerf(deps.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "veslo-server-unavailable",
      });
      return;
    }

    if (!canUseVesloServer && !deps.isTauriRuntime()) {
      deps.setMcpStatus(tr("mcp.desktop_required"));
      deps.finishPerf(deps.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      deps.setMcpStatus(tr("mcp.pick_workspace_first"));
      deps.finishPerf(deps.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const slug = deps.quickConnectEntryKey(entry);

    try {
      deps.setMcpStatus(null);
      deps.setMcpConnectingName(entry.name);
      const { resolvedProjectDir } = await ensureMcpRuntimeContext();

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!entry.url) {
          throw new Error("Missing MCP URL.");
        }
        mcpEntryConfig["url"] = entry.url;
        if (entry.oauth) {
          mcpEntryConfig["oauth"] = {};
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = entry.command;
      }

      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.mcp.add(vesloWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        const configFile = await deps.readOpencodeConfig("project", resolvedProjectDir);

        let existingConfig: Record<string, unknown> = {};
        if (configFile.exists && configFile.content?.trim()) {
          try {
            existingConfig = parse(configFile.content) ?? {};
          } catch (parseErr) {
            deps.recordPerfLog(deps.developerMode(), "mcp.connect", "config-parse-failed", {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            existingConfig = {};
          }
        }

        if (!existingConfig["$schema"]) {
          existingConfig["$schema"] = "https://opencode.ai/config.json";
        }

        const mcpSection = (existingConfig["mcp"] as Record<string, unknown>) ?? {};
        existingConfig["mcp"] = mcpSection;
        mcpSection[slug] = mcpEntryConfig;

        const writeResult = await deps.writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          `${JSON.stringify(existingConfig, null, 2)}\n`,
        );
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      await activateInstalledMcp(entry, slug);
      deps.finishPerf(deps.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (e) {
      deps.setMcpStatus(e instanceof Error ? e.message : tr("mcp.connect_failed"));
      deps.finishPerf(deps.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: e instanceof Error ? e.message : deps.safeStringify(e),
      });
    } finally {
      deps.setMcpConnectingName(null);
    }
  }

  async function authorizeMcp(entry: McpServerEntry) {
    const matchingHubMcp = findHubMcpForInstalledEntry(entry);
    if (matchingHubMcp?.authorization?.type === "veslo-server-oauth") {
      try {
        deps.setMcpStatus(null);
        deps.setMcpConnectingName(matchingHubMcp.name);
        await startServerManagedMcpOAuth(directoryInfoFromHubMcpCard(matchingHubMcp));
        deps.setMcpAuthEntry(null);
        deps.setMcpAuthNeedsReload(false);
        deps.setMcpAuthModalOpen(false);
      } catch (error) {
        deps.setMcpStatus(error instanceof Error ? error.message : deps.safeStringify(error));
      } finally {
        deps.setMcpConnectingName(null);
      }
      return;
    }

    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      deps.setMcpStatus(tr("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = deps.localizedMcpQuickConnect().find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    deps.setMcpAuthEntry(
      matchingQuickConnect ?? {
        name: entry.name,
        description: "",
        type: "remote",
        url: entry.config.url,
        oauth: true,
      },
    );
    deps.setMcpAuthNeedsReload(false);
    deps.setMcpAuthModalOpen(true);
  }

  async function installHubMcpAndActivate(name: string): Promise<McpInstallResult> {
    const result = await deps.installHubMcp(name);
    if (!result.ok) {
      return result;
    }

    const selectedEntry = result.entry ?? deps.hubMcpCards().find((entry) => entry.id === name || entry.name === name);
    if (!selectedEntry) {
      await deps.refreshMcpServers({ mode: "explicit", reason: "hub-mcp-selected-entry-missing" });
      return result;
    }

    const entry = directoryInfoFromHubMcpCard(selectedEntry);

    try {
      deps.setMcpStatus(null);
      deps.setMcpConnectingName(entry.name);
      if (entry.authorization?.type === "veslo-server-oauth") {
        await deps.refreshMcpServers({ mode: "explicit", reason: "hub-mcp-server-oauth-installed" });
        await startServerManagedMcpOAuth(entry);
        await deps.refreshMcpServers({ mode: "explicit", reason: "hub-mcp-server-oauth-started" });
        return result;
      }

      await activateInstalledMcp(entry, entry.id || deps.quickConnectEntryKey(entry));
      return result;
    } catch (error) {
      await deps.refreshMcpServers({ mode: "explicit", reason: "hub-mcp-activate-error" });
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setMcpStatus(message);
      return { ok: false, message };
    } finally {
      deps.setMcpConnectingName(null);
    }
  }

  async function logoutMcpAuth(name: string) {
    const isRemoteWorkspace =
      deps.workspaceType() === "remote" ||
      (!deps.isTauriRuntime() && deps.vesloServerStatus() === "connected");
    const projectDir = deps.workspaceProjectDir().trim();

    const { canUseVesloServer, vesloClient, vesloWorkspaceId } = await resolveWritableVesloMcpContext();

    if (isRemoteWorkspace && !canUseVesloServer) {
      deps.setMcpStatus("Veslo server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseVesloServer && !deps.isTauriRuntime()) {
      deps.setMcpStatus(tr("mcp.desktop_required"));
      return;
    }

    let activeClient = deps.routedClient();
    if (!activeClient) {
      const vesloBaseUrl = deps.vesloServerBaseUrl().trim();
      const auth = deps.vesloServerAuth();
      if (vesloBaseUrl && auth.token) {
        const opencodeUrl = `${vesloBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = deps.createClient(opencodeUrl, undefined, { token: auth.token, mode: "veslo" });
        deps.setClient(activeClient);
      }
    }
    if (!activeClient) {
      deps.setMcpStatus(tr("mcp.connect_server_first"));
      return;
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = deps.unwrap(await activeClient.path.get());
        const discoveredRaw = deps.normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          deps.setWorkspaceProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      deps.setMcpStatus(tr("mcp.pick_workspace_first"));
      return;
    }

    const safeName = deps.validateMcpServerName(name);
    deps.setMcpStatus(null);

    try {
      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.mcp.logoutAuth(vesloWorkspaceId, safeName);
      } else {
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        const status = deps.unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
        deps.setMcpStatuses(status as McpStatusMap);
      } catch {
        // ignore
      }

      await deps.refreshMcpServers({ mode: "explicit", reason: "mcp-logout" });
      deps.setMcpStatus(tr("mcp.logout_success").replace("{server}", safeName));
    } catch (e) {
      deps.setMcpStatus(e instanceof Error ? e.message : tr("mcp.logout_failed"));
    }
  }

  async function removeMcp(name: string) {
    try {
      deps.setMcpStatus(null);

      const vesloClient = deps.vesloServerClient();
      const vesloWorkspaceId = deps.vesloServerWorkspaceId();
      const canUseVesloServer =
        deps.vesloServerStatus() === "connected" &&
        vesloClient &&
        vesloWorkspaceId &&
        deps.vesloCapabilities()?.mcp?.write;

      const entry = deps.mcpServers().find((server) => server.name === name);
      if (!entry) {
        deps.setMcpStatus("This MCP is no longer available. Refresh and try again.");
        return;
      }
      if (!deps.canRemoveMcpFromProjectConfig(entry)) {
        deps.setMcpStatus("This MCP comes from your global OpenCode config and cannot be removed from this workspace.");
        return;
      }

      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.mcp.remove(vesloWorkspaceId, name);
      } else {
        const projectDir = deps.workspaceProjectDir().trim();
        if (!projectDir) {
          deps.setMcpStatus(tr("mcp.pick_workspace_first"));
          return;
        }
        await deps.removeMcpFromConfig(projectDir, name);
      }

      await deps.refreshMcpServers({ mode: "explicit", reason: "mcp-remove" });
      if (deps.selectedMcp() === name) {
        deps.setSelectedMcp(null);
      }
      deps.setMcpStatus(null);
    } catch (e) {
      deps.setMcpStatus(e instanceof Error ? e.message : tr("mcp.remove_failed"));
    }
  }

  return {
    connectNotion,
    scheduleMcpRuntimeStatusRefresh,
    ensureMcpRuntimeContext,
    buildMcpAddConfig,
    startServerManagedMcpOAuth,
    activateInstalledMcp,
    connectMcp,
    authorizeMcp,
    installHubMcpAndActivate,
    logoutMcpAuth,
    removeMcp,
  };
}
