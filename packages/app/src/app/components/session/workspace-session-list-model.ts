import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceSessionGroup } from "../../types";
import { normalizeDirectoryPath } from "../../utils";
import { currentLocale, t } from "../../../i18n";

const tr = (key: string) => t(key, currentLocale());

export type FlatSessionRow = {
  rowKey: string;
  workspace: WorkspaceInfo;
  session: WorkspaceSessionGroup["sessions"][number];
  status: WorkspaceSessionGroup["status"];
  error: string | null;
  parentSessionId: string | null;
  rootSessionId: string;
  nestingLevel: number;
  isSubagent: boolean;
  treeActivityAt: number;
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
  isWorkspaceOnlyProject: boolean;
};

export type SidebarProjectGroupSplit = {
  projectGroups: ProjectSessionGroup[];
  chatGroup: ProjectSessionGroup | null;
};

export const PRIVATE_PROJECT_GROUP_KEY = "project:veslo-private";

export const isPrivateChatProjectGroup = (group: ProjectSessionGroup) =>
  group.key === PRIVATE_PROJECT_GROUP_KEY || group.isPrivateProject;

const mergePrivateChatProjectGroup = (
  existing: ProjectSessionGroup | null,
  group: ProjectSessionGroup,
): ProjectSessionGroup => {
  if (!existing) return group;

  return {
    ...existing,
    sessions: [...existing.sessions, ...group.sessions],
    activityAt: Math.max(existing.activityAt, group.activityAt),
    status: existing.status === "error" ? existing.status : group.status,
    error: existing.error ?? group.error,
  };
};

export const splitProjectGroupsForSidebar = (
  groups: ProjectSessionGroup[],
): SidebarProjectGroupSplit => {
  const projectGroups: ProjectSessionGroup[] = [];
  let chatGroup: ProjectSessionGroup | null = null;

  for (const group of groups) {
    if (isPrivateChatProjectGroup(group)) {
      chatGroup = mergePrivateChatProjectGroup(chatGroup, group);
      continue;
    }
    projectGroups.push(group);
  }

  return { projectGroups, chatGroup };
};

export const sessionChatLabel = (
  session: Pick<WorkspaceSessionGroup["sessions"][number], "id" | "title" | "slug">,
  fallback: string,
) => session.title?.trim() || fallback;

export const sessionSidebarTitle = (
  row: Pick<FlatSessionRow, "isPrivateProject" | "session">,
  chatFallback: string,
) => row.isPrivateProject ? sessionChatLabel(row.session, chatFallback) : row.session.title;

export type CollapsedProjectMap = Record<string, boolean>;
export const NEW_SESSION_LABEL_VISIBLE_WIDTH = 220;
export const NEW_SESSION_LABEL_EXPAND_WIDTH = 300;

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
  creationTimestamp(session) || activityTimestamp(session) || Date.now();

export type SessionDisplayLabelParts = {
  decoratedName: string | null;
  description: string | null;
  tooltip: string;
};

export const splitSessionDisplayLabel = (
  sessionTitle: string | null | undefined,
  decorationLabel: string | null | undefined,
): SessionDisplayLabelParts => {
  const description = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
  const decoratedName = typeof decorationLabel === "string" ? decorationLabel.trim() : "";

  if (!decoratedName) {
    return {
      decoratedName: null,
      description: description || null,
      tooltip: description,
    };
  }

  if (!description || description === decoratedName) {
    return {
      decoratedName,
      description: null,
      tooltip: decoratedName,
    };
  }

  return {
    decoratedName,
    description,
    tooltip: `${decoratedName} · ${description}`,
  };
};

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const formatSessionRelativeAge = (timestampMs: number, nowMs = Date.now()) => {
  const delta = nowMs - timestampMs;

  if (delta < 0) return tr("time.just_now");
  if (delta < MINUTE_MS) return `${Math.max(1, Math.round(delta / SECOND_MS))}s`;
  if (delta < HOUR_MS) return `${Math.max(1, Math.round(delta / MINUTE_MS))}m`;
  if (delta < DAY_MS) return `${Math.max(1, Math.round(delta / HOUR_MS))}h`;
  return `${Math.max(1, Math.round(delta / DAY_MS))}d`;
};

export const formatSessionTimestampTooltip = (timestampMs: number, locale: string) => {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale || undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString();
  }
};

export const isProjectCollapsed = (collapsedProjects: CollapsedProjectMap, projectKey: string) =>
  Boolean(collapsedProjects[projectKey]);

export const shouldUseExpandedNewSessionLabel = (width: number) =>
  Number.isFinite(width) && width >= NEW_SESSION_LABEL_EXPAND_WIDTH;

export const shouldShowNewSessionLabelText = (width: number) =>
  Number.isFinite(width) && width >= NEW_SESSION_LABEL_VISIBLE_WIDTH;

export const toggleProjectCollapsed = (
  collapsedProjects: CollapsedProjectMap,
  projectKey: string,
): CollapsedProjectMap => ({
  ...collapsedProjects,
  [projectKey]: !collapsedProjects[projectKey],
});

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
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;

  return a.session.id.localeCompare(b.session.id);
};

const compareProjectRows = (a: FlatSessionRow, b: FlatSessionRow) => {
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;

  return a.session.id.localeCompare(b.session.id);
};

const compareProjectGroups = (
  a: ProjectSessionGroup,
  b: ProjectSessionGroup,
) => {
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byLabel = a.projectLabel.localeCompare(b.projectLabel);
  if (byLabel !== 0) return byLabel;

  return a.key.localeCompare(b.key);
};

const parentSessionIdForSession = (
  session: WorkspaceSessionGroup["sessions"][number],
): string | null => {
  const value = typeof session.parentID === "string" ? session.parentID.trim() : "";
  return value || null;
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
    parentSessionId: parentSessionIdForSession(session),
    rootSessionId: session.id,
    nestingLevel: 0,
    isSubagent: false,
    treeActivityAt: activityTimestamp(session),
    createdAt: creationTimestamp(session),
    updatedAt: updatedTimestamp(session),
    activityAt: activityTimestamp(session),
    projectRoot,
    projectLabel: isPrivateProject ? "" : basenameFromRoot(projectRoot),
    projectTitle: isPrivateProject ? "" : projectRoot || workspaceLabel(group.workspace),
    isPrivateProject,
  };
};

const collectFlatRows = (
  workspaceSessionGroups: WorkspaceSessionGroup[],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean,
): FlatSessionRow[] =>
  workspaceSessionGroups.flatMap((group) =>
    group.sessions.map((session) => buildFlatSessionRow(group, session, isPrivateWorkspacePath)),
  );

export type RowHierarchyLookup = {
  rowBySessionId: Map<string, FlatSessionRow>;
  parentBySessionId: Map<string, string>;
  childrenByParentId: Map<string, string[]>;
};

export const buildRowHierarchyLookup = (rows: FlatSessionRow[]): RowHierarchyLookup => {
  const rowBySessionId = new Map<string, FlatSessionRow>();
  const parentBySessionId = new Map<string, string>();
  const childrenByParentId = new Map<string, string[]>();

  for (const row of rows) {
    rowBySessionId.set(row.session.id, row);
  }

  for (const row of rows) {
    const parentId = row.parentSessionId;
    if (!parentId || !rowBySessionId.has(parentId)) continue;
    parentBySessionId.set(row.session.id, parentId);
    const existing = childrenByParentId.get(parentId);
    if (existing) {
      existing.push(row.session.id);
    } else {
      childrenByParentId.set(parentId, [row.session.id]);
    }
  }

  return { rowBySessionId, parentBySessionId, childrenByParentId };
};

export const rootRowsForSessionTree = (rows: FlatSessionRow[]): FlatSessionRow[] => {
  const ids = new Set(rows.map((row) => row.session.id));
  return rows.filter((row) => !row.parentSessionId || !ids.has(row.parentSessionId));
};

export const directChildRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const id = parentSessionId.trim();
  if (!id) return [];
  return rows.filter((row) => row.parentSessionId === id);
};

export const descendantRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const id = parentSessionId.trim();
  if (!id) return [];

  const parentIndex = rows.findIndex((row) => row.session.id === id);
  if (parentIndex < 0) return [];

  const parentLevel = rows[parentIndex].nestingLevel;
  const lookup = buildRowHierarchyLookup(rows);
  const descendants: FlatSessionRow[] = [];
  const isDescendantOf = (candidateId: string, ancestorId: string) => {
    let parentId = lookup.parentBySessionId.get(candidateId) ?? null;
    while (parentId) {
      if (parentId === ancestorId) return true;
      parentId = lookup.parentBySessionId.get(parentId) ?? null;
    }
    return false;
  };

  for (let index = parentIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.nestingLevel <= parentLevel) break;
    if (isDescendantOf(row.session.id, id)) descendants.push(row);
  }

  return descendants;
};

export const rowVisibleByExpansion = (
  row: FlatSessionRow,
  lookup: RowHierarchyLookup,
  expandedParentSessionIds: ReadonlySet<string>,
) => {
  let parentId = lookup.parentBySessionId.get(row.session.id) ?? null;
  while (parentId) {
    if (!lookup.rowBySessionId.has(parentId)) {
      // Parent missing from current data slice (pagination, loading) — keep child visible.
      return true;
    }
    if (!expandedParentSessionIds.has(parentId)) return false;
    parentId = lookup.parentBySessionId.get(parentId) ?? null;
  }
  return true;
};

export const requiredVisibleCountForExpandedSession = (
  rows: FlatSessionRow[],
  expandedParentSessionIds: ReadonlySet<string>,
  sessionId: string,
): number | null => {
  const id = sessionId.trim();
  if (!id) return null;

  const lookup = buildRowHierarchyLookup(rows);
  if (!lookup.rowBySessionId.has(id)) return null;
  const childCount = lookup.childrenByParentId.get(id)?.length ?? 0;
  if (childCount === 0) return null;

  const visibleRows = rows.filter((row) =>
    rowVisibleByExpansion(row, lookup, expandedParentSessionIds)
  );
  const parentIndex = visibleRows.findIndex((row) => row.session.id === id);
  if (parentIndex < 0) return null;

  const isDescendantOf = (candidateId: string, ancestorId: string) => {
    let parentId = lookup.parentBySessionId.get(candidateId) ?? null;
    while (parentId) {
      if (parentId === ancestorId) return true;
      parentId = lookup.parentBySessionId.get(parentId) ?? null;
    }
    return false;
  };

  let deepestVisibleDescendantIndex = parentIndex;
  for (let index = parentIndex + 1; index < visibleRows.length; index += 1) {
    if (isDescendantOf(visibleRows[index].session.id, id)) {
      deepestVisibleDescendantIndex = index;
    }
  }

  return deepestVisibleDescendantIndex + 1;
};

export type SessionRowClickAction = {
  openSession: boolean;
  toggleExpandedParent: boolean;
};

export const resolveSessionRowClickAction = (input: {
  selectedSessionId: string | null | undefined;
  clickedSessionId: string | null | undefined;
  hasChildren: boolean;
  allowSelectedParentExpansion: boolean;
}): SessionRowClickAction => {
  const selected = input.selectedSessionId?.trim() ?? "";
  const clicked = input.clickedSessionId?.trim() ?? "";
  if (!clicked) {
    return {
      openSession: false,
      toggleExpandedParent: false,
    };
  }

  if (selected !== clicked) {
    return {
      openSession: true,
      toggleExpandedParent: false,
    };
  }

  return {
    openSession: true,
    toggleExpandedParent: input.allowSelectedParentExpansion && input.hasChildren,
  };
};

const buildHierarchicalRows = (
  rows: FlatSessionRow[],
  compareRows: (a: FlatSessionRow, b: FlatSessionRow) => number,
): FlatSessionRow[] => {
  if (!rows.length) return [];

  const rowBySessionId = new Map(rows.map((row) => [row.session.id, row] as const));
  const childrenByParentId = new Map<string, FlatSessionRow[]>();

  for (const row of rows) {
    const parentId = row.parentSessionId;
    if (!parentId || !rowBySessionId.has(parentId)) continue;
    const existing = childrenByParentId.get(parentId);
    if (existing) {
      existing.push(row);
    } else {
      childrenByParentId.set(parentId, [row]);
    }
  }

  const resolving = new Set<string>();
  const hierarchyCache = new Map<string, { rootSessionId: string; nestingLevel: number }>();
  const resolveHierarchy = (sessionId: string): { rootSessionId: string; nestingLevel: number } => {
    const cached = hierarchyCache.get(sessionId);
    if (cached) return cached;
    if (resolving.has(sessionId)) {
      return { rootSessionId: sessionId, nestingLevel: 0 };
    }

    resolving.add(sessionId);
    const row = rowBySessionId.get(sessionId);
    let next: { rootSessionId: string; nestingLevel: number };
    if (!row?.parentSessionId || !rowBySessionId.has(row.parentSessionId)) {
      next = { rootSessionId: sessionId, nestingLevel: 0 };
    } else {
      const parent = resolveHierarchy(row.parentSessionId);
      next = parent.rootSessionId === sessionId
        ? { rootSessionId: sessionId, nestingLevel: 0 }
        : { rootSessionId: parent.rootSessionId, nestingLevel: parent.nestingLevel + 1 };
    }

    resolving.delete(sessionId);
    hierarchyCache.set(sessionId, next);
    return next;
  };

  const treeActivityByRootId = new Map<string, number>();
  for (const row of rows) {
    const info = resolveHierarchy(row.session.id);
    const latest = treeActivityByRootId.get(info.rootSessionId) ?? 0;
    treeActivityByRootId.set(info.rootSessionId, Math.max(latest, row.activityAt));
  }

  for (const children of childrenByParentId.values()) {
    children.sort(compareRows);
  }

  const compareRootRows = (a: FlatSessionRow, b: FlatSessionRow) => {
    const aRoot = resolveHierarchy(a.session.id).rootSessionId;
    const bRoot = resolveHierarchy(b.session.id).rootSessionId;
    const byTreeActivity =
      (treeActivityByRootId.get(bRoot) ?? b.activityAt) - (treeActivityByRootId.get(aRoot) ?? a.activityAt);
    if (byTreeActivity !== 0) return byTreeActivity;
    return compareRows(a, b);
  };

  const emittedSessionIds = new Set<string>();
  const ordered: FlatSessionRow[] = [];
  const applyPrivateRootContext = (row: FlatSessionRow, rootRow: FlatSessionRow): FlatSessionRow => {
    if (!rootRow.isPrivateProject || rootRow.session.id === row.session.id) return row;
    return {
      ...row,
      rowKey: `${rootRow.workspace.id}:${row.session.id}`,
      workspace: rootRow.workspace,
      status: rootRow.status,
      error: rootRow.error,
      projectRoot: rootRow.projectRoot,
      projectLabel: rootRow.projectLabel,
      projectTitle: rootRow.projectTitle,
      isPrivateProject: true,
    };
  };
  const appendRow = (row: FlatSessionRow) => {
    if (emittedSessionIds.has(row.session.id)) return;
    emittedSessionIds.add(row.session.id);

    const info = resolveHierarchy(row.session.id);
    const rootRow = rowBySessionId.get(info.rootSessionId) ?? row;
    const contextualRow = applyPrivateRootContext(row, rootRow);
    ordered.push({
      ...contextualRow,
      rootSessionId: info.rootSessionId,
      nestingLevel: info.nestingLevel,
      isSubagent: info.nestingLevel > 0,
      treeActivityAt: treeActivityByRootId.get(info.rootSessionId) ?? row.activityAt,
    });

    const children = childrenByParentId.get(row.session.id) ?? [];
    for (const child of children) {
      appendRow(child);
    }
  };

  rows
    .filter((row) => resolveHierarchy(row.session.id).nestingLevel === 0)
    .sort(compareRootRows)
    .forEach((row) => appendRow(row));

  rows
    .filter((row) => !emittedSessionIds.has(row.session.id))
    .sort(compareRows)
    .forEach((row) => appendRow(row));

  return ordered;
};

const projectGroupKeyForRow = (row: FlatSessionRow) =>
  row.isPrivateProject
    ? PRIVATE_PROJECT_GROUP_KEY
    : row.projectRoot || `workspace:${row.workspace.id}`;

const buildWorkspaceOnlyProjectGroup = (
  group: WorkspaceSessionGroup,
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean,
): ProjectSessionGroup | null => {
  if (group.workspace.workspaceType !== "local") return null;

  const projectRoot = rootForWorkspace(group.workspace);
  if (!projectRoot) {
    return null;
  }
  const isPrivateProject = isPrivateProjectRoot(group.workspace, projectRoot, isPrivateWorkspacePath);

  return {
    key: isPrivateProject ? PRIVATE_PROJECT_GROUP_KEY : projectRoot,
    workspace: group.workspace,
    sessions: [],
    status: group.status,
    error: group.error ?? null,
    activityAt: 0,
    projectRoot,
    projectLabel: isPrivateProject ? "" : basenameFromRoot(projectRoot) || workspaceLabel(group.workspace),
    projectTitle: isPrivateProject ? "" : projectRoot || workspaceLabel(group.workspace),
    isPrivateProject,
    isWorkspaceOnlyProject: true,
  };
};

export const filterVisibleProjectGroups = (
  projectGroups: ProjectSessionGroup[],
  shouldShowSessionRow: (row: FlatSessionRow) => boolean,
): ProjectSessionGroup[] =>
  projectGroups
    .map((group) => {
      const sessions = group.sessions.filter((row) => shouldShowSessionRow(row));
      const becameEmptyLocalProject =
        group.sessions.length > 0 &&
        sessions.length === 0 &&
        group.workspace.workspaceType === "local" &&
        !group.isPrivateProject;

      return {
        ...group,
        sessions,
        isWorkspaceOnlyProject: group.isWorkspaceOnlyProject || becameEmptyLocalProject,
      };
    })
    .filter((group) => group.sessions.length > 0 || group.isWorkspaceOnlyProject);

export const buildRecentRows = (
  workspaceSessionGroups: WorkspaceSessionGroup[],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean = defaultPrivateWorkspacePath,
): FlatSessionRow[] => {
  const rows = collectFlatRows(workspaceSessionGroups, isPrivateWorkspacePath);
  return buildHierarchicalRows(rows, compareRecentRows);
};

export const buildProjectGroups = (
  workspaceSessionGroups: WorkspaceSessionGroup[],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean = defaultPrivateWorkspacePath,
): ProjectSessionGroup[] => {
  const rows = collectFlatRows(workspaceSessionGroups, isPrivateWorkspacePath);
  const rowBySessionId = new Map(rows.map((row) => [row.session.id, row] as const));
  const groupedRows = new Map<string, FlatSessionRow[]>();

  for (const row of buildHierarchicalRows(rows, compareProjectRows)) {
    const root = rowBySessionId.get(row.rootSessionId) ?? row;
    const groupKey = projectGroupKeyForRow(root);
    const existing = groupedRows.get(groupKey);
    if (existing) {
      existing.push(row);
    } else {
      groupedRows.set(groupKey, [row]);
    }
  }

  const sessionBackedGroups = Array.from(groupedRows.entries())
    .map(([key, sessions]) => {
      const isPrivateProject = key === PRIVATE_PROJECT_GROUP_KEY;
      const leadSession = sessions.find((row) => row.nestingLevel === 0) ?? sessions[0];

      return {
        key,
        workspace: leadSession.workspace,
        sessions,
        status: leadSession.status,
        error: leadSession.error,
        activityAt: sessions.reduce((latest, row) => Math.max(latest, row.treeActivityAt), 0),
        projectRoot: isPrivateProject ? "" : leadSession.projectRoot,
        projectLabel: isPrivateProject ? "" : leadSession.projectLabel,
        projectTitle: isPrivateProject ? "" : leadSession.projectTitle,
        isPrivateProject,
        isWorkspaceOnlyProject: false,
      };
    });

  const sessionBackedKeys = new Set(sessionBackedGroups.map((group) => group.key));
  const workspaceOnlyGroups = workspaceSessionGroups
    .filter((group) => group.sessions.length === 0)
    .map((group) => buildWorkspaceOnlyProjectGroup(group, isPrivateWorkspacePath))
    .filter((group): group is ProjectSessionGroup => Boolean(group))
    .filter((group) => !sessionBackedKeys.has(group.key));

  return [...sessionBackedGroups, ...workspaceOnlyGroups].sort(compareProjectGroups);
};
