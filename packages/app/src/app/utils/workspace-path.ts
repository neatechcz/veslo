export const splitPathSegments = (value: string) => value.split(/[/\\]/).filter(Boolean);

export const normalizePath = (value: string) => value.trim().replace(/[\\/]+/g, "/");

export const normalizeForComparison = (value: string) =>
  normalizePath(value).replace(/\/+$/, "");

export const normalizeRelative = (value: string) =>
  normalizePath(value).replace(/^\/+/, "").replace(/\/+$/, "");

const normalizeWindowsExtendedPrefix = (value: string) => {
  if (/^\/\/\?\/UNC\//i.test(value)) return `//${value.slice("//?/UNC/".length)}`;
  if (/^\/\/\?\//i.test(value)) return value.slice("//?/".length);
  return value;
};

const normalizeComparablePath = (value: string) => {
  const normalized = normalizeWindowsExtendedPrefix(normalizePath(value)).replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
};

const isWindowsLikePath = (value: string) => /^[A-Za-z]:\//.test(value) || value.startsWith("//");

export const pathComparisonKey = (value: string) => {
  const normalized = normalizeComparablePath(value);
  return isWindowsLikePath(normalized) ? normalized.toLowerCase() : normalized;
};

const sanitizeRelativeArtifactPath = (value: string): string | null => {
  const normalized = normalizePath(value).replace(/^\.\/+/, "").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
};

const relativeFromWorkspaceAlias = (value: string): string | null => {
  const normalized = normalizePath(value);
  if (normalized === "/workspace" || normalized === "workspace") return null;
  if (normalized.startsWith("/workspace/")) {
    return sanitizeRelativeArtifactPath(normalized.slice("/workspace/".length));
  }
  if (normalized.startsWith("workspace/")) {
    return sanitizeRelativeArtifactPath(normalized.slice("workspace/".length));
  }
  return null;
};

const wslMountPathToWindowsPath = (value: string): string | null => {
  const normalized = normalizePath(value);
  const match = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toUpperCase();
  if (!drive) return null;
  const rest = match[2]?.trim() ?? "";
  return rest ? `${drive}:/${rest}` : `${drive}:/`;
};

const relativeFromRoot = (value: string, root: string): string | null => {
  const candidate = normalizeComparablePath(value);
  const workspaceRoot = normalizeComparablePath(root);
  if (!candidate || !workspaceRoot) return null;

  const caseInsensitive = isWindowsLikePath(candidate) || isWindowsLikePath(workspaceRoot);
  const candidateKey = caseInsensitive ? candidate.toLowerCase() : candidate;
  const rootKey = caseInsensitive ? workspaceRoot.toLowerCase() : workspaceRoot;
  if (candidateKey === rootKey) return null;
  if (rootKey === "/" && candidate.startsWith("/")) {
    return sanitizeRelativeArtifactPath(candidate.slice(1));
  }
  if (!candidateKey.startsWith(`${rootKey}/`)) return null;
  return sanitizeRelativeArtifactPath(candidate.slice(workspaceRoot.length + 1));
};

export const workspaceArtifactPathToRelative = (value: string | undefined, workspaceRoot?: string): string | null => {
  const normalized = normalizePath(value ?? "");
  if (!normalized) return null;

  const aliasRelative = relativeFromWorkspaceAlias(normalized);
  if (aliasRelative) return aliasRelative;

  const root = workspaceRoot?.trim() ?? "";
  if (!root) return null;

  const hostRelative = relativeFromRoot(normalized, root);
  if (hostRelative) return hostRelative;

  const windowsFromWsl = wslMountPathToWindowsPath(normalized);
  if (windowsFromWsl) {
    return relativeFromRoot(windowsFromWsl, root);
  }

  return null;
};

export const normalizeWorkspaceArtifactPath = (value: string | undefined, workspaceRoot?: string) =>
  workspaceArtifactPathToRelative(value, workspaceRoot) ?? normalizePath(value ?? "");

export const toWorkspaceRelative = (file: string, root?: string) => {
  const normalizedRoot = (root ?? "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) return file;

  const normalizedFile = file.replace(/[\\/]+/g, "/");
  const caseInsensitive = isWindowsLikePath(normalizedRoot) || isWindowsLikePath(normalizedFile);
  const rootKey = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const fileKey = caseInsensitive ? normalizedFile.toLowerCase() : normalizedFile;

  if (fileKey === rootKey) return normalizedFile.split("/").pop() ?? normalizedFile;
  if (fileKey.startsWith(`${rootKey}/`)) return normalizedFile.slice(normalizedRoot.length + 1);
  return normalizedFile;
};

export const getBasename = (value: string) => {
  const segments = splitPathSegments(value);
  return segments[segments.length - 1] ?? value;
};

export const getDirname = (value: string) => {
  const segments = splitPathSegments(value);
  if (segments.length <= 1) return ".";
  return segments.slice(0, -1).join("/");
};
