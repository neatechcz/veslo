import type { WorkspaceInfo } from "../lib/tauri";
import { currentLocale, t } from "../../i18n";

const tr = (key: string) => t(key, currentLocale());

export function isTauriRuntime() {
  if (typeof window === "undefined") return false;

  const candidateWindow = window as any;
  if (candidateWindow.__TAURI_INTERNALS__ != null) {
    return true;
  }

  const hostname =
    typeof candidateWindow.location?.hostname === "string"
      ? candidateWindow.location.hostname.trim().toLowerCase()
      : "";
  return hostname === "tauri.localhost";
}

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;

  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const platform =
    typeof (navigator as any).userAgentData?.platform === "string"
      ? (navigator as any).userAgentData.platform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";

  return /windows/i.test(platform) || /windows/i.test(ua);
}

export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;

  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const platform =
    typeof (navigator as any).userAgentData?.platform === "string"
      ? (navigator as any).userAgentData.platform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";

  return /mac/i.test(platform) || /macintosh/i.test(ua);
}

export function normalizeDirectoryQueryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const unified = trimmed
    .replace(/^\\\\\?\\UNC\\/i, "//")
    .replace(/^\\\\\?\\/i, "")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//i, "")
    .replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

export function normalizeDirectoryPath(input?: string | null) {
  const normalized = normalizeDirectoryQueryPath(input);
  if (!normalized) return "";
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized;
}

// Sessions created in private/scratch flows may come back without directory metadata.
// In that case, scope them to the currently active workspace root.
export function sessionDirectoryMatchesRoot(
  sessionDirectory: string | null | undefined,
  workspaceRoot: string | null | undefined,
) {
  const root = normalizeDirectoryPath(workspaceRoot ?? "");
  if (!root) return false;
  const sessionRoot = normalizeDirectoryPath(sessionDirectory ?? "") || root;
  return sessionRoot === root;
}

export function preferredSessionWorkspaceRoot(
  sessionDirectory: string | null | undefined,
  activeWorkspaceRoot: string | null | undefined,
) {
  const sessionRoot = normalizeDirectoryPath(sessionDirectory ?? "");
  if (sessionRoot) return sessionRoot;
  return normalizeDirectoryPath(activeWorkspaceRoot ?? "");
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
