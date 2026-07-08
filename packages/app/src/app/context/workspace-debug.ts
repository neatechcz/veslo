import { createSignal } from "solid-js";

export type WorkspaceDebugEvent = {
  at: number;
  label: string;
  payload?: unknown;
};

export type WorkspaceBusyEntry = {
  startedAt: number;
};

export type WorkspaceBusySessions = Record<string, WorkspaceBusyEntry>;

export type WorkspaceBusyMap = Record<string, WorkspaceBusySessions>;

type WorkspaceBusyTraceRoot = typeof window & {
  __vesloWorkspaceBusyTrace?: Array<Record<string, unknown>>;
  __vesloWorkspaceBusySnapshot?: WorkspaceBusyMap;
  __wsActivateLog?: string;
};

export function recordWorkspaceBusyTrace(
  event: string,
  payload?: Record<string, unknown>,
) {
  if (typeof window === "undefined") return;
  try {
    const root = window as WorkspaceBusyTraceRoot;
    const logs = root.__vesloWorkspaceBusyTrace ?? [];
    logs.push({
      at: new Date().toISOString(),
      ts: Date.now(),
      source: "workspace",
      event,
      ...(payload ?? {}),
    });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    root.__vesloWorkspaceBusyTrace = logs;
    if (payload?.next && typeof payload.next === "object") {
      root.__vesloWorkspaceBusySnapshot = payload.next as WorkspaceBusyMap;
    }
    console.log("[workspace:busy]", event, payload ?? {});
  } catch {
    // ignore
  }
}

export function wsLog(msg: string, data?: unknown) {
  const line = `[${new Date().toISOString()}] ${msg}${
    data !== undefined ? " " + (typeof data === "string" ? data : JSON.stringify(data)) : ""
  }`;
  console.log(line);
  try {
    const root = window as WorkspaceBusyTraceRoot;
    root.__wsActivateLog = `${root.__wsActivateLog ?? ""}${line}\n`;
  } catch {
    // ignore
  }
  try {
    void import("../lib/tauri")
      .then((mod) => mod.logUiEvent("workspace", msg, data))
      .catch(() => {});
  } catch {
    // ignore
  }
}

export const workspaceDebugStack = () => {
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

export function createWorkspaceDebugEvents(enabled: () => boolean) {
  const eventLimit = 200;
  const [workspaceDebugEvents, setWorkspaceDebugEvents] = createSignal<WorkspaceDebugEvent[]>([]);
  const clearWorkspaceDebugEvents = () => setWorkspaceDebugEvents([]);
  const pushWorkspaceDebugEvent = (label: string, payload?: unknown) => {
    if (!enabled()) return;
    const entry: WorkspaceDebugEvent = { at: Date.now(), label, payload };
    setWorkspaceDebugEvents((prev) => {
      if (!prev.length) return [entry];
      const sliceStart = Math.max(0, prev.length - eventLimit + 1);
      const next = prev.slice(sliceStart);
      next.push(entry);
      return next;
    });
  };

  const wsDebug = (label: string, payload?: unknown) => {
    if (!enabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
      pushWorkspaceDebugEvent(label, payload);
    } catch {
      // ignore
    }
  };

  return {
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
    pushWorkspaceDebugEvent,
    wsDebug,
  };
}
