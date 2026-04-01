import type { WorkspaceInfo } from "../../lib/tauri";
import type { WorkspaceSessionGroup } from "../../types";
import { normalizeDirectoryPath } from "../../utils";

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
};

export const PRIVATE_PROJECT_GROUP_KEY = "project:veslo-private";
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

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const formatSessionRelativeAge = (timestampMs: number, nowMs = Date.now()) => {
  const delta = nowMs - timestampMs;

  if (delta < 0) return "just now";
  if (delta < MINUTE_MS) return `${Math.max(1, Math.round(delta / SECOND_MS))}s ago`;
  if (delta < HOUR_MS) return `${Math.max(1, Math.round(delta / MINUTE_MS))}m ago`;
  if (delta < DAY_MS) return `${Math.max(1, Math.round(delta / HOUR_MS))}h ago`;
  return `${Math.max(1, Math.round(delta / DAY_MS))}d ago`;
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
  workspaceOrderById: Map<string, number>,
) => {
  const aWorkspaceOrder = workspaceOrderById.get(a.workspace.id) ?? Number.MAX_SAFE_INTEGER;
  const bWorkspaceOrder = workspaceOrderById.get(b.workspace.id) ?? Number.MAX_SAFE_INTEGER;
  const byWorkspaceOrder = aWorkspaceOrder - bWorkspaceOrder;
  if (byWorkspaceOrder !== 0) return byWorkspaceOrder;

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

const buildRowParentLookup = (rows: FlatSessionRow[]) => {
  const { rowBySessionId, parentBySessionId, childrenByParentId } = buildRowHierarchyLookup(rows);
  const childCountByParentId = new Map<string, number>();

  for (const [parentId, children] of childrenByParentId.entries()) {
    childCountByParentId.set(parentId, children.length);
  }

  return { rowBySessionId, parentBySessionId, childCountByParentId };
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

export const deriveExpandedParentSessionIds = (
  rows: FlatSessionRow[],
  selectedSessionId: string | null | undefined,
  currentExpandedParentSessionIds: ReadonlySet<string> = new Set<string>(),
): Set<string> => {
  const selectedId = selectedSessionId?.trim() ?? "";
  const next = new Set(currentExpandedParentSessionIds);
  if (!selectedId) return next;

  const { rowBySessionId, parentBySessionId, childCountByParentId } = buildRowParentLookup(rows);
  if (!rowBySessionId.has(selectedId)) return next;

  if ((childCountByParentId.get(selectedId) ?? 0) > 0) {
    next.add(selectedId);
  }

  let parentId = parentBySessionId.get(selectedId) ?? null;
  while (parentId) {
    next.add(parentId);
    parentId = parentBySessionId.get(parentId) ?? null;
  }

  return next;
};

export type SessionRowClickAction = {
  openSession: boolean;
  toggleExpandedParent: boolean;
};

export const resolveSessionRowClickAction = (input: {
  selectedSessionId: string | null | undefined;
  clickedSessionId: string | null | undefined;
  hasChildren: boolean;
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
    toggleExpandedParent: input.hasChildren,
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
  const appendRow = (row: FlatSessionRow) => {
    if (emittedSessionIds.has(row.session.id)) return;
    emittedSessionIds.add(row.session.id);

    const info = resolveHierarchy(row.session.id);
    ordered.push({
      ...row,
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
  const workspaceOrderById = new Map(
    workspaceSessionGroups.map((group, index) => [group.workspace.id, index] as const),
  );
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

  return Array.from(groupedRows.entries())
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
      };
    })
    .sort((a, b) => compareProjectGroups(a, b, workspaceOrderById));
};
