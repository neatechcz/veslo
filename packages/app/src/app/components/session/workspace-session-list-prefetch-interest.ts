export type { LoadedSidebarPrefetchInterest } from "../../types.js";
import type {
  LoadedSidebarPrefetchInterest as LoadedSidebarPrefetchInterestType,
  LoadedSidebarPrefetchSessionRef,
} from "../../types.js";

type LoadedSidebarPrefetchRow = {
  rowKey?: string | null;
  workspaceId: string;
  sessionId: string;
  directory?: string | null;
  updatedAt: number;
};

type WorkspaceInterest = LoadedSidebarPrefetchInterestType;

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

const createInterest = (): WorkspaceInterest => ({
  clickedSessionId: null,
  selectedSessionId: null,
  loadedTopLevelSessionIds: [],
  expandedSubagentSessionIds: [],
  sessionDirectoriesById: {},
  clickedSession: null,
  selectedSession: null,
  loadedTopLevelSessions: [],
  expandedSubagentSessions: [],
});

const ensureWorkspaceInterest = (
  interests: Map<string, WorkspaceInterest>,
  workspaceId: string,
) => {
  const normalizedWorkspaceId = normalizeId(workspaceId);
  if (!normalizedWorkspaceId) return null;
  let interest = interests.get(normalizedWorkspaceId);
  if (!interest) {
    interest = createInterest();
    interests.set(normalizedWorkspaceId, interest);
  }
  return interest;
};

const recordSessionDirectory = (
  interest: WorkspaceInterest,
  sessionId: string,
  directory: string | null | undefined,
) => {
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedDirectory = normalizeId(directory);
  if (!normalizedSessionId || !normalizedDirectory) return;
  if (interest.sessionDirectoriesById[normalizedSessionId]) return;
  interest.sessionDirectoriesById[normalizedSessionId] = normalizedDirectory;
};

const sessionRefForRow = (row: Pick<LoadedSidebarPrefetchRow, "sessionId" | "directory">): LoadedSidebarPrefetchSessionRef | null => {
  const sessionId = normalizeId(row.sessionId);
  if (!sessionId) return null;
  const directory = normalizeId(row.directory);
  return directory ? { sessionId, directory } : { sessionId };
};

const sessionRefKey = (ref: LoadedSidebarPrefetchSessionRef) =>
  `${normalizeId(ref.sessionId)}\0${normalizeId(ref.directory)}`;

const pushSessionRef = (
  refs: LoadedSidebarPrefetchSessionRef[],
  seenRefs: Set<string>,
  row: Pick<LoadedSidebarPrefetchRow, "sessionId" | "directory">,
) => {
  const ref = sessionRefForRow(row);
  if (!ref) return;
  const key = sessionRefKey(ref);
  if (seenRefs.has(key)) return;
  seenRefs.add(key);
  refs.push(ref);
};

const buildRowLookup = (rows: LoadedSidebarPrefetchRow[]) => {
  const byRowKey = new Map<string, LoadedSidebarPrefetchRow>();
  const bySessionId = new Map<string, LoadedSidebarPrefetchRow[]>();

  for (const row of rows) {
    const rowKey = normalizeId(row.rowKey);
    const sessionId = normalizeId(row.sessionId);
    if (rowKey) byRowKey.set(rowKey, row);
    if (!sessionId) continue;
    const existing = bySessionId.get(sessionId) ?? [];
    existing.push(row);
    bySessionId.set(sessionId, existing);
  }

  return { byRowKey, bySessionId };
};

const resolveUniqueScopedRow = (rows: LoadedSidebarPrefetchRow[]) => {
  if (rows.length === 0) return null;
  const first = rows[0];
  const workspaceId = normalizeId(first.workspaceId);
  const directory = normalizeId(first.directory);
  if (!workspaceId) return null;
  const sameScope = rows.every((row) =>
    normalizeId(row.workspaceId) === workspaceId &&
    normalizeId(row.directory) === directory
  );
  return sameScope ? first : null;
};

const resolveInterestRow = (
  rowLookup: ReturnType<typeof buildRowLookup>,
  rowKey: string | null | undefined,
  sessionId: string | null | undefined,
) => {
  const normalizedRowKey = normalizeId(rowKey);
  const normalizedSessionId = normalizeId(sessionId);
  if (normalizedRowKey) {
    const row = rowLookup.byRowKey.get(normalizedRowKey);
    if (row && (!normalizedSessionId || normalizeId(row.sessionId) === normalizedSessionId)) return row;
  }

  if (!normalizedSessionId) return null;
  const rows = rowLookup.bySessionId.get(normalizedSessionId) ?? [];
  return resolveUniqueScopedRow(rows);
};

export function deriveLoadedSidebarPrefetchInterest(input: {
  selectedSessionId: string | null;
  selectedRowKey?: string | null;
  clickedSessionId: string | null;
  clickedRowKey?: string | null;
  loadedTopLevelRows: LoadedSidebarPrefetchRow[];
  expandedSubagentRows: LoadedSidebarPrefetchRow[];
}) {
  const interests = new Map<string, WorkspaceInterest>();
  const seenTopLevelSessionIdsByWorkspace = new Map<string, Set<string>>();
  const seenTopLevelSessionRefsByWorkspace = new Map<string, Set<string>>();
  const allRows = [...input.loadedTopLevelRows, ...input.expandedSubagentRows];
  const rowLookup = buildRowLookup(allRows);

  for (const row of input.loadedTopLevelRows) {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) continue;
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (!interest) continue;
    recordSessionDirectory(interest, sessionId, row.directory);
    const seenTopLevelSessionIds = seenTopLevelSessionIdsByWorkspace.get(workspaceId) ?? new Set<string>();
    if (!seenTopLevelSessionIds.has(sessionId)) {
      seenTopLevelSessionIds.add(sessionId);
      seenTopLevelSessionIdsByWorkspace.set(workspaceId, seenTopLevelSessionIds);
      interest.loadedTopLevelSessionIds.push(sessionId);
    }
    const seenTopLevelSessionRefs = seenTopLevelSessionRefsByWorkspace.get(workspaceId) ?? new Set<string>();
    seenTopLevelSessionRefsByWorkspace.set(workspaceId, seenTopLevelSessionRefs);
    pushSessionRef(interest.loadedTopLevelSessions ?? [], seenTopLevelSessionRefs, row);
  }

  const expandedByWorkspace = new Map<string, Array<LoadedSidebarPrefetchRow & { index: number }>>();
  input.expandedSubagentRows.forEach((row, index) => {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) return;
    const bucket = expandedByWorkspace.get(workspaceId) ?? [];
    bucket.push({
      ...row,
      workspaceId,
      sessionId,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      index,
    });
    expandedByWorkspace.set(workspaceId, bucket);
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (interest) recordSessionDirectory(interest, sessionId, row.directory);
  });

  const clickedRow = resolveInterestRow(rowLookup, input.clickedRowKey, input.clickedSessionId);
  if (clickedRow) {
    const clickedWorkspaceId = normalizeId(clickedRow.workspaceId);
    const interest = ensureWorkspaceInterest(interests, clickedWorkspaceId);
    if (interest) {
      const sessionId = normalizeId(clickedRow.sessionId);
      interest.clickedSessionId = sessionId;
      interest.clickedSession = sessionRefForRow(clickedRow);
    }
  }

  const selectedRow = resolveInterestRow(rowLookup, input.selectedRowKey, input.selectedSessionId);
  if (selectedRow) {
    const selectedWorkspaceId = normalizeId(selectedRow.workspaceId);
    const interest = ensureWorkspaceInterest(interests, selectedWorkspaceId);
    if (interest) {
      const sessionId = normalizeId(selectedRow.sessionId);
      interest.selectedSessionId = sessionId;
      interest.selectedSession = sessionRefForRow(selectedRow);
    }
  }

  for (const [workspaceId, rows] of expandedByWorkspace.entries()) {
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (!interest) continue;
    const seen = new Set<string>();
    rows
      .slice()
      .sort((a, b) => {
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        return a.index - b.index;
      })
      .forEach((row) => {
        if (!seen.has(row.sessionId)) {
          seen.add(row.sessionId);
          interest.expandedSubagentSessionIds.push(row.sessionId);
        }
        pushSessionRef(interest.expandedSubagentSessions ?? [], seen, row);
      });
  }

  return interests;
}

export type SidebarPrefetchReservation = {
  workspaceId?: string | null;
  uiSessionId: string;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

type SidebarPrefetchInterestInput = Omit<
  LoadedSidebarPrefetchInterestType,
  | "clickedSessionId"
  | "selectedSessionId"
  | "sessionDirectoriesById"
  | "clickedSession"
  | "selectedSession"
> & {
  clickedSessionId?: string | null;
  selectedSessionId?: string | null;
  sessionDirectoriesById?: Record<string, string | null | undefined>;
  clickedSession?: LoadedSidebarPrefetchSessionRef | null;
  selectedSession?: LoadedSidebarPrefetchSessionRef | null;
};

/**
 * Sidebar prefetch is a background-only reader. The selected/clicked target
 * and any aliases reserved by direct selection or terminal recovery are left
 * to their owning read path.
 */
export function deriveBackgroundSidebarPrefetchInterest(
  input: SidebarPrefetchInterestInput,
  reservation?: SidebarPrefetchReservation | null,
  workspaceId?: string | null,
): LoadedSidebarPrefetchInterestType {
  const reservationApplies =
    Boolean(reservation) &&
    (!normalizeId(reservation?.workspaceId) || normalizeId(reservation?.workspaceId) === normalizeId(workspaceId));
  const excluded = new Set(
    [
      input.clickedSessionId,
      input.selectedSessionId,
      input.clickedSession?.sessionId,
      input.selectedSession?.sessionId,
      ...(reservationApplies
        ? [reservation?.uiSessionId, reservation?.conversationId, reservation?.opencodeSessionId]
        : []),
    ]
      .map(normalizeId)
      .filter(Boolean),
  );
  const keepId = (sessionId: string | null | undefined) => !excluded.has(normalizeId(sessionId));
  const keepRef = (ref: LoadedSidebarPrefetchSessionRef) => keepId(ref.sessionId);
  const loadedTopLevelSessions = (input.loadedTopLevelSessions ?? []).filter(keepRef);
  const expandedSubagentSessions = (input.expandedSubagentSessions ?? []).filter(keepRef);
  const loadedTopLevelSessionIds = input.loadedTopLevelSessionIds.filter(keepId);
  const expandedSubagentSessionIds = input.expandedSubagentSessionIds.filter(keepId);
  const retainedIds = new Set([
    ...loadedTopLevelSessionIds,
    ...expandedSubagentSessionIds,
    ...loadedTopLevelSessions.map((item) => item.sessionId),
    ...expandedSubagentSessions.map((item) => item.sessionId),
  ].map(normalizeId).filter(Boolean));
  const sessionDirectoriesById = Object.fromEntries(
    Object.entries(input.sessionDirectoriesById ?? {})
      .flatMap(([sessionId, directory]) =>
        retainedIds.has(normalizeId(sessionId)) && typeof directory === "string"
          ? [[sessionId, directory.trim()] as const]
          : [],
      ),
  );

  return {
    ...input,
    clickedSessionId: null,
    selectedSessionId: null,
    clickedSession: null,
    selectedSession: null,
    loadedTopLevelSessionIds,
    expandedSubagentSessionIds,
    loadedTopLevelSessions,
    expandedSubagentSessions,
    sessionDirectoriesById,
  };
}
