export type { LoadedSidebarPrefetchInterest } from "../../types.js";
import type { LoadedSidebarPrefetchInterest as LoadedSidebarPrefetchInterestType } from "../../types.js";

type LoadedSidebarPrefetchRow = {
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

const recordSessionWorkspace = (
  sessionWorkspaces: Map<string, Set<string>>,
  sessionId: string,
  workspaceId: string,
) => {
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedWorkspaceId = normalizeId(workspaceId);
  if (!normalizedSessionId || !normalizedWorkspaceId) return;
  const workspaces = sessionWorkspaces.get(normalizedSessionId) ?? new Set<string>();
  workspaces.add(normalizedWorkspaceId);
  sessionWorkspaces.set(normalizedSessionId, workspaces);
};

const recordSessionDirectory = (
  interest: WorkspaceInterest,
  sessionId: string,
  directory: string | null | undefined,
) => {
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedDirectory = normalizeId(directory);
  if (!normalizedSessionId || !normalizedDirectory) return;
  interest.sessionDirectoriesById[normalizedSessionId] = normalizedDirectory;
};

const findUniqueWorkspaceForSession = (
  sessionId: string,
  sessionWorkspaces: Map<string, Set<string>>,
) => {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) return null;
  const workspaces = sessionWorkspaces.get(normalizedSessionId);
  if (!workspaces || workspaces.size !== 1) return null;
  return workspaces.values().next().value ?? null;
};

export function deriveLoadedSidebarPrefetchInterest(input: {
  selectedSessionId: string | null;
  clickedSessionId: string | null;
  loadedTopLevelRows: LoadedSidebarPrefetchRow[];
  expandedSubagentRows: LoadedSidebarPrefetchRow[];
}) {
  const interests = new Map<string, WorkspaceInterest>();
  const sessionWorkspaces = new Map<string, Set<string>>();
  const seenTopLevelSessionIdsByWorkspace = new Map<string, Set<string>>();

  for (const row of input.loadedTopLevelRows) {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) continue;
    recordSessionWorkspace(sessionWorkspaces, sessionId, workspaceId);
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (!interest) continue;
    recordSessionDirectory(interest, sessionId, row.directory);
    const seenTopLevelSessionIds = seenTopLevelSessionIdsByWorkspace.get(workspaceId) ?? new Set<string>();
    if (!seenTopLevelSessionIds.has(sessionId)) {
      seenTopLevelSessionIds.add(sessionId);
      seenTopLevelSessionIdsByWorkspace.set(workspaceId, seenTopLevelSessionIds);
      interest.loadedTopLevelSessionIds.push(sessionId);
    }
  }

  const expandedByWorkspace = new Map<string, Array<LoadedSidebarPrefetchRow & { index: number }>>();
  input.expandedSubagentRows.forEach((row, index) => {
    const workspaceId = normalizeId(row.workspaceId);
    const sessionId = normalizeId(row.sessionId);
    if (!workspaceId || !sessionId) return;
    recordSessionWorkspace(sessionWorkspaces, sessionId, workspaceId);
    const bucket = expandedByWorkspace.get(workspaceId) ?? [];
    bucket.push({ workspaceId, sessionId, updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0, index });
    expandedByWorkspace.set(workspaceId, bucket);
    const interest = ensureWorkspaceInterest(interests, workspaceId);
    if (interest) recordSessionDirectory(interest, sessionId, row.directory);
  });

  const clickedWorkspaceId = input.clickedSessionId
    ? findUniqueWorkspaceForSession(input.clickedSessionId, sessionWorkspaces)
    : null;
  if (clickedWorkspaceId) {
    const interest = ensureWorkspaceInterest(interests, clickedWorkspaceId);
    if (interest) interest.clickedSessionId = normalizeId(input.clickedSessionId);
  }

  const selectedWorkspaceId = input.selectedSessionId
    ? findUniqueWorkspaceForSession(input.selectedSessionId, sessionWorkspaces)
    : null;
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
