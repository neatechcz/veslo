import type { AutomationWorkspaceSummary } from "../types";
import { normalizeDirectoryPath } from "../utils";
import type { WorkspaceInfo } from "./tauri";
import { parseVesloWorkspaceIdFromUrl, type VesloWorkspaceInfo } from "./veslo-server";

const UNMAPPED_WORKSPACE_ERROR = "Workspace is not mapped on the connected Veslo server.";

const automationWorkspaceName = (workspace: WorkspaceInfo) =>
  workspace.vesloWorkspaceName?.trim() ||
  workspace.displayName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  workspace.id;

const serverWorkspaceDirectoryCandidates = (
  workspace: { path?: string | null; directory?: string | null; opencode?: { directory?: string | null } | null },
) =>
  [
    normalizeDirectoryPath(workspace.path ?? ""),
    normalizeDirectoryPath(workspace.directory ?? ""),
    normalizeDirectoryPath(workspace.opencode?.directory ?? ""),
  ].filter(Boolean);

const findServerWorkspaceByDirectory = (
  workspaces: Array<{ id: string; path?: string | null; directory?: string | null; opencode?: { directory?: string | null } | null }>,
  directory: string | null | undefined,
) => {
  const key = normalizeDirectoryPath(directory ?? "");
  if (!key) return null;
  return workspaces.find((entry) => serverWorkspaceDirectoryCandidates(entry).includes(key)) ?? null;
};

const urlOrigin = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return "";
  }
};

const remoteWorkspaceBelongsToDifferentServer = (
  workspace: WorkspaceInfo,
  connectedServerBaseUrl: string | null | undefined,
) => {
  const connectedOrigin = urlOrigin(connectedServerBaseUrl);
  if (!connectedOrigin) return false;

  const workspaceOrigins = [
    urlOrigin(workspace.vesloHostUrl),
    urlOrigin(workspace.baseUrl),
  ].filter(Boolean);
  return workspaceOrigins.length > 0 && !workspaceOrigins.includes(connectedOrigin);
};

export function buildAutomationWorkspaceSummaries(input: {
  appWorkspaces: WorkspaceInfo[];
  serverWorkspaces: VesloWorkspaceInfo[];
  connectedServerBaseUrl: string | null | undefined;
}): AutomationWorkspaceSummary[] {
  const idByLocalPath = new Map<string, string>();
  for (const item of input.serverWorkspaces) {
    for (const path of serverWorkspaceDirectoryCandidates(item)) {
      idByLocalPath.set(path, item.id);
    }
  }
  const listedServerWorkspaceIds = new Set(input.serverWorkspaces.map((item) => item.id));
  const summaries: AutomationWorkspaceSummary[] = [];

  for (const workspace of input.appWorkspaces) {
    let serverWorkspaceId: string | null = null;

    if (workspace.workspaceType === "local") {
      const key = normalizeDirectoryPath(workspace.path ?? "");
      serverWorkspaceId = key ? idByLocalPath.get(key) ?? null : null;
    } else if (workspace.remoteType === "veslo") {
      const storedServerWorkspaceId =
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        null;

      serverWorkspaceId =
        storedServerWorkspaceId && listedServerWorkspaceIds.has(storedServerWorkspaceId)
          ? storedServerWorkspaceId
          : null;

      if (!serverWorkspaceId) {
        const match = findServerWorkspaceByDirectory(input.serverWorkspaces, workspace.directory ?? workspace.path ?? "");
        serverWorkspaceId = match?.id ?? null;
      }

      if (!serverWorkspaceId && remoteWorkspaceBelongsToDifferentServer(workspace, input.connectedServerBaseUrl)) {
        continue;
      }
    }

    summaries.push({
      appWorkspaceId: workspace.id,
      serverWorkspaceId,
      name: automationWorkspaceName(workspace),
      path: workspace.directory ?? workspace.path ?? null,
      workspaceType: workspace.workspaceType,
      status: serverWorkspaceId ? "ready" : "unavailable",
      error: serverWorkspaceId ? null : UNMAPPED_WORKSPACE_ERROR,
    });
  }

  return summaries;
}
