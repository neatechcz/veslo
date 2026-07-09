import { normalizeDirectoryPath } from "../utils";
import type { SessionArchiveItem as AppSessionArchiveItem, SidebarSessionItem, WorkspaceSessionGroup } from "../types";
import type { WorkspaceInfo } from "./tauri";
import type { VesloSessionArchiveRecord } from "./veslo-server";

export type SessionArchiveItem = AppSessionArchiveItem;

export const LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY = "veslo.sidebar-archived-session-ids.v1";
const ARCHIVED_SIDEBAR_SESSION_KEY_SEPARATOR = "\0";

const normalizeUrl = (value?: string | null) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};

const workspaceLabel = (workspace?: WorkspaceInfo | null) =>
  workspace?.displayName?.trim() ||
  workspace?.vesloWorkspaceName?.trim() ||
  workspace?.name?.trim() ||
  normalizeDirectoryPath(workspace?.directory ?? workspace?.path ?? "") ||
  workspace?.path?.trim() ||
  "Unknown workspace";

const pathLabel = (value?: string | null) => {
  const normalized = normalizeDirectoryPath(value ?? "");
  if (!normalized) return null;
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
};

export function buildWorkspaceIdentity(workspace?: WorkspaceInfo | null): string {
  if (!workspace) return "";

  if (workspace.workspaceType === "remote") {
    const host = normalizeUrl(workspace.vesloHostUrl ?? workspace.baseUrl ?? "");
    const workspaceId = workspace.vesloWorkspaceId?.trim() ?? "";
    const directory = normalizeDirectoryPath(workspace.directory ?? workspace.path ?? "");
    if (host && workspaceId) {
      return `remote:${host}::id:${workspaceId}`;
    }
    if (host && directory) {
      return `remote:${host}::dir:${directory}`;
    }
  }

  const root = normalizeDirectoryPath(workspace.path ?? workspace.directory ?? "");
  return root ? `local:${root}` : "";
}

export function buildArchivedSidebarSessionKey(input: {
  workspaceId?: string | null;
  workspaceIdentity?: string | null;
  sessionId?: string | null;
  directory?: string | null;
}) {
  const workspaceScope = input.workspaceId?.trim() || input.workspaceIdentity?.trim() || "";
  const sessionId = input.sessionId?.trim() ?? "";
  const directory = normalizeDirectoryPath(input.directory ?? "");
  if (!workspaceScope || !sessionId) return sessionId;
  return [workspaceScope, sessionId, directory].filter(Boolean).join(ARCHIVED_SIDEBAR_SESSION_KEY_SEPARATOR);
}

export function archivedSidebarSessionKeyFromRecord(
  record: Pick<
    VesloSessionArchiveRecord,
    "sessionId" | "workspaceIdAtArchive" | "workspaceIdentity" | "resolvedDirectoryAtArchive" | "projectRootAtArchive"
  >,
) {
  return buildArchivedSidebarSessionKey({
    workspaceId: record.workspaceIdAtArchive,
    workspaceIdentity: record.workspaceIdentity,
    sessionId: record.sessionId,
    directory: record.resolvedDirectoryAtArchive ?? record.projectRootAtArchive,
  });
}

export function buildSessionArchiveSnapshot(input: {
  session: SidebarSessionItem;
  workspace?: WorkspaceInfo | null;
  archivedAt?: number;
}): Omit<VesloSessionArchiveRecord, "sessionId"> {
  const resolvedDirectory = normalizeDirectoryPath(input.session.directory ?? input.workspace?.directory ?? "");
  const projectRoot = resolvedDirectory || normalizeDirectoryPath(input.workspace?.directory ?? input.workspace?.path ?? "");

  return {
    archivedAt: input.archivedAt ?? Date.now(),
    titleSnapshot: input.session.title?.trim() ?? "",
    workspaceIdAtArchive: input.workspace?.id ?? undefined,
    workspaceLabelSnapshot: workspaceLabel(input.workspace),
    resolvedDirectoryAtArchive: resolvedDirectory || undefined,
    projectRootAtArchive: projectRoot || undefined,
    projectLabelSnapshot: pathLabel(projectRoot) ?? undefined,
    parentSessionId: input.session.parentID?.trim() || null,
    createdAtSnapshot: input.session.time?.created ?? null,
    updatedAtSnapshot: input.session.time?.updated ?? null,
    workspaceIdentity: buildWorkspaceIdentity(input.workspace) || undefined,
  };
}

export function sortArchivedSessionsByRecency<T extends { archivedAt: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.archivedAt - left.archivedAt);
}

export function buildArchivedSessionDisplayLabel(
  item: Pick<AppSessionArchiveItem, "sessionId" | "workspaceLabel" | "projectLabel" | "resolvedDirectory">,
): string {
  const parts = [
    item.workspaceLabel?.trim(),
    item.projectLabel?.trim(),
    item.resolvedDirectory?.trim(),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : item.sessionId;
}

function matchArchiveAvailability(
  record: VesloSessionArchiveRecord,
  workspaces: WorkspaceInfo[],
): { availableOnThisDevice: boolean; workspace: WorkspaceInfo | null } {
  const workspaceIdentity = record.workspaceIdentity?.trim() ?? "";
  const workspaceIdAtArchive = record.workspaceIdAtArchive?.trim() ?? "";
  const recordProjectRoot = normalizeDirectoryPath(record.projectRootAtArchive ?? "");
  const recordResolvedDirectory = normalizeDirectoryPath(record.resolvedDirectoryAtArchive ?? "");

  if (workspaceIdentity) {
    const match = workspaces.find((workspace) => buildWorkspaceIdentity(workspace) === workspaceIdentity) ?? null;
    if (match) {
      return { availableOnThisDevice: true, workspace: match };
    }
  }

  if (workspaceIdAtArchive) {
    const match = workspaces.find((workspace) => workspace.id === workspaceIdAtArchive) ?? null;
    if (match) {
      return { availableOnThisDevice: true, workspace: match };
    }
  }

  const recordRoots = [recordProjectRoot, recordResolvedDirectory].filter(Boolean);
  for (const workspace of workspaces) {
    const workspaceRoot = normalizeDirectoryPath(workspace.directory ?? workspace.path ?? "");
    if (!workspaceRoot) continue;
    if (recordRoots.includes(workspaceRoot)) {
      return { availableOnThisDevice: true, workspace };
    }
  }

  return { availableOnThisDevice: false, workspace: null };
}

export function toSessionArchiveItem(
  record: VesloSessionArchiveRecord,
  workspaces: WorkspaceInfo[],
): AppSessionArchiveItem {
  const availability = matchArchiveAvailability(record, workspaces);
  const resolvedDirectory = normalizeDirectoryPath(record.resolvedDirectoryAtArchive ?? "");
  const projectRoot = normalizeDirectoryPath(record.projectRootAtArchive ?? "");

  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceIdAtArchive?.trim() || availability.workspace?.id?.trim() || "",
    workspaceIdentity: record.workspaceIdentity?.trim() || null,
    title: record.titleSnapshot?.trim() || record.sessionId,
    workspaceLabel: record.workspaceLabelSnapshot?.trim() || workspaceLabel(availability.workspace),
    projectLabel:
      record.projectLabelSnapshot?.trim() ||
      pathLabel(projectRoot) ||
      pathLabel(resolvedDirectory) ||
      null,
    resolvedDirectory: resolvedDirectory || projectRoot || null,
    archivedAt: Number.isFinite(record.archivedAt) ? record.archivedAt : 0,
    availableOnThisDevice: availability.availableOnThisDevice,
  };
}

export function buildLegacyArchiveMigration(
  legacySessionIds: string[],
  workspaceSessionGroups: WorkspaceSessionGroup[],
): VesloSessionArchiveRecord[] {
  const sessionSourceById = new Map<string, { session: SidebarSessionItem; workspace: WorkspaceInfo }>();
  for (const group of workspaceSessionGroups) {
    for (const session of group.sessions) {
      if (!sessionSourceById.has(session.id)) {
        sessionSourceById.set(session.id, { session, workspace: group.workspace });
      }
    }
  }

  const normalizedIds = legacySessionIds.map((sessionId) => sessionId.trim()).filter(Boolean);
  const baseArchivedAt = Date.now() - normalizedIds.length;

  return normalizedIds.flatMap((sessionId, index) => {
    const source = sessionSourceById.get(sessionId);
    if (!source) return [];
    return [
      {
        sessionId,
        ...buildSessionArchiveSnapshot({
          session: source.session,
          workspace: source.workspace,
          archivedAt: baseArchivedAt + index,
        }),
      },
    ];
  });
}
