import type { AutomationWorkspaceSummary } from "../types";
import type { WorkspaceInfo } from "./tauri";
import { parseVesloWorkspaceIdFromUrl, type VesloWorkspaceInfo } from "./veslo-server";

const UNMAPPED_WORKSPACE_ERROR = "Workspace is not mapped on the connected Veslo server.";

const automationWorkspaceName = (workspace: WorkspaceInfo) =>
  workspace.vesloWorkspaceName?.trim() ||
  workspace.displayName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  workspace.id;

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
  const listedServerWorkspaceIds = new Set(input.serverWorkspaces.map((item) => item.id));
  const summaries: AutomationWorkspaceSummary[] = [];

  for (const workspace of input.appWorkspaces) {
    let serverWorkspaceId: string | null = null;

    if (workspace.workspaceType === "local") {
      const mappedServerWorkspaceId = workspace.vesloWorkspaceId?.trim() ?? "";
      serverWorkspaceId =
        mappedServerWorkspaceId && listedServerWorkspaceIds.has(mappedServerWorkspaceId)
          ? mappedServerWorkspaceId
          : null;
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
