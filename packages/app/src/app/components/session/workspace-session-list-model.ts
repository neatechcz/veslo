import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceSessionGroup } from "../../types";
import { normalizeDirectoryPath } from "../../utils";

export type FlatSessionRow = {
  rowKey: string;
  workspace: WorkspaceInfo;
  session: WorkspaceSessionGroup["sessions"][number];
  status: WorkspaceSessionGroup["status"];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
  projectRoot: string;
  projectLabel: string;
  projectTitle: string;
  isPrivateProject: boolean;
};

export type ProjectSessionGroup = {
  key: string;
  workspace: WorkspaceInfo;
  sessions: FlatSessionRow[];
  status: WorkspaceSessionGroup["status"];
  error: string | null;
  activityAt: number;
  projectRoot: string;
  projectLabel: string;
  projectTitle: string;
  isPrivateProject: boolean;
};

export const PRIVATE_PROJECT_GROUP_KEY = "project:veslo-private";

const defaultPrivateWorkspacePath = () => false;

const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.vesloWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.directory?.trim() ||
  workspace.path?.trim() ||
  "Workspace";

export const creationTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.created ?? 0;

export const updatedTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.updated ?? 0;

export const activityTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  session.time?.updated ?? session.time?.created ?? 0;

export const displayTimestamp = (session: WorkspaceSessionGroup["sessions"][number]) =>
  activityTimestamp(session) || Date.now();

const rootForWorkspace = (workspace: WorkspaceInfo) =>
  normalizeDirectoryPath(
    workspace.workspaceType === "remote"
      ? workspace.directory?.trim() ?? workspace.path?.trim() ?? ""
      : workspace.path?.trim() ?? "",
  );

const rootForSession = (
  workspace: WorkspaceInfo,
  session: WorkspaceSessionGroup["sessions"][number],
) => normalizeDirectoryPath(session.directory?.trim() ?? "") || rootForWorkspace(workspace);

const basenameFromRoot = (root: string) => {
  const normalized = normalizeDirectoryPath(root);
  if (!normalized) return "";
  if (normalized === "/") return "/";
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

const isPrivateProjectRoot = (
  workspace: WorkspaceInfo,
  projectRoot: string,
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean,
) => workspace.workspaceType === "local" && isPrivateWorkspacePath(projectRoot);

const compareRecentRows = (a: FlatSessionRow, b: FlatSessionRow) => {
  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;

  const byUpdated = b.updatedAt - a.updatedAt;
  if (byUpdated !== 0) return byUpdated;

  return a.session.id.localeCompare(b.session.id);
};

const compareProjectRows = (a: FlatSessionRow, b: FlatSessionRow) => {
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;

  return a.session.id.localeCompare(b.session.id);
};

const compareProjectGroups = (a: ProjectSessionGroup, b: ProjectSessionGroup) => {
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byLabel = a.projectLabel.localeCompare(b.projectLabel);
  if (byLabel !== 0) return byLabel;

  return a.workspace.id.localeCompare(b.workspace.id);
};

const buildFlatSessionRow = (
  group: WorkspaceSessionGroup,
  session: WorkspaceSessionGroup["sessions"][number],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean,
): FlatSessionRow => {
  const projectRoot = rootForSession(group.workspace, session);
  const isPrivateProject = isPrivateProjectRoot(group.workspace, projectRoot, isPrivateWorkspacePath);

  return {
    rowKey: `${group.workspace.id}:${session.id}`,
    workspace: group.workspace,
    session,
    status: group.status,
    error: group.error ?? null,
    createdAt: creationTimestamp(session),
    updatedAt: updatedTimestamp(session),
    activityAt: activityTimestamp(session),
    projectRoot,
    projectLabel: isPrivateProject ? "" : basenameFromRoot(projectRoot),
    projectTitle: isPrivateProject ? "" : projectRoot || workspaceLabel(group.workspace),
    isPrivateProject,
  };
};

export const buildRecentRows = (
  workspaceSessionGroups: WorkspaceSessionGroup[],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean = defaultPrivateWorkspacePath,
): FlatSessionRow[] => {
  const rows = workspaceSessionGroups.flatMap((group) =>
    group.sessions.map((session) => buildFlatSessionRow(group, session, isPrivateWorkspacePath)),
  );

  rows.sort(compareRecentRows);
  return rows;
};

export const buildProjectGroups = (
  workspaceSessionGroups: WorkspaceSessionGroup[],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean = defaultPrivateWorkspacePath,
): ProjectSessionGroup[] => {
  const groupedRows = new Map<string, FlatSessionRow[]>();

  for (const group of workspaceSessionGroups) {
    for (const session of group.sessions) {
      const row = buildFlatSessionRow(group, session, isPrivateWorkspacePath);
      const groupKey = row.isPrivateProject
        ? PRIVATE_PROJECT_GROUP_KEY
        : row.projectRoot || `workspace:${row.workspace.id}`;
      const existing = groupedRows.get(groupKey);
      if (existing) {
        existing.push(row);
      } else {
        groupedRows.set(groupKey, [row]);
      }
    }
  }

  return Array.from(groupedRows.entries())
    .map(([key, sessions]) => {
      const isPrivateProject = key === PRIVATE_PROJECT_GROUP_KEY;
      sessions.sort(isPrivateProject ? compareRecentRows : compareProjectRows);
      const leadSession = sessions[0];

      return {
        key,
        workspace: leadSession.workspace,
        sessions,
        status: leadSession.status,
        error: leadSession.error,
        activityAt: sessions.reduce((latest, row) => Math.max(latest, row.activityAt), 0),
        projectRoot: isPrivateProject ? "" : leadSession.projectRoot,
        projectLabel: isPrivateProject ? "" : leadSession.projectLabel,
        projectTitle: isPrivateProject ? "" : leadSession.projectTitle,
        isPrivateProject,
      };
    })
    .sort(compareProjectGroups);
};
