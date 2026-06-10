import { createEffect } from "solid-js";

type WorkspaceSessionSnapshotScope = {
  workspaceId?: string | null;
};

type WorkspaceSessionSnapshotsOptions = {
  activeWorkspaceId: () => string;
  selectedSessionId: () => string | null | undefined;
  resolveSelectedSessionBrowseScope: (sessionId: string) => WorkspaceSessionSnapshotScope | null;
  saveWorkspaceSnapshot: (workspaceId: string) => void;
  loadWorkspaceSnapshot: (workspaceId: string) => boolean | void;
  clearSelectedSession?: () => void;
  debug?: (label: string, payload?: unknown) => void;
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

const snapshotDebugStack = () => {
  try {
    return (new Error().stack ?? "")
      .split("\n")
      .slice(2, 9)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export function resolveWorkspaceSessionSnapshotAction(
  input: WorkspaceSessionSnapshotActionInput,
): WorkspaceSessionSnapshotAction {
  const previousWorkspaceId = normalize(input.previousWorkspaceId);
  const activeWorkspaceId = normalize(input.activeWorkspaceId);
  const selectedScopeWorkspaceId = normalize(input.selectedScopeWorkspaceId);
  const isInitialLoad = !previousWorkspaceId;
  const workspaceChanged = previousWorkspaceId !== activeWorkspaceId;

  let saveWorkspaceId: string | null = null;
  if (previousWorkspaceId && workspaceChanged) {
    const selectedBelongsToOutgoing =
      !selectedScopeWorkspaceId || selectedScopeWorkspaceId === previousWorkspaceId;
    if (selectedBelongsToOutgoing) {
      saveWorkspaceId = previousWorkspaceId;
    }
  }

  let loadWorkspaceId: string | null = null;
  if (activeWorkspaceId && (isInitialLoad || workspaceChanged)) {
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

    if (action.saveWorkspaceId || action.loadWorkspaceId) {
      options.debug?.("snapshot:action", {
        previousWorkspaceId,
        activeWorkspaceId,
        selectedId,
        selectedScopeWorkspaceId: selectedScope?.workspaceId ?? null,
        saveWorkspaceId: action.saveWorkspaceId,
        loadWorkspaceId: action.loadWorkspaceId,
        stack: snapshotDebugStack(),
      });
    }

    if (action.saveWorkspaceId) {
      options.debug?.("snapshot:save", {
        workspaceId: action.saveWorkspaceId,
        selectedId,
      });
      options.saveWorkspaceSnapshot(action.saveWorkspaceId);
    }
    if (action.loadWorkspaceId) {
      const loaded = options.loadWorkspaceSnapshot(action.loadWorkspaceId);
      options.debug?.("snapshot:load", {
        workspaceId: action.loadWorkspaceId,
        loaded: loaded !== false,
        selectedId,
      });
      if (loaded === false && selectedId) {
        options.debug?.("snapshot:clear-stale-selected-session", {
          workspaceId: action.loadWorkspaceId,
          selectedId,
        });
        options.clearSelectedSession?.();
      }
    }
    previousWorkspaceId = action.nextPreviousWorkspaceId;
  });
}
