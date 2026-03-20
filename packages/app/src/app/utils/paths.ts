import type { WorkspaceInfo } from "../lib/tauri";

export function isTauriRuntime() {
  return typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ != null;
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
  const fallbackTitle = raw || "Failed to load tasks";
  if (!raw || !isSandboxWorkspace(workspace)) {
    return {
      tone: "error" as const,
      label: "Error",
      message: "Failed to load tasks",
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
      label: "Error",
      message: "Failed to load tasks",
      title: fallbackTitle,
    };
  }

  const message = "Sandbox is offline. Start Docker Desktop, then test connection.";
  return {
    tone: "offline" as const,
    label: "Offline",
    message,
    title: `${message}\n\n${raw}`,
  };
}
