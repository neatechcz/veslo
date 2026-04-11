import type { LoadedSidebarPrefetchInterest } from "../../types.js";

type LoadedSidebarPrefetchRow = {
  workspaceId: string;
  sessionId: string;
  updatedAt: number;
};

type WorkspaceInterest = LoadedSidebarPrefetchInterest;

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

const createInterest = (): WorkspaceInterest => ({
  clickedSessionId: null,
  selectedSessionId: null,
  loadedTopLevelSessionIds: [],
  expandedSubagentSessionIds: [],
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

const findWorkspaceForSession = (
  sessionId: string,
  rows: LoadedSidebarPrefetchRow[],
) => {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) return null;
  for (const row of rows) {
    if (normalizeId(row.sessionId) !== normalizedSessionId) continue;
    const workspaceId = normalizeId(row.workspaceId);
    if (workspaceId) return workspaceId;
  }
  return null;
};

export function deriveLoadedSidebarPrefetchInterest(input: {
  selectedSessionId: string | null;
  clickedSessionId: string | null;
  loadedTopLevelRows: LoadedSidebarPrefetchRow[];
  expandedSubagentRows: LoadedSidebarPrefetchRow[];
}) {
  const interests = new Map<string, WorkspaceInterest>();
  const loadedRows: LoadedSidebarPrefetchRow[] = [];

  for (const row of input.loadedTopLevelRows) {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) continue;
    loadedRows.push({ workspaceId, sessionId, updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0 });
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (!interest) continue;
    interest.loadedTopLevelSessionIds.push(sessionId);
  }

  const expandedByWorkspace = new Map<string, Array<LoadedSidebarPrefetchRow & { index: number }>>();
  input.expandedSubagentRows.forEach((row, index) => {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) return;
    loadedRows.push({ workspaceId, sessionId, updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0 });
    const bucket = expandedByWorkspace.get(workspaceId) ?? [];
    bucket.push({ workspaceId, sessionId, updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0, index });
    expandedByWorkspace.set(workspaceId, bucket);
    ensureWorkspaceInterest(interests, workspaceId);
  });

  const clickedWorkspaceId = input.clickedSessionId ? findWorkspaceForSession(input.clickedSessionId, loadedRows) : null;
  if (clickedWorkspaceId) {
    const interest = ensureWorkspaceInterest(interests, clickedWorkspaceId);
    if (interest) interest.clickedSessionId = normalizeId(input.clickedSessionId);
  }

  const selectedWorkspaceId = input.selectedSessionId ? findWorkspaceForSession(input.selectedSessionId, loadedRows) : null;
  if (selectedWorkspaceId) {
    const interest = ensureWorkspaceInterest(interests, selectedWorkspaceId);
    if (interest) interest.selectedSessionId = normalizeId(input.selectedSessionId);
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
        if (seen.has(row.sessionId)) return;
        seen.add(row.sessionId);
        interest.expandedSubagentSessionIds.push(row.sessionId);
      });
  }

  return interests;
}
