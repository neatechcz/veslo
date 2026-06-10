import { createEffect } from "solid-js";

type WorkspaceSessionSnapshotScope = {
  workspaceId?: string | null;
};

type WorkspaceSessionSnapshotsOptions = {
  activeWorkspaceId: () => string;
  selectedSessionId: () => string | null | undefined;
  resolveSelectedSessionBrowseScope: (sessionId: string) => WorkspaceSessionSnapshotScope | null;
  saveWorkspaceSnapshot: (workspaceId: string) => void;
  loadWorkspaceSnapshot: (workspaceId: string) => void;
};

type WorkspaceSessionSnapshotActionInput = {
  previousWorkspaceId: string | null | undefined;
  activeWorkspaceId: string | null | undefined;
  selectedScopeWorkspaceId: string | null | undefined;
};

type WorkspaceSessionSnapshotAction = {
  saveWorkspaceId: string | null;
  loadWorkspaceId: string | null;
  nextPreviousWorkspaceId: string | null;
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

export function resolveWorkspaceSessionSnapshotAction(
  input: WorkspaceSessionSnapshotActionInput,
): WorkspaceSessionSnapshotAction {
  const previousWorkspaceId = normalize(input.previousWorkspaceId);
  const activeWorkspaceId = normalize(input.activeWorkspaceId);
  const selectedScopeWorkspaceId = normalize(input.selectedScopeWorkspaceId);

  let saveWorkspaceId: string | null = null;
  if (previousWorkspaceId && previousWorkspaceId !== activeWorkspaceId) {
    const selectedBelongsToOutgoing =
      !selectedScopeWorkspaceId || selectedScopeWorkspaceId === previousWorkspaceId;
    if (selectedBelongsToOutgoing) {
      saveWorkspaceId = previousWorkspaceId;
    }
  }

  let loadWorkspaceId: string | null = null;
  if (activeWorkspaceId) {
    const selectedBelongsToIncoming = selectedScopeWorkspaceId === activeWorkspaceId;
    if (!selectedBelongsToIncoming) {
      loadWorkspaceId = activeWorkspaceId;
    }
  }

  return {
    saveWorkspaceId,
    loadWorkspaceId,
    nextPreviousWorkspaceId: activeWorkspaceId || null,
  };
}

export function createWorkspaceSessionSnapshots(options: WorkspaceSessionSnapshotsOptions) {
  let previousWorkspaceId: string | null = null;

  createEffect(() => {
    const activeWorkspaceId = options.activeWorkspaceId().trim();
    const selectedId = options.selectedSessionId()?.trim() ?? "";
    const selectedScope = selectedId ? options.resolveSelectedSessionBrowseScope(selectedId) : null;
    const action = resolveWorkspaceSessionSnapshotAction({
      previousWorkspaceId,
      activeWorkspaceId,
      selectedScopeWorkspaceId: selectedScope?.workspaceId ?? null,
    });

    if (action.saveWorkspaceId) {
      options.saveWorkspaceSnapshot(action.saveWorkspaceId);
    }
    if (action.loadWorkspaceId) {
      options.loadWorkspaceSnapshot(action.loadWorkspaceId);
    }
    previousWorkspaceId = action.nextPreviousWorkspaceId;
  });
}
