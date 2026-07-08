import type { WorkspaceInfo } from "../lib/tauri";
import type { EngineRuntime } from "../types";

type WorkspaceLifecyclePhase =
  | "idle"
  | "activating"
  | "browsing"
  | "runtime-starting"
  | "connected"
  | "degraded"
  | "error";

type WorkspaceLifecycleEntry = {
  workspaceId: string;
  phase: WorkspaceLifecyclePhase;
  workspaceType?: WorkspaceInfo["workspaceType"];
  runtime?: EngineRuntime;
  origin?: string;
  reason?: string;
  root?: string;
  message?: string | null;
  activationVersion?: number;
  updatedAt: number;
};

export type WorkspaceLifecycleState = {
  activeWorkspaceId: string | null;
  activationVersion: number;
  byWorkspace: Record<string, WorkspaceLifecycleEntry>;
};

export type WorkspaceLifecycleEvent =
  | {
      type: "activation-started";
      workspaceId: string;
      version: number;
      origin: string;
      workspaceType: WorkspaceInfo["workspaceType"];
    }
  | { type: "browse-ready"; workspaceId: string; version?: number; root: string }
  | {
      type: "runtime-starting";
      workspaceId: string;
      runtime: EngineRuntime;
      reason: string;
    }
  | {
      type: "connected";
      workspaceId: string;
      version?: number;
      runtime?: EngineRuntime;
      reason: string;
    }
  | { type: "degraded"; workspaceId: string; message: string; reason: string }
  | { type: "failed"; workspaceId: string; version?: number; message: string }
  | { type: "cleared"; workspaceId: string };

const now = () => Date.now();

export function createInitialWorkspaceLifecycleState(): WorkspaceLifecycleState {
  return {
    activeWorkspaceId: null,
    activationVersion: 0,
    byWorkspace: {},
  };
}

function shouldIgnoreVersion(
  state: WorkspaceLifecycleState,
  event: { workspaceId: string; version?: number },
) {
  if (event.version === undefined) return false;
  if (event.version === state.activationVersion) return false;
  if (event.version < state.activationVersion) return true;
  return state.activeWorkspaceId !== event.workspaceId;
}

function setEntry(
  state: WorkspaceLifecycleState,
  workspaceId: string,
  patch: Omit<Partial<WorkspaceLifecycleEntry>, "workspaceId" | "updatedAt">,
): WorkspaceLifecycleState {
  const current = state.byWorkspace[workspaceId] ?? {
    workspaceId,
    phase: "idle" as const,
    updatedAt: now(),
  };
  return {
    ...state,
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: {
        ...current,
        ...patch,
        workspaceId,
        updatedAt: now(),
      },
    },
  };
}

export function reduceWorkspaceLifecycleState(
  state: WorkspaceLifecycleState,
  event: WorkspaceLifecycleEvent,
): WorkspaceLifecycleState {
  if (event.type === "activation-started") {
    return setEntry(
      {
        ...state,
        activeWorkspaceId: event.workspaceId,
        activationVersion: event.version,
      },
      event.workspaceId,
      {
        phase: "activating",
        workspaceType: event.workspaceType,
        origin: event.origin,
        message: null,
        activationVersion: event.version,
      },
    );
  }

  if (event.type === "cleared") {
    const next = { ...state.byWorkspace };
    delete next[event.workspaceId];
    return { ...state, byWorkspace: next };
  }

  if (shouldIgnoreVersion(state, event)) return state;

  if (event.type === "browse-ready") {
    return setEntry(
      { ...state, activeWorkspaceId: event.workspaceId },
      event.workspaceId,
      {
        phase: "browsing",
        root: event.root,
        message: null,
      },
    );
  }

  if (event.type === "runtime-starting") {
    return setEntry(state, event.workspaceId, {
      phase: "runtime-starting",
      runtime: event.runtime,
      reason: event.reason,
      message: null,
    });
  }

  if (event.type === "connected") {
    return setEntry(state, event.workspaceId, {
      phase: "connected",
      runtime: event.runtime,
      reason: event.reason,
      message: null,
    });
  }

  if (event.type === "degraded") {
    return setEntry(state, event.workspaceId, {
      phase: "degraded",
      reason: event.reason,
      message: event.message,
    });
  }

  return setEntry(state, event.workspaceId, {
    phase: "error",
    message: event.message,
  });
}
