type SidebarSessionSyncGuardInput = {
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  targetWorkspaceId: string;
  allSessionCount: number;
  scopedSessionCount: number;
  existingTargetSessionCount?: number;
};

/**
 * During workspace switches, the global session store can still contain the
 * previous workspace while the sidebar target is already the connecting one.
 * In that window, syncing sidebar rows would temporarily wipe/reorder the
 * target workspace list. Guard against that stale overwrite.
 */
export const shouldSyncSidebarFromSessionStore = (
  input: SidebarSessionSyncGuardInput,
) => {
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  const connectingWorkspaceId = input.connectingWorkspaceId?.trim() ?? "";
  const targetWorkspaceId = input.targetWorkspaceId.trim();
  const allSessionCount = Number.isFinite(input.allSessionCount)
    ? Math.max(0, Math.floor(input.allSessionCount))
    : 0;
  const scopedSessionCount = Number.isFinite(input.scopedSessionCount)
    ? Math.max(0, Math.floor(input.scopedSessionCount))
    : 0;
  const existingTargetSessionCount = Number.isFinite(input.existingTargetSessionCount)
    ? Math.max(0, Math.floor(input.existingTargetSessionCount ?? 0))
    : 0;

  if (!targetWorkspaceId) return false;

  const switchingWorkspace =
    connectingWorkspaceId.length > 0 &&
    connectingWorkspaceId !== activeWorkspaceId;

  if (!switchingWorkspace) return true;

  // While switching, only the connecting workspace should be eligible.
  if (targetWorkspaceId !== connectingWorkspaceId) return false;

  // Safe once we have scoped rows for the target workspace.
  if (scopedSessionCount > 0) return true;

  // Also safe when the freshly loaded store is legitimately empty, unless the
  // target already has rows that would be wiped by a startup-empty store.
  if (allSessionCount === 0) return existingTargetSessionCount === 0;

  // Otherwise this is likely old workspace data; keep existing sidebar rows.
  return false;
};

/**
 * A read-API list result (browse mode / engine-unavailable fallback) must never
 * destroy rows the user can still open. Preserve existing rows when the read was
 * unavailable (server/sandbox unreachable, workspace not registered, sandbox
 * path mismatch), or when it came back empty while the workspace still has rows.
 * Only a genuine non-empty read — or an empty read for a workspace that has no
 * rows yet — may replace the list. This is what prevents the "conversation
 * disappears on workspace switch and I can't get back" symptom.
 */
export const shouldPreserveSidebarRowsOnRead = (input: {
  available: boolean;
  incomingCount: number;
  existingCount: number;
}): boolean => {
  if (input.incomingCount > 0) return false;
  if (!input.available) return true;
  return input.existingCount > 0;
};
