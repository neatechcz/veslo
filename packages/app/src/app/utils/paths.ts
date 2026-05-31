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
  const unified = trimmed.replace(/\\/g, "/");
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

const SANDBOX_DOCKER_OFFLINE_HINTS = [
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "docker daemon",
  "docker desktop",
  "docker engine",
  "error during connect",
  "docker.sock",
  "docker_socket",
  "open //./pipe/docker_engine",
];

const SANDBOX_NETWORK_HINTS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "request timed out",
  "timeout",
  "connection refused",
  "econnrefused",
  "connection reset",
  "socket hang up",
  "enotfound",
  "getaddrinfo",
  "could not connect",
];

export function isSandboxWorkspace(workspace: WorkspaceInfo) {
  return (
    workspace.workspaceType === "remote" &&
    (workspace.sandboxBackend === "docker" ||
      Boolean(workspace.sandboxRunId?.trim()) ||
      Boolean(workspace.sandboxContainerName?.trim()))
  );
}

export function getWorkspaceTaskLoadErrorDisplay(workspace: WorkspaceInfo, error?: string | null) {
  const raw = error?.trim() ?? "";
  const fallbackTitle = raw || tr("workspace.tasks_load_failed");
  if (!raw || !isSandboxWorkspace(workspace)) {
    return {
      tone: "error" as const,
      label: tr("status.error"),
      message: tr("workspace.tasks_load_failed"),
      title: fallbackTitle,
    };
  }

  const normalized = raw.toLowerCase();
  const hasDockerHint = SANDBOX_DOCKER_OFFLINE_HINTS.some((hint) => normalized.includes(hint));
  const hasNetworkHint = SANDBOX_NETWORK_HINTS.some((hint) => normalized.includes(hint));
  const host = `${workspace.baseUrl ?? ""} ${workspace.vesloHostUrl ?? ""}`.toLowerCase();
  const localHost = host.includes("localhost") || host.includes("127.0.0.1");

  if (!hasDockerHint && !(localHost && hasNetworkHint)) {
    return {
      tone: "error" as const,
      label: tr("status.error"),
      message: tr("workspace.tasks_load_failed"),
      title: fallbackTitle,
    };
  }

  const message = tr("workspace.sandbox_offline_message");
  return {
    tone: "offline" as const,
    label: tr("status.offline"),
    message,
    title: `${message}\n\n${raw}`,
  };
}
