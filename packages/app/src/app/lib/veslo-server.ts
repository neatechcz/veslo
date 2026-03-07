import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";
import type { ScheduledJob } from "./tauri";
import { resolveVesloCloudEnvironment } from "./cloud-policy";

export type VesloServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "veslo" | "opencode" };
  hub?: {
    skills?: {
      read: boolean;
      install: boolean;
      repo?: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean; opencodeRouter: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type VesloServerStatus = "connected" | "disconnected" | "limited";

export type VesloServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId: string | null;
  workspace: VesloWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type VesloServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
};

export type VesloWorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  workspaceType: "local" | "remote";
  baseUrl?: string;
  directory?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
};

export type VesloWorkspaceList = {
  items: VesloWorkspaceInfo[];
  activeId?: string | null;
};

export type VesloPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type VesloSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
};

export type VesloSkillContent = {
  item: VesloSkillItem;
  content: string;
};

export type VesloHubSkillItem = {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type VesloWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type VesloWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type VesloFileSession = {
  id: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  canWrite: boolean;
};

export type VesloFileCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

export type VesloFileSessionEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "write" | "delete" | "rename" | "mkdir";
  path: string;
  toPath?: string;
  revision?: string;
  timestamp: number;
};

export type VesloFileReadBatchResult = {
  items: Array<
    | {
        ok: true;
        path: string;
        kind: "file";
        bytes: number;
        updatedAt: number;
        revision: string;
        contentBase64: string;
      }
    | {
        ok: false;
        path: string;
        code: string;
        message: string;
        maxBytes?: number;
        size?: number;
      }
  >;
};

export type VesloFileWriteBatchResult = {
  items: Array<
    | {
        ok: true;
        path: string;
        bytes: number;
        updatedAt: number;
        revision: string;
        previousRevision?: string | null;
      }
    | {
        ok: false;
        path: string;
        code: string;
        message: string;
        expectedRevision?: string;
        currentRevision?: string | null;
        maxBytes?: number;
        size?: number;
      }
  >;
  cursor: number;
};

export type VesloFileOpsBatchResult = {
  items: Array<Record<string, unknown>>;
  cursor: number;
};

export type VesloCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type VesloMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};

export type VesloOpenCodeRouterTelegramResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterSlackResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterTelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

export type VesloOpenCodeRouterTelegramInfo = {
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  bot: VesloOpenCodeRouterTelegramBotInfo | null;
};

export type VesloOpenCodeRouterTelegramEnabledResult = {
  ok: boolean;
  persisted?: boolean;
  enabled: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
};

export type VesloOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
  activity?: {
    dayStart: number;
    inboundToday: number;
    outboundToday: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastMessageAt?: number;
  };
  agent?: {
    scope: "workspace";
    path: string;
    loaded: boolean;
    selected?: string;
  };
};

export type VesloOpenCodeRouterBindingItem = {
  channel: string;
  identityId: string;
  peerId: string;
  directory: string;
  updatedAt?: number;
};

export type VesloOpenCodeRouterBindingsResult = {
  ok: boolean;
  items: VesloOpenCodeRouterBindingItem[];
};

export type VesloOpenCodeRouterBindingUpdateResult = {
  ok: boolean;
};

export type VesloOpenCodeRouterSendResult = {
  ok: boolean;
  channel: string;
  identityId?: string;
  directory: string;
  peerId?: string;
  attempted: number;
  sent: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
};

export type VesloOpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
};

export type VesloOpenCodeRouterTelegramIdentitiesResult = {
  ok: boolean;
  items: VesloOpenCodeRouterIdentityItem[];
};

export type VesloOpenCodeRouterSlackIdentitiesResult = {
  ok: boolean;
  items: VesloOpenCodeRouterIdentityItem[];
};

export type VesloOpenCodeRouterTelegramIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    enabled: boolean;
    access?: "public" | "private";
    pairingRequired?: boolean;
    pairingCode?: string;
    applied?: boolean;
    starting?: boolean;
    error?: string;
    bot?: VesloOpenCodeRouterTelegramBotInfo | null;
  };
};

export type VesloOpenCodeRouterSlackIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type VesloOpenCodeRouterTelegramIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    deleted: boolean;
  };
};

export type VesloOpenCodeRouterSlackIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    deleted: boolean;
  };
};

export type VesloWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  veslo?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
};

export type VesloArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type VesloArtifactList = {
  items: VesloArtifactItem[];
};

export type VesloInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type VesloInboxList = {
  items: VesloInboxItem[];
};

export type VesloInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type VesloSoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

export type VesloSoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: string;
  heartbeatPath: string;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export type VesloActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type VesloAuditEntry = {
  id: string;
  workspaceId: string;
  actor: VesloActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type VesloReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type VesloReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: VesloReloadTrigger;
  timestamp: number;
};

export const DEFAULT_VESLO_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "veslo.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "veslo.server.port";
const STORAGE_TOKEN = "veslo.server.token";

export function normalizeVesloServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function parseVesloWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeVesloServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) return null;
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildVesloWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeVesloServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    const alreadyMounted = prev === "w" && Boolean(last);
    if (alreadyMounted) {
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/w/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/w/${encodeURIComponent(id)}`;
  }
}

export const DEFAULT_VESLO_CONNECT_APP_URL = "https://app.veslo.neatech.com";

const VESLO_INVITE_PARAM_URL = "ow_url";
const VESLO_INVITE_PARAM_TOKEN = "ow_token";
const VESLO_INVITE_PARAM_STARTUP = "ow_startup";
const VESLO_INVITE_PARAM_BUNDLE = "ow_bundle";
const VESLO_INVITE_PARAM_BUNDLE_INTENT = "ow_intent";
const VESLO_INVITE_PARAM_BUNDLE_SOURCE = "ow_source";
const VESLO_INVITE_PARAM_BUNDLE_ORG = "ow_org";
const VESLO_INVITE_PARAM_BUNDLE_LABEL = "ow_label";

export type VesloConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
};

export type VesloBundleInviteIntent = "new_worker" | "import_current";

export type VesloBundleInvite = {
  bundleUrl: string;
  intent: VesloBundleInviteIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

function normalizeVesloBundleInviteIntent(value: string | null | undefined): VesloBundleInviteIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

export function buildVesloConnectInviteUrl(input: {
  workspaceUrl: string;
  token?: string | null;
  appUrl?: string | null;
  startup?: "server";
}) {
  const workspaceUrl = normalizeVesloServerUrl(input.workspaceUrl ?? "") ?? "";
  if (!workspaceUrl) return "";

  const base = normalizeVesloServerUrl(input.appUrl ?? "") ?? DEFAULT_VESLO_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    search.set(VESLO_INVITE_PARAM_URL, workspaceUrl);

    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(VESLO_INVITE_PARAM_TOKEN, token);
    }

    const startup = input.startup ?? "server";
    search.set(VESLO_INVITE_PARAM_STARTUP, startup);

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    search.set(VESLO_INVITE_PARAM_URL, workspaceUrl);
    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(VESLO_INVITE_PARAM_TOKEN, token);
    }
    search.set(VESLO_INVITE_PARAM_STARTUP, input.startup ?? "server");
    return `${DEFAULT_VESLO_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readVesloConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(VESLO_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeVesloServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(VESLO_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(VESLO_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;

  return {
    url,
    token: token || undefined,
    startup,
  } satisfies VesloConnectInvite;
}

export function buildVesloBundleInviteUrl(input: {
  bundleUrl: string;
  appUrl?: string | null;
  intent?: VesloBundleInviteIntent;
  source?: string | null;
  orgId?: string | null;
  label?: string | null;
}) {
  const rawBundleUrl = input.bundleUrl?.trim() ?? "";
  if (!rawBundleUrl) return "";

  let bundleUrl: string;
  try {
    bundleUrl = new URL(rawBundleUrl).toString();
  } catch {
    return "";
  }

  const base = normalizeVesloServerUrl(input.appUrl ?? "") ?? DEFAULT_VESLO_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    const intent = normalizeVesloBundleInviteIntent(input.intent);
    search.set(VESLO_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(VESLO_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    const intent = normalizeVesloBundleInviteIntent(input.intent);
    search.set(VESLO_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(VESLO_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(VESLO_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    return `${DEFAULT_VESLO_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readVesloBundleInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawBundleUrl = search.get(VESLO_INVITE_PARAM_BUNDLE)?.trim() ?? "";
  if (!rawBundleUrl) return null;

  let bundleUrl: string;
  try {
    const parsed = new URL(rawBundleUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    bundleUrl = parsed.toString();
  } catch {
    return null;
  }

  const intent = normalizeVesloBundleInviteIntent(search.get(VESLO_INVITE_PARAM_BUNDLE_INTENT));
  const source = search.get(VESLO_INVITE_PARAM_BUNDLE_SOURCE)?.trim() ?? "";
  const orgId = search.get(VESLO_INVITE_PARAM_BUNDLE_ORG)?.trim() ?? "";
  const label = search.get(VESLO_INVITE_PARAM_BUNDLE_LABEL)?.trim() ?? "";

  return {
    bundleUrl,
    intent,
    source: source || undefined,
    orgId: orgId || undefined,
    label: label || undefined,
  } satisfies VesloBundleInvite;
}

export function stripVesloConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(VESLO_INVITE_PARAM_URL);
    url.searchParams.delete(VESLO_INVITE_PARAM_TOKEN);
    url.searchParams.delete(VESLO_INVITE_PARAM_STARTUP);
    return url.toString();
  } catch {
    return input;
  }
}

export function stripVesloBundleInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_INTENT);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_SOURCE);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_ORG);
    url.searchParams.delete(VESLO_INVITE_PARAM_BUNDLE_LABEL);
    return url.toString();
  } catch {
    return input;
  }
}

export function readVesloServerSettings(): VesloServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeVesloServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export function writeVesloServerSettings(next: VesloServerSettings): VesloServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeVesloServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    return readVesloServerSettings();
  } catch {
    return next;
  }
}

export function hydrateVesloServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  const envPort =
    typeof import.meta.env?.VITE_VESLO_PORT === "string"
      ? import.meta.env.VITE_VESLO_PORT.trim()
      : "";
  const resolvedEnv = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
  const envUrl = resolvedEnv.vesloUrl;
  const envToken = resolvedEnv.token ?? "";

  if (!envUrl && !envPort && !envToken) return;

  try {
    const current = readVesloServerSettings();
    const next: VesloServerSettings = { ...current };
    let changed = false;

    if (!current.urlOverride && envUrl) {
      next.urlOverride = normalizeVesloServerUrl(envUrl) ?? undefined;
      changed = true;
    }

    if (!current.portOverride && envPort) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (!current.token && envToken) {
      next.token = envToken;
      changed = true;
    }

    if (changed) {
      writeVesloServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearVesloServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
  } catch {
    // ignore
  }
}

export function deriveVesloServerUrl(
  opencodeBaseUrl: string,
  settings?: VesloServerSettings,
) {
  const override = settings?.urlOverride?.trim();
  if (override) {
    return normalizeVesloServerUrl(override);
  }

  const base = opencodeBaseUrl.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    const port = settings?.portOverride ?? DEFAULT_VESLO_SERVER_PORT;
    url.port = String(port);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

export class VesloServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues
const resolveFetch = () => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

const DEFAULT_VESLO_SERVER_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new VesloServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestJsonRaw<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return { ok: response.ok, status: response.status, json };
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new VesloServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}

export function createVesloServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    deleteWorkspace: 10_000,
    deleteSession: 12_000,
    status: 6_000,
    config: 10_000,
    opencodeRouter: 10_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    status: () => requestJson<VesloServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<VesloServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    opencodeRouterHealth: () =>
      requestJsonRaw<VesloOpenCodeRouterHealthSnapshot>(baseUrl, "/veslo-code-router/health", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterBindings: (filters?: { channel?: string; identityId?: string }) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      const suffix = search.toString();
      const path = suffix ? `/veslo-code-router/bindings?${suffix}` : "/veslo-code-router/bindings";
      return requestJsonRaw<VesloOpenCodeRouterBindingsResult>(baseUrl, path, { token, hostToken, timeoutMs: timeouts.opencodeRouter });
    },
    opencodeRouterTelegramIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterTelegramIdentitiesResult>(baseUrl, "/veslo-code-router/identities/telegram", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterSlackIdentities: () =>
      requestJsonRaw<VesloOpenCodeRouterSlackIdentitiesResult>(baseUrl, "/veslo-code-router/identities/slack", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    listWorkspaces: () => requestJson<VesloWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    activateWorkspace: (workspaceId: string) =>
      requestJson<{ activeId: string; workspace: VesloWorkspaceInfo }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      ),
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: VesloWorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    exportWorkspace: (workspaceId: string) =>
      requestJson<VesloWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      }),
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; veslo: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setOpenCodeRouterTelegramToken: (
      workspaceId: string,
      tokenValue: string,
      healthPort?: number | null,
    ) =>
      requestJson<VesloOpenCodeRouterTelegramResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram-token`,
        {
          token,
          hostToken,
          method: "POST",
          body: { token: tokenValue, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    setOpenCodeRouterSlackTokens: (
      workspaceId: string,
      botToken: string,
      appToken: string,
      healthPort?: number | null,
    ) =>
      requestJson<VesloOpenCodeRouterSlackResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/slack-tokens`,
        {
          token,
          hostToken,
          method: "POST",
          body: { botToken, appToken, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    getOpenCodeRouterTelegram: (workspaceId: string) =>
      requestJson<VesloOpenCodeRouterTelegramInfo>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      ),
    getOpenCodeRouterTelegramIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterTelegramIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram${query}`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      );
    },
    upsertOpenCodeRouterTelegramIdentity: (
      workspaceId: string,
      input: { id?: string; token: string; enabled?: boolean; access?: "public" | "private"; pairingCode?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            token: input.token,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.access ? { access: input.access } : {}),
            ...(input.pairingCode?.trim() ? { pairingCode: input.pairingCode.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterTelegramIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterTelegramIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/telegram/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterSlackIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterSlackIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack${query}`,
        { token, hostToken },
      );
    },
    upsertOpenCodeRouterSlackIdentity: (
      workspaceId: string,
      input: { id?: string; botToken: string; appToken: string; enabled?: boolean },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterSlackIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            botToken: input.botToken,
            appToken: input.appToken,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterSlackIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<VesloOpenCodeRouterSlackIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/identities/slack/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterBindings: (
      workspaceId: string,
      filters?: { channel?: string; identityId?: string; healthPort?: number | null },
    ) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      if (typeof filters?.healthPort === "number") search.set("healthPort", String(filters.healthPort));
      const suffix = search.toString();
      return requestJson<VesloOpenCodeRouterBindingsResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/bindings${suffix ? `?${suffix}` : ""}`,
        { token, hostToken },
      );
    },
    setOpenCodeRouterBinding: (
      workspaceId: string,
      input: { channel: string; identityId?: string; peerId: string; directory?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterBindingUpdateResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/bindings`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            channel: input.channel,
            ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
            peerId: input.peerId,
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    sendOpenCodeRouterMessage: (
      workspaceId: string,
      input: {
        channel: "telegram" | "slack";
        text: string;
        identityId?: string;
        directory?: string;
        peerId?: string;
        autoBind?: boolean;
      },
      options?: { healthPort?: number | null },
    ) => {
      const payload = {
        channel: input.channel,
        text: input.text,
        ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
        ...(input.peerId?.trim() ? { peerId: input.peerId.trim() } : {}),
        ...(input.autoBind === true ? { autoBind: true } : {}),
        healthPort: options?.healthPort ?? null,
      };

      const primaryPath = `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/send`;
      const mountedWorkspaceId = parseVesloWorkspaceIdFromUrl(baseUrl);
      const fallbackPath =
        mountedWorkspaceId && mountedWorkspaceId === workspaceId
          ? `/veslo-code-router/send`
          : `/w/${encodeURIComponent(workspaceId)}/veslo-code-router/send`;

      return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, primaryPath, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.opencodeRouter,
      }).catch(async (error) => {
        if (!(error instanceof VesloServerError) || error.status !== 404) {
          throw error;
        }
        return requestJson<VesloOpenCodeRouterSendResult>(baseUrl, fallbackPath, {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.opencodeRouter,
        });
      });
    },
    setOpenCodeRouterTelegramEnabled: (
      workspaceId: string,
      enabled: boolean,
      options?: { clearToken?: boolean; healthPort?: number | null },
    ) =>
      requestJson<VesloOpenCodeRouterTelegramEnabledResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/veslo-code-router/telegram-enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled, clearToken: options?.clearToken ?? false, healthPort: options?.healthPort ?? null },
        },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; veslo?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: VesloReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: VesloSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    listHubSkills: () =>
      requestJson<{ items: VesloHubSkillItem[] }>(baseUrl, `/hub/skills`, {
        token,
        hostToken,
      }),
    installHubSkill: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string } },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<VesloSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<VesloSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, { token, hostToken }),
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: VesloMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: VesloCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: VesloAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: VesloCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    listScheduledJobs: (workspaceId: string) =>
      requestJson<{ items: ScheduledJob[] }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs`, { token, hostToken }),
    deleteScheduledJob: (workspaceId: string, name: string) =>
      requestJson<{ job: ScheduledJob }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    getSoulStatus: (workspaceId: string) =>
      requestJson<VesloSoulStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul/status`, {
        token,
        hostToken,
      }),
    listSoulHeartbeats: (workspaceId: string, limit = 20) =>
      requestJson<{ items: VesloSoulHeartbeatEntry[]; total: number; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/heartbeats?limit=${encodeURIComponent(String(limit))}`,
        { token, hostToken },
      ),

    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new VesloServerError(result.status, "request_failed", message || "Inbox upload failed");
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<VesloInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies VesloInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies VesloInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<VesloInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    createFileSession: (workspaceId: string, options?: { ttlSeconds?: number; write?: boolean }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
          ...(typeof options?.write === "boolean" ? { write: options.write } : {}),
        },
      }),

    renewFileSession: (sessionId: string, options?: { ttlSeconds?: number }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
        },
      }),

    closeFileSession: (sessionId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    getFileCatalogSnapshot: (
      sessionId: string,
      options?: { prefix?: string; after?: string; includeDirs?: boolean; limit?: number },
    ) => {
      const params = new URLSearchParams();
      if (options?.prefix?.trim()) params.set("prefix", options.prefix.trim());
      if (options?.after?.trim()) params.set("after", options.after.trim());
      if (typeof options?.includeDirs === "boolean") params.set("includeDirs", options.includeDirs ? "true" : "false");
      if (typeof options?.limit === "number") params.set("limit", String(options.limit));
      const query = params.toString();
      return requestJson<{
        sessionId: string;
        workspaceId: string;
        generatedAt: number;
        cursor: number;
        total: number;
        truncated: boolean;
        nextAfter?: string;
        items: VesloFileCatalogEntry[];
      }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    listFileSessionEvents: (sessionId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${encodeURIComponent(String(options.since))}` : "";
      return requestJson<{ items: VesloFileSessionEvent[]; cursor: number }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`,
        { token, hostToken },
      );
    },

    readFileBatch: (sessionId: string, paths: string[]) =>
      requestJson<VesloFileReadBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { paths },
      }),

    writeFileBatch: (
      sessionId: string,
      writes: Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }>,
    ) =>
      requestJson<VesloFileWriteBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { writes },
      }),

    runFileBatchOps: (
      sessionId: string,
      operations: Array<
        | { type: "mkdir"; path: string }
        | { type: "delete"; path: string; recursive?: boolean }
        | { type: "rename"; from: string; to: string }
      >,
    ) =>
      requestJson<VesloFileOpsBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        token,
        hostToken,
        method: "POST",
        body: { operations },
      }),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<VesloWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<VesloWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<VesloArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
  };
}

export type VesloServerClient = ReturnType<typeof createVesloServerClient>;
