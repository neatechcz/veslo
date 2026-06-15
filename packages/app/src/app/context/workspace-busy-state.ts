import { createSignal } from "solid-js";

import type { WorkspaceBusyMap } from "./workspace-debug";

type WorkspaceBusyTrace = (event: string, payload?: Record<string, unknown>) => void;

export function createWorkspaceBusyState(recordTrace?: WorkspaceBusyTrace) {
  const [workspaceBusy, setWorkspaceBusy] = createSignal<WorkspaceBusyMap>({});

  function markWorkspaceBusy(workspaceId: string, sessionId: string) {
    const id = workspaceId.trim();
    if (!id || !sessionId) return;
    setWorkspaceBusy((prev) => {
      const existing = prev[id];
      if (existing?.sessionId === sessionId) {
        recordTrace?.("mark-existing", {
          workspaceId: id,
          sessionId,
          previous: prev,
        });
        return prev;
      }
      const next = {
        ...prev,
        [id]: { sessionId, startedAt: Date.now() },
      };
      recordTrace?.("mark", {
        workspaceId: id,
        sessionId,
        previous: prev,
        next,
      });
      return next;
    });
  }

  function clearWorkspaceBusy(workspaceId: string, sessionId?: string) {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceBusy((prev) => {
      const entry = prev[id];
      if (!entry) return prev;
      if (sessionId && entry.sessionId !== sessionId) return prev;
      const next = { ...prev };
      delete next[id];
      recordTrace?.("clear", {
        workspaceId: id,
        sessionId: sessionId ?? null,
        previous: prev,
        next,
      });
      return next;
    });
  }

  function clearWorkspaceBusyAllExcept(workspaceId: string) {
    const keep = workspaceId.trim();
    setWorkspaceBusy((prev) => {
      const next: WorkspaceBusyMap = {};
      if (keep && prev[keep]) next[keep] = prev[keep];
      recordTrace?.("clear-all-except", {
        keepWorkspaceId: keep || null,
        previous: prev,
        next,
        droppedWorkspaceIds: Object.keys(prev).filter((id) => id !== keep),
      });
      return next;
    });
  }

  return {
    workspaceBusy,
    markWorkspaceBusy,
    clearWorkspaceBusy,
    clearWorkspaceBusyAllExcept,
  };
}
