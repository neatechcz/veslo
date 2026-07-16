import { createEffect, createSignal } from "solid-js";

import type { WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceConnectionState } from "../types";

export function createWorkspaceConnectionState(
  getWorkspaces: () => WorkspaceInfo[],
) {
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] =
    createSignal<Record<string, WorkspaceConnectionState>>({});

  const updateWorkspaceConnectionState = (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      const current = prev[id] ?? { status: "idle", message: null, checkedAt: null };
      return {
        ...prev,
        [id]: {
          ...current,
          ...next,
          checkedAt: Date.now(),
        },
      };
    });
  };

  const clearWorkspaceConnectionState = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      if (!Object.hasOwn(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  createEffect(() => {
    const ids = new Set(getWorkspaces().map((workspace) => workspace.id));
    setWorkspaceConnectionStateById((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (!ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = state;
      }
      return changed ? next : prev;
    });
  });

  return {
    workspaceConnectionStateById,
    setWorkspaceConnectionStateById,
    updateWorkspaceConnectionState,
    clearWorkspaceConnectionState,
  };
}
