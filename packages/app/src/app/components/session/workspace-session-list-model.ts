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
  parentRowKey: string | null;
  rootSessionId: string;
  rootRowKey: string;
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

  return a.rowKey.localeCompare(b.rowKey);
};

const compareProjectRows = (a: FlatSessionRow, b: FlatSessionRow) => {
  const byActivity = b.activityAt - a.activityAt;
  if (byActivity !== 0) return byActivity;

  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;

  return a.rowKey.localeCompare(b.rowKey);
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

const rowKeyForSession = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;

const rowIdentity = (row: Pick<FlatSessionRow, "rowKey" | "workspace" | "session">) =>
  row.rowKey || rowKeyForSession(row.workspace.id, row.session.id);

const resolveRowByIdentity = (rows: FlatSessionRow[], identity: string): FlatSessionRow | null => {
  const id = identity.trim();
  if (!id) return null;
  return rows.find((row) => rowIdentity(row) === id) ?? rows.find((row) => row.session.id === id) ?? null;
};

const buildRowKeyIndexes = (rows: FlatSessionRow[]) => {
  const rowByKey = new Map<string, FlatSessionRow>();
  const rowKeysBySessionId = new Map<string, string[]>();

  for (const row of rows) {
    const key = rowIdentity(row);
    rowByKey.set(key, row);
    const existing = rowKeysBySessionId.get(row.session.id);
    if (existing) {
      existing.push(key);
    } else {
      rowKeysBySessionId.set(row.session.id, [key]);
    }
  }

  return { rowByKey, rowKeysBySessionId };
};

const resolveParentRowKey = (
  row: FlatSessionRow,
  rowByKey: ReadonlyMap<string, FlatSessionRow>,
  rowKeysBySessionId: ReadonlyMap<string, readonly string[]>,
): string | null => {
  const parentId = row.parentSessionId?.trim() ?? "";
  if (!parentId) return null;

  const sameWorkspaceKey = rowKeyForSession(row.workspace.id, parentId);
  if (rowByKey.has(sameWorkspaceKey)) return sameWorkspaceKey;

  const candidates = rowKeysBySessionId.get(parentId) ?? [];
  return candidates.length === 1 ? candidates[0] ?? null : null;
};

const buildFlatSessionRow = (
  group: WorkspaceSessionGroup,
  session: WorkspaceSessionGroup["sessions"][number],
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean,
): FlatSessionRow => {
  const projectRoot = rootForSession(group.workspace, session);
  const isPrivateProject = isPrivateProjectRoot(group.workspace, projectRoot, isPrivateWorkspacePath);
  const rowKey = rowKeyForSession(group.workspace.id, session.id);

  return {
    rowKey,
    workspace: group.workspace,
    session,
    status: group.status,
    error: group.error ?? null,
    parentSessionId: parentSessionIdForSession(session),
    parentRowKey: null,
    rootSessionId: session.id,
    rootRowKey: rowKey,
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
  rowByRowKey: Map<string, FlatSessionRow>;
  parentBySessionId: Map<string, string>;
  parentByRowKey: Map<string, string>;
  childrenByParentId: Map<string, string[]>;
  childrenByParentRowKey: Map<string, string[]>;
};

export const buildRowHierarchyLookup = (rows: FlatSessionRow[]): RowHierarchyLookup => {
  const rowBySessionId = new Map<string, FlatSessionRow>();
  const rowByRowKey = new Map<string, FlatSessionRow>();
  const parentBySessionId = new Map<string, string>();
  const parentByRowKey = new Map<string, string>();
  const childrenByParentId = new Map<string, string[]>();
  const childrenByParentRowKey = new Map<string, string[]>();
  const { rowByKey, rowKeysBySessionId } = buildRowKeyIndexes(rows);

  for (const row of rows) {
    rowBySessionId.set(row.session.id, row);
    rowByRowKey.set(rowIdentity(row), row);
  }

  for (const row of rows) {
    const parentId = row.parentSessionId;
    const parentRowKey = row.parentRowKey ?? resolveParentRowKey(row, rowByKey, rowKeysBySessionId);
    if (!parentId || !parentRowKey || !rowByRowKey.has(parentRowKey)) continue;
    parentBySessionId.set(row.session.id, parentId);
    parentByRowKey.set(rowIdentity(row), parentRowKey);
    const existing = childrenByParentId.get(parentId);
    if (existing) {
      existing.push(row.session.id);
    } else {
      childrenByParentId.set(parentId, [row.session.id]);
    }
    const existingByRowKey = childrenByParentRowKey.get(parentRowKey);
    if (existingByRowKey) {
      existingByRowKey.push(rowIdentity(row));
    } else {
      childrenByParentRowKey.set(parentRowKey, [rowIdentity(row)]);
    }
  }

  return {
    rowBySessionId,
    rowByRowKey,
    parentBySessionId,
    parentByRowKey,
    childrenByParentId,
    childrenByParentRowKey,
  };
};

export const rootRowsForSessionTree = (rows: FlatSessionRow[]): FlatSessionRow[] => {
  const lookup = buildRowHierarchyLookup(rows);
  return rows.filter((row) => !lookup.parentByRowKey.has(rowIdentity(row)));
};

export const directChildRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const parentIdentity = parentSessionId.trim();
  if (!parentIdentity) return [];
  const parent = resolveRowByIdentity(rows, parentIdentity);
  const parentKey = parent ? rowIdentity(parent) : parentIdentity;
  const lookup = buildRowHierarchyLookup(rows);
  const childKeys = new Set(lookup.childrenByParentRowKey.get(parentKey) ?? []);
  if (childKeys.size > 0) {
    return rows.filter((row) => childKeys.has(rowIdentity(row)));
  }

  const scopedChildren = rows.filter((row) => row.parentRowKey === parentKey);
  if (scopedChildren.length > 0) return scopedChildren;

  return parent ? [] : rows.filter((row) => row.parentSessionId === parentIdentity);
};

export const descendantRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const id = parentSessionId.trim();
  if (!id) return [];

  const parent = resolveRowByIdentity(rows, id);
  if (!parent) return [];
  const parentKey = rowIdentity(parent);
  const parentIndex = rows.findIndex((row) => rowIdentity(row) === parentKey);
  if (parentIndex < 0) return [];

  const parentLevel = rows[parentIndex].nestingLevel;
  const lookup = buildRowHierarchyLookup(rows);
  const descendants: FlatSessionRow[] = [];
  const isDescendantOf = (candidateKey: string, ancestorKey: string) => {
    let parentKey = lookup.parentByRowKey.get(candidateKey) ?? null;
    while (parentKey) {
      if (parentKey === ancestorKey) return true;
      parentKey = lookup.parentByRowKey.get(parentKey) ?? null;
    }
    return false;
  };

  for (let index = parentIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.nestingLevel <= parentLevel) break;
    if (isDescendantOf(rowIdentity(row), parentKey)) descendants.push(row);
  }

  return descendants;
};

export const rowVisibleByExpansion = (
  row: FlatSessionRow,
  lookup: RowHierarchyLookup,
  expandedParentSessionIds: ReadonlySet<string>,
) => {
  let parentKey = lookup.parentByRowKey.get(rowIdentity(row)) ?? null;
  while (parentKey) {
    const parentRow = lookup.rowByRowKey.get(parentKey);
    if (!parentRow) {
      // Parent missing from current data slice (pagination, loading) — keep child visible.
      return true;
    }
    if (!expandedParentSessionIds.has(parentKey) && !expandedParentSessionIds.has(parentRow.session.id)) return false;
    parentKey = lookup.parentByRowKey.get(parentKey) ?? null;
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
  const parent = resolveRowByIdentity(rows, id);
  if (!parent) return null;
  const parentKey = rowIdentity(parent);
  const childCount = lookup.childrenByParentRowKey.get(parentKey)?.length ?? 0;
  if (childCount === 0) return null;

  const visibleRows = rows.filter((row) =>
    rowVisibleByExpansion(row, lookup, expandedParentSessionIds)
  );
  const parentIndex = visibleRows.findIndex((row) => rowIdentity(row) === parentKey);
  if (parentIndex < 0) return null;

  const isDescendantOf = (candidateKey: string, ancestorKey: string) => {
    let parentKey = lookup.parentByRowKey.get(candidateKey) ?? null;
    while (parentKey) {
      if (parentKey === ancestorKey) return true;
      parentKey = lookup.parentByRowKey.get(parentKey) ?? null;
    }
    return false;
  };

  let deepestVisibleDescendantIndex = parentIndex;
  for (let index = parentIndex + 1; index < visibleRows.length; index += 1) {
    if (isDescendantOf(rowIdentity(visibleRows[index]), parentKey)) {
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

  const { rowByKey, rowKeysBySessionId } = buildRowKeyIndexes(rows);
  const parentByRowKey = new Map<string, string>();
  const childrenByParentKey = new Map<string, FlatSessionRow[]>();

  for (const row of rows) {
    const parentKey = resolveParentRowKey(row, rowByKey, rowKeysBySessionId);
    if (!parentKey) continue;
    parentByRowKey.set(rowIdentity(row), parentKey);
    const existing = childrenByParentKey.get(parentKey);
    if (existing) {
      existing.push(row);
    } else {
      childrenByParentKey.set(parentKey, [row]);
    }
  }

  const resolving = new Set<string>();
  const hierarchyCache = new Map<string, { rootSessionId: string; rootRowKey: string; nestingLevel: number }>();
  const resolveHierarchy = (rowKey: string): { rootSessionId: string; rootRowKey: string; nestingLevel: number } => {
    const cached = hierarchyCache.get(rowKey);
    if (cached) return cached;
    if (resolving.has(rowKey)) {
      const row = rowByKey.get(rowKey);
      return { rootSessionId: row?.session.id ?? rowKey, rootRowKey: rowKey, nestingLevel: 0 };
    }

    resolving.add(rowKey);
    const row = rowByKey.get(rowKey);
    const parentKey = row ? parentByRowKey.get(rowKey) : null;
    let next: { rootSessionId: string; rootRowKey: string; nestingLevel: number };
    if (!row || !parentKey || !rowByKey.has(parentKey)) {
      next = { rootSessionId: row?.session.id ?? rowKey, rootRowKey: rowKey, nestingLevel: 0 };
    } else {
      const parent = resolveHierarchy(parentKey);
      next = parent.rootRowKey === rowKey
        ? { rootSessionId: row.session.id, rootRowKey: rowKey, nestingLevel: 0 }
        : { rootSessionId: parent.rootSessionId, rootRowKey: parent.rootRowKey, nestingLevel: parent.nestingLevel + 1 };
    }

    resolving.delete(rowKey);
    hierarchyCache.set(rowKey, next);
    return next;
  };

  const treeActivityByRootKey = new Map<string, number>();
  for (const row of rows) {
    const info = resolveHierarchy(rowIdentity(row));
    const latest = treeActivityByRootKey.get(info.rootRowKey) ?? 0;
    treeActivityByRootKey.set(info.rootRowKey, Math.max(latest, row.activityAt));
  }

  for (const children of childrenByParentKey.values()) {
    children.sort(compareRows);
  }

  const compareRootRows = (a: FlatSessionRow, b: FlatSessionRow) => {
    const aRoot = resolveHierarchy(rowIdentity(a)).rootRowKey;
    const bRoot = resolveHierarchy(rowIdentity(b)).rootRowKey;
    const byTreeActivity =
      (treeActivityByRootKey.get(bRoot) ?? b.activityAt) - (treeActivityByRootKey.get(aRoot) ?? a.activityAt);
    if (byTreeActivity !== 0) return byTreeActivity;
    return compareRows(a, b);
  };

  const emittedRowKeys = new Set<string>();
  const ordered: FlatSessionRow[] = [];
  const applyPrivateRootContext = (row: FlatSessionRow, rootRow: FlatSessionRow): FlatSessionRow => {
    if (!rootRow.isPrivateProject || rowIdentity(rootRow) === rowIdentity(row)) return row;
    return {
      ...row,
      rowKey: rowKeyForSession(rootRow.workspace.id, row.session.id),
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
    const key = rowIdentity(row);
    if (emittedRowKeys.has(key)) return;
    emittedRowKeys.add(key);

    const info = resolveHierarchy(key);
    const rootRow = rowByKey.get(info.rootRowKey) ?? row;
    const contextualRow = applyPrivateRootContext(row, rootRow);
    ordered.push({
      ...contextualRow,
      parentRowKey: parentByRowKey.get(key) ?? null,
      rootSessionId: info.rootSessionId,
      rootRowKey: info.rootRowKey,
      nestingLevel: info.nestingLevel,
      isSubagent: info.nestingLevel > 0,
      treeActivityAt: treeActivityByRootKey.get(info.rootRowKey) ?? row.activityAt,
    });

    const children = childrenByParentKey.get(key) ?? [];
    for (const child of children) {
      appendRow(child);
    }
  };

  rows
    .filter((row) => resolveHierarchy(rowIdentity(row)).nestingLevel === 0)
    .sort(compareRootRows)
    .forEach((row) => appendRow(row));

  rows
    .filter((row) => !emittedRowKeys.has(rowIdentity(row)))
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
  const rowByRowKey = new Map(rows.map((row) => [rowIdentity(row), row] as const));
  const groupedRows = new Map<string, FlatSessionRow[]>();

  for (const row of buildHierarchicalRows(rows, compareProjectRows)) {
    const root = rowByRowKey.get(row.rootRowKey) ?? row;
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
