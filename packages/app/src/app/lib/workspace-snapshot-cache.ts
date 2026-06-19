export type WorkspaceSnapshotCacheMeta = {
  workspaceId: string;
  lastUsed: number;
};

export const DEFAULT_WORKSPACE_SNAPSHOT_CACHE_LIMIT = 6;

/**
 * The per-workspace session snapshot cache (sessions + transcripts + parts)
 * lives in memory and used to grow without bound: every visited workspace kept
 * a full copy of its transcripts. This picks which workspace snapshots to evict
 * so the cache holds at most `max` entries, keeping the most recently used ones.
 * `keepIds` are never evicted, so a workspace switch never drops the snapshot it
 * is in the middle of saving or restoring.
 */
export const selectWorkspaceSnapshotEvictions = (
  entries: WorkspaceSnapshotCacheMeta[],
  max: number,
  keepIds: Array<string | null | undefined> = [],
): string[] => {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const keep = new Set(
    keepIds.map((id) => id?.trim() ?? "").filter((id) => id.length > 0),
  );
  const entryIds = new Set(entries.map((entry) => entry.workspaceId));

  if (limit <= 0) {
    return entries
      .map((entry) => entry.workspaceId)
      .filter((id) => id && !keep.has(id));
  }

  if (entries.length <= limit) return [];

  const ordered = entries
    .slice()
    .sort((a, b) => {
      if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
      return a.workspaceId.localeCompare(b.workspaceId);
    });

  const retained = new Set<string>();
  for (const id of keep) {
    if (entryIds.has(id)) retained.add(id);
  }
  for (const entry of ordered) {
    if (retained.size >= limit) break;
    retained.add(entry.workspaceId);
  }

  return entries
    .map((entry) => entry.workspaceId)
    .filter((id) => !retained.has(id));
};
