import { mergeVesloServerSettingsWithEnv } from "../cloud-policy";
import type { VesloServerSettings } from "./types";

export const DEFAULT_VESLO_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "veslo.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "veslo.server.port";
const STORAGE_TOKEN = "veslo.server.token";
const LEGACY_STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";
const LEGACY_STORAGE_PORT_OVERRIDE = "openwork.server.port";
const LEGACY_STORAGE_TOKEN = "openwork.server.token";

export function normalizeVesloServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export const LOCAL_SESSION_ARCHIVE_OWNER_KEY = "local:desktop";

function isLoopbackVesloServerUrl(input: string) {
  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function resolveSessionArchiveClientOptions(options: {
  accountId?: string | null;
  activeBaseUrl?: string | null;
  activeToken?: string | null;
  settingsUrl?: string | null;
  settingsToken?: string | null;
  cloudUrl?: string | null;
  cloudToken?: string | null;
}) {
  const accountId = options.accountId?.trim() ?? "";

  const candidates = [
    {
      baseUrl: normalizeVesloServerUrl(options.activeBaseUrl ?? ""),
      token: options.activeToken?.trim() ?? "",
    },
    {
      baseUrl: normalizeVesloServerUrl(options.settingsUrl ?? ""),
      token: options.settingsToken?.trim() ?? "",
    },
    {
      baseUrl: normalizeVesloServerUrl(options.cloudUrl ?? ""),
      token: options.cloudToken?.trim() ?? "",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.baseUrl || !candidate.token) continue;
    const ownerKey = accountId || (isLoopbackVesloServerUrl(candidate.baseUrl) ? LOCAL_SESSION_ARCHIVE_OWNER_KEY : "");
    if (!ownerKey) return null;
    return {
      baseUrl: candidate.baseUrl,
      token: candidate.token,
      accountId: ownerKey,
    };
  }

  return null;
}

function isLikelyLocalHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const octets = normalized.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
      return false;
    }
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return normalized.endsWith(".local");
}

export function deriveLocalVesloServerUrlFromOpencodeBaseUrl(
  opencodeBaseUrl: string,
  port: number = DEFAULT_VESLO_SERVER_PORT,
) {
  const trimmed = opencodeBaseUrl.trim();
  if (!trimmed) return null;
  if (!Number.isFinite(port) || port <= 0) return null;

  try {
    const parsed = new URL(trimmed);
    if (!isLikelyLocalHostname(parsed.hostname)) {
      return null;
    }
    parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.origin;
  } catch {
    return null;
  }
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

export const DEFAULT_VESLO_CONNECT_APP_URL = "https://app.veslo.work";

const VESLO_INVITE_PARAM_URL = "veslo_url";
const VESLO_INVITE_PARAM_TOKEN = "veslo_token";
const VESLO_INVITE_PARAM_STARTUP = "veslo_startup";
const VESLO_INVITE_PARAM_BUNDLE = "veslo_bundle";
const VESLO_INVITE_PARAM_BUNDLE_INTENT = "veslo_intent";
const VESLO_INVITE_PARAM_BUNDLE_SOURCE = "veslo_source";
const VESLO_INVITE_PARAM_BUNDLE_ORG = "veslo_org";
const VESLO_INVITE_PARAM_BUNDLE_LABEL = "veslo_label";

const LEGACY_INVITE_PARAM_URL = "ow_url";
const LEGACY_INVITE_PARAM_TOKEN = "ow_token";
const LEGACY_INVITE_PARAM_STARTUP = "ow_startup";
const LEGACY_INVITE_PARAM_BUNDLE = "ow_bundle";
const LEGACY_INVITE_PARAM_BUNDLE_INTENT = "ow_intent";
const LEGACY_INVITE_PARAM_BUNDLE_SOURCE = "ow_source";
const LEGACY_INVITE_PARAM_BUNDLE_ORG = "ow_org";
const LEGACY_INVITE_PARAM_BUNDLE_LABEL = "ow_label";

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

  const rawUrl = (
    search.get(VESLO_INVITE_PARAM_URL) ??
    search.get(LEGACY_INVITE_PARAM_URL) ??
    ""
  ).trim();
  const url = normalizeVesloServerUrl(rawUrl);
  if (!url) return null;

  const token = (
    search.get(VESLO_INVITE_PARAM_TOKEN) ??
    search.get(LEGACY_INVITE_PARAM_TOKEN) ??
    ""
  ).trim();
  const startupRaw = (
    search.get(VESLO_INVITE_PARAM_STARTUP) ??
    search.get(LEGACY_INVITE_PARAM_STARTUP) ??
    ""
  ).trim();
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

  const rawBundleUrl = (
    search.get(VESLO_INVITE_PARAM_BUNDLE) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE) ??
    ""
  ).trim();
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

  const intent = normalizeVesloBundleInviteIntent(
    search.get(VESLO_INVITE_PARAM_BUNDLE_INTENT) ??
      search.get(LEGACY_INVITE_PARAM_BUNDLE_INTENT),
  );
  const source = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_SOURCE) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_SOURCE) ??
    ""
  ).trim();
  const orgId = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_ORG) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_ORG) ??
    ""
  ).trim();
  const label = (
    search.get(VESLO_INVITE_PARAM_BUNDLE_LABEL) ??
    search.get(LEGACY_INVITE_PARAM_BUNDLE_LABEL) ??
    ""
  ).trim();

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
    url.searchParams.delete(LEGACY_INVITE_PARAM_URL);
    url.searchParams.delete(LEGACY_INVITE_PARAM_TOKEN);
    url.searchParams.delete(LEGACY_INVITE_PARAM_STARTUP);
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
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_INTENT);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_SOURCE);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_ORG);
    url.searchParams.delete(LEGACY_INVITE_PARAM_BUNDLE_LABEL);
    return url.toString();
  } catch {
    return input;
  }
}

export function readVesloServerSettings(): VesloServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeVesloServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ??
      window.localStorage.getItem(LEGACY_STORAGE_URL_OVERRIDE) ??
      "",
    );
    const portRaw =
      window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ??
      window.localStorage.getItem(LEGACY_STORAGE_PORT_OVERRIDE) ??
      "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token =
      window.localStorage.getItem(STORAGE_TOKEN) ??
      window.localStorage.getItem(LEGACY_STORAGE_TOKEN) ??
      undefined;
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
    window.localStorage.removeItem(LEGACY_STORAGE_URL_OVERRIDE);

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_PORT_OVERRIDE);

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_TOKEN);

    return readVesloServerSettings();
  } catch {
    return next;
  }
}

export function hydrateVesloServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  try {
    const current = readVesloServerSettings();
    const { next, changed } = mergeVesloServerSettingsWithEnv(
      current,
      import.meta.env as Record<string, string | undefined>,
    );

    if (changed) {
      writeVesloServerSettings(next as VesloServerSettings);
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
    window.localStorage.removeItem(LEGACY_STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(LEGACY_STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(LEGACY_STORAGE_TOKEN);
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
