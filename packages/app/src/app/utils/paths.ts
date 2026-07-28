import type { WorkspaceInfo } from "../lib/tauri-types";
import { currentLocale, t } from "../../i18n";

const tr = (key: string) => t(key, currentLocale());

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  isTauri?: boolean;
};

type TauriGlobal = typeof globalThis & {
  isTauri?: boolean;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

type BrowserPlatformFlags = {
  isMac: boolean;
  isWindows: boolean;
};

let cachedPlatformFlags: BrowserPlatformFlags | null = null;

function browserPlatformFlags(): BrowserPlatformFlags | null {
  if (cachedPlatformFlags) return cachedPlatformFlags;
  if (typeof navigator === "undefined") return null;

  const candidateNavigator = navigator as NavigatorWithUserAgentData;
  const userAgentData = candidateNavigator.userAgentData;
  const userAgentDataPlatform = userAgentData?.platform;
  const platform =
    typeof userAgentDataPlatform === "string"
      ? userAgentDataPlatform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";
  const userAgent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const flags = {
    isWindows: /windows/i.test(platform) || /windows/i.test(userAgent),
    isMac: /mac/i.test(platform) || /macintosh/i.test(userAgent),
  };

  // Tauri exposes userAgentData, but its navigator bridge is expensive enough
  // to matter in path-heavy reactive work. Cache only that browser-native
  // capability; test/SSR fallbacks without it stay dynamic.
  if (userAgentData) cachedPlatformFlags = flags;
  return flags;
}

export function isTauriRuntime() {
  if (typeof window === "undefined") return false;

  const candidateWindow = window as TauriWindow;
  if (candidateWindow.__TAURI_INTERNALS__ != null) {
    return true;
  }
  if (candidateWindow.isTauri === true || (globalThis as TauriGlobal).isTauri === true) {
    return true;
  }

  const hostname =
    typeof candidateWindow.location?.hostname === "string"
      ? candidateWindow.location.hostname.trim().toLowerCase()
      : "";
  return hostname === "tauri.localhost";
}

export function isWindowsPlatform() {
  return browserPlatformFlags()?.isWindows ?? false;
}

export function isMacPlatform() {
  return browserPlatformFlags()?.isMac ?? false;
}

/**
 * Path normalization is pure, deterministic, and called from the sidebar's
 * per-row key and root helpers, so it runs once per row per render. A captured
 * profile attributed 3.8 s of main-thread time to this function and a further
 * 1.5 s to the platform lookup beneath it, which together dominated every other
 * cost in the trace and froze the UI.
 *
 * The distinct input set is small — workspace roots and session directories —
 * so memoizing collapses that to a single computation per path. The cache is
 * bounded and dropped wholesale rather than evicted per entry, because these
 * keys are stable for a session and the cheapest correct policy is to keep them
 * until the set grows unreasonable.
 */
const PATH_NORMALIZATION_CACHE_LIMIT = 4096;

function memoizedPathValue<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  if (cache.size >= PATH_NORMALIZATION_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

const directoryQueryPathCache = new Map<string, string>();

export function normalizeDirectoryQueryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  return memoizedPathValue(directoryQueryPathCache, trimmed, () =>
    normalizeDirectoryQueryPathUncached(trimmed),
  );
}

function normalizeDirectoryQueryPathUncached(trimmed: string) {
  const unified = trimmed
    .replace(/^\\\\\?\\UNC\\/i, "//")
    .replace(/^\\\\\?\\/i, "")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//i, "")
    .replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

function wslMountPathToWindowsDirectoryPath(input: string) {
  const normalized = normalizeDirectoryQueryPath(input);
  const match = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toUpperCase();
  if (!drive) return null;
  const rest = match[2]?.trim() ?? "";
  return rest ? `${drive}:/${rest}` : `${drive}:/`;
}

function windowsDirectoryPathToWslMountPath(input: string) {
  const normalized = normalizeDirectoryQueryPath(input);
  const match = normalized.match(/^([A-Za-z]):(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toLowerCase();
  if (!drive) return null;
  const rest = match[2]?.replace(/^\/+/, "").replace(/\/+$/, "") ?? "";
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

export function isWslMappableWindowsWorkspacePath(input: string | null | undefined) {
  const normalized = normalizeDirectoryQueryPath(input);
  return /^[A-Za-z]:(?:\/|$)/.test(normalized);
}

function isWorkspaceAliasPath(input: string) {
  const normalized = normalizeDirectoryQueryPath(input);
  return normalized === "/workspace" || normalized === "workspace";
}

function workspaceAliasToRootPath(input: string, root: string) {
  const normalized = normalizeDirectoryQueryPath(input);
  if (!root) return normalized;
  if (isWorkspaceAliasPath(normalized)) return root;
  if (normalized.startsWith("/workspace/")) return `${root}/${normalized.slice("/workspace/".length)}`;
  if (normalized.startsWith("workspace/")) return `${root}/${normalized.slice("workspace/".length)}`;
  return normalized;
}

const directoryPlatformPathCache = new Map<string, string>();

function normalizeDirectoryPathForPlatform(input: string | null | undefined, windows: boolean) {
  const normalized = normalizeDirectoryQueryPath(input);
  if (!normalized) return "";
  // The platform flag is stable for the page, but keep it in the key so a
  // cached value can never be served for the wrong platform.
  return memoizedPathValue(
    directoryPlatformPathCache,
    `${windows ? "w" : "p"}\u0000${normalized}`,
    () => {
      const comparable = windows
        ? wslMountPathToWindowsDirectoryPath(normalized) ?? normalized
        : normalized;
      return windows ? comparable.toLowerCase() : comparable;
    },
  );
}

const directoryPathCache = new Map<string, string>();

export function normalizeDirectoryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  // Cache on the raw input so the platform lookup and both normalization steps
  // are skipped entirely on a repeat. This is the entry point the sidebar calls
  // several times per row per render, and the platform flag cannot change
  // within a page, so it does not belong in the key here.
  return memoizedPathValue(directoryPathCache, trimmed, () =>
    normalizeDirectoryPathForPlatform(trimmed, isWindowsPlatform()),
  );
}

export type DirectoryQueryPathMode = "auto" | "sandbox" | "non-sandbox";

export function directoryQueryPathModeFromSandbox(
  sandbox?: { enabled?: boolean | null; backend?: string | null } | null,
): DirectoryQueryPathMode {
  if (sandbox?.enabled === true && sandbox.backend === "windows-wsl2") return "sandbox";
  if (sandbox?.enabled === false || sandbox?.backend === "none") return "non-sandbox";
  return "auto";
}

function normalizeSessionDirectoryForRoot(
  sessionDirectory: string | null | undefined,
  normalizedRoot: string,
) {
  const aliased = workspaceAliasToRootPath(sessionDirectory ?? "", normalizedRoot);
  return normalizeDirectoryPathForPlatform(aliased, isWindowsPlatform());
}

export function directoryQueryPathVariants(
  input?: string | null,
  options?: { mode?: DirectoryQueryPathMode },
) {
  const primary = normalizeDirectoryQueryPath(input);
  if (!primary) return [];

  if (isWindowsPlatform()) {
    const wslMount = windowsDirectoryPathToWslMountPath(primary);
    const windowsFromWsl = wslMountPathToWindowsDirectoryPath(primary);
    const hostPath = windowsFromWsl ?? primary;
    const mountPath = wslMount ?? (windowsFromWsl ? primary : null);
    const workspaceAlias = wslMount || windowsFromWsl || isWorkspaceAliasPath(primary) ? "/workspace" : null;
    const mode = options?.mode ?? "auto";
    const ordered = new Set<string>();
    const add = (value?: string | null) => {
      if (value) ordered.add(value);
    };

    if (mode === "sandbox") {
      add(workspaceAlias);
      add(mountPath);
      add(hostPath);
    } else if (mode === "non-sandbox") {
      add(hostPath);
      add(mountPath);
      add(workspaceAlias);
    } else {
      add(primary);
      if (wslMount) add(wslMount);
      if (windowsFromWsl) add(windowsFromWsl);
      add(workspaceAlias);
    }

    return [...ordered];
  }

  return [primary];
}

// Sessions created in private/scratch flows may come back without directory metadata.
// In that case, scope them to the currently active workspace root.
export function sessionDirectoryMatchesRoot(
  sessionDirectory: string | null | undefined,
  workspaceRoot: string | null | undefined,
) {
  const root = normalizeDirectoryPath(workspaceRoot ?? "");
  if (!root) return false;
  const sessionRoot = normalizeSessionDirectoryForRoot(sessionDirectory ?? "", root) || root;
  return sessionRoot === root;
}

export function preferredSessionWorkspaceRoot(
  sessionDirectory: string | null | undefined,
  activeWorkspaceRoot: string | null | undefined,
) {
  const root = normalizeDirectoryPath(activeWorkspaceRoot ?? "");
  const sessionRoot = normalizeSessionDirectoryForRoot(sessionDirectory ?? "", root);
  if (sessionRoot) return sessionRoot;
  return root;
}

export function isPrivateWorkspacePathForRoot(
  folder: string | null | undefined,
  privateWorkspaceRoot: string | null | undefined,
) {
  const root = normalizeDirectoryPath(privateWorkspaceRoot ?? "");
  const value = normalizeDirectoryPath(folder ?? "");
  if (!value) return false;
  if (root && (value === root || value.startsWith(`${root}/`))) {
    return true;
  }

  // Keep private-workspace UX stable even when the cached private root is
  // unavailable or differs across app identifiers (e.g. dev/release data dirs).
  return value.includes("/private-workspaces/");
}

export function commandPathFromWorkspaceRoot(workspaceRoot: string, commandName: string) {
  const root = workspaceRoot.trim().replace(/\/+$/, "");
  const name = commandName.trim().replace(/^\/+/, "");
  if (!root || !name) return null;
  return `${root}/.opencode/commands/${name}.md`;
}

export function getWorkspaceTaskLoadErrorDisplay(_workspace: WorkspaceInfo, error?: string | null) {
  const raw = error?.trim() ?? "";
  const fallbackTitle = raw || "Failed to load tasks";
  return {
    tone: "error" as const,
    label: "Error",
    message: "Failed to load tasks",
    title: fallbackTitle,
  };
}
