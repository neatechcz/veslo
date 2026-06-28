export type PickerStartPathInput = {
  requestedPath: string;
  existingDirectories: Set<string>;
};

export function choosePickerStartPath(input: PickerStartPathInput): string {
  const requestedPath = normalizePath(input.requestedPath);
  const existingDirectories = new Map(
    Array.from(input.existingDirectories, (directory) => {
      const normalized = normalizePath(directory);
      return [normalized.key, normalized.display] as const;
    }),
  );
  let candidate = requestedPath.key;

  while (candidate) {
    const existingDirectory = existingDirectories.get(candidate);
    if (existingDirectory) return existingDirectory;
    const parent = parentPathKey(candidate, requestedPath.rootKey);
    if (parent === candidate) break;
    candidate = parent;
  }

  return requestedPath.display;
}

export function selectedFolderContainsRequestedPath(
  selectedFolderPath: string,
  requestedPath: string,
): boolean {
  const selected = normalizePath(selectedFolderPath);
  const requested = normalizePath(requestedPath);

  if (!selected.key || !requested.key) return false;
  if (selected.key === requested.key) return true;

  if (selected.key === selected.rootKey && selected.key.endsWith("/")) {
    return requested.key.startsWith(selected.key);
  }

  return requested.key.startsWith(`${selected.key}/`);
}

export type FolderAccessPermission = {
  id?: string;
  workspaceId?: string;
  permission?: string;
  patterns?: string[];
  metadata?: unknown;
};

export type FolderAccessWorkspace = {
  id?: string;
  path?: string;
  directory?: string | null;
  workspaceType?: string | null;
};

export type FolderAccessRequestInput = {
  permission: FolderAccessPermission | null | undefined;
  workspacePath: string;
  activeWorkspaceId?: string;
  workspaces?: FolderAccessWorkspace[];
  authorizedDirs: string[];
};

export type ResolvedFolderAccessRequest = {
  permissionId: string;
  workspaceId?: string;
  workspacePath: string;
  requestedPath: string;
  reason: string;
  pickerStartPath: string;
};

const FOLDER_ACCESS_METADATA_PATH_KEYS = [
  "requestedPath",
  "path",
  "folderPath",
  "targetPath",
  "deniedPath",
  "filePath",
] as const;

const FOLDER_ACCESS_METADATA_PICKER_KEYS = [
  "pickerStartPath",
  "folderPath",
  "directory",
  "dir",
] as const;

const FOLDER_ACCESS_METADATA_REASON_KEYS = [
  "reason",
  "message",
  "description",
] as const;

const FOLDER_ACCESS_PERMISSION_MARKERS = [
  "folder_access",
  "external_directory",
  "filesystem",
  "file_system",
  "sandbox",
  "read_file",
  "read_folder",
] as const;

export function resolveFolderAccessRequestFromPermission(
  input: FolderAccessRequestInput,
): ResolvedFolderAccessRequest | null {
  const permission = input.permission;
  if (!permission) return null;

  const permissionId = readString(permission.id).trim();
  const permissionWorkspaceId = readString(permission.workspaceId).trim();
  const workspacePath = resolvePermissionWorkspacePath(input, permissionWorkspaceId);
  if (!permissionId || !workspacePath) return null;

  const metadata = asRecord(permission.metadata);
  const permissionName = readString(permission.permission).trim();
  const metadataRequestedPath = findFirstMetadataString(metadata, FOLDER_ACCESS_METADATA_PATH_KEYS);
  const markerPermission = permissionLooksLikeFolderAccess(permissionName, metadata);
  if (!markerPermission) return null;

  const patternRequestedPath = markerPermission ? findFirstAbsolutePath(permission.patterns ?? []) : "";
  const requestedPath = (isAbsoluteFolderAccessPath(metadataRequestedPath) ? metadataRequestedPath : patternRequestedPath).trim();

  if (!requestedPath || !isAbsoluteFolderAccessPath(requestedPath)) return null;
  if (input.authorizedDirs.some((directory) => selectedFolderContainsRequestedPath(directory, requestedPath))) {
    return null;
  }

  const pickerMetadataPath = findFirstMetadataString(metadata, FOLDER_ACCESS_METADATA_PICKER_KEYS);
  const existingDirectories = new Set(
    [workspacePath, ...input.authorizedDirs, pickerMetadataPath]
      .map((path) => path.trim())
      .filter((path) => path && isAbsoluteFolderAccessPath(path)),
  );

  const reason =
    findFirstMetadataString(metadata, FOLDER_ACCESS_METADATA_REASON_KEYS).trim() ||
    permissionName ||
    "Folder access requested";

  return {
    permissionId,
    workspaceId: permissionWorkspaceId || undefined,
    workspacePath,
    requestedPath,
    reason,
    pickerStartPath: choosePickerStartPath({
      requestedPath,
      existingDirectories,
    }),
  };
}

type NormalizedPath = {
  key: string;
  display: string;
  rootKey: string;
};

type PathRoot = {
  rootDisplay: string;
  rootKey: string;
  rest: string;
  caseInsensitive: boolean;
};

function normalizePath(value: string): NormalizedPath {
  const root = splitRoot(value.trim().replace(/\\/g, "/"));
  const displaySegments: string[] = [];
  const keySegments: string[] = [];

  for (const segment of root.rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (displaySegments.length > 0) {
        displaySegments.pop();
        keySegments.pop();
      } else if (!root.rootDisplay) {
        displaySegments.push(segment);
        keySegments.push(segment);
      }
      continue;
    }

    displaySegments.push(segment);
    keySegments.push(root.caseInsensitive ? segment.toLowerCase() : segment);
  }

  return {
    key: joinPath(root.rootKey, keySegments),
    display: joinPath(root.rootDisplay, displaySegments),
    rootKey: root.rootKey,
  };
}

function splitRoot(value: string): PathRoot {
  const driveMatch = /^([A-Za-z]:)(?:\/+)?(.*)$/.exec(value);
  if (driveMatch) {
    const rootDisplay = `${driveMatch[1]}/`;
    return {
      rootDisplay,
      rootKey: rootDisplay.toLowerCase(),
      rest: driveMatch[2] ?? "",
      caseInsensitive: true,
    };
  }

  if (value.startsWith("//")) {
    const parts = value.slice(2).split("/").filter(Boolean);
    if (parts.length >= 2) {
      const rootDisplay = `//${parts[0]}/${parts[1]}`;
      return {
        rootDisplay,
        rootKey: rootDisplay.toLowerCase(),
        rest: parts.slice(2).join("/"),
        caseInsensitive: true,
      };
    }
    return { rootDisplay: "//", rootKey: "//", rest: parts.join("/"), caseInsensitive: true };
  }

  if (value.startsWith("/")) {
    return {
      rootDisplay: "/",
      rootKey: "/",
      rest: value.replace(/^\/+/, ""),
      caseInsensitive: false,
    };
  }

  return { rootDisplay: "", rootKey: "", rest: value, caseInsensitive: false };
}

function joinPath(root: string, segments: string[]): string {
  if (segments.length === 0) return root;
  if (!root) return segments.join("/");
  if (root.endsWith("/")) return `${root}${segments.join("/")}`;
  return `${root}/${segments.join("/")}`;
}

function parentPathKey(value: string, root: string): string {
  if (value === root) return value;

  const index = value.lastIndexOf("/");
  if (index < 0) return root || value;
  if (root && index < root.length) return root;
  if (root && index === root.length - 1) return root;

  return value.slice(0, index) || root || value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function findFirstMetadataString(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = readString(metadata[key]).trim();
    if (value) return value;
  }
  return "";
}

function permissionLooksLikeFolderAccess(
  permissionName: string,
  metadata: Record<string, unknown>,
): boolean {
  const normalized = permissionName.trim().toLowerCase();
  if (FOLDER_ACCESS_PERMISSION_MARKERS.some((marker) => normalized.includes(marker))) return true;

  const accessMode = readString(metadata.accessMode).trim().toLowerCase();
  const kind = readString(metadata.kind).trim().toLowerCase();
  return accessMode === "read" && (kind.includes("folder") || kind.includes("file"));
}

function resolvePermissionWorkspacePath(
  input: FolderAccessRequestInput,
  permissionWorkspaceId: string,
): string {
  const activeWorkspacePath = input.workspacePath.trim();
  if (!permissionWorkspaceId) return activeWorkspacePath;

  const activeWorkspaceId = input.activeWorkspaceId?.trim() ?? "";
  const workspace = (input.workspaces ?? []).find((item) => readString(item.id).trim() === permissionWorkspaceId);
  if (!workspace) {
    return activeWorkspaceId && activeWorkspaceId === permissionWorkspaceId ? activeWorkspacePath : "";
  }
  if (readString(workspace.workspaceType).trim() !== "local") return "";

  return readString(workspace.path).trim() || readString(workspace.directory).trim();
}

function findFirstAbsolutePath(values: readonly string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (isAbsoluteFolderAccessPath(trimmed)) return trimmed;
  }
  return "";
}

function isAbsoluteFolderAccessPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /^\/\/[^/]+\/[^/]+/.test(normalized)
  );
}
