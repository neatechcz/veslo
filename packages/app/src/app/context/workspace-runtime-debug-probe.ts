import type { WorkspaceInfo } from "../lib/tauri";
import { normalizeDirectoryPath } from "../utils";

export type DebugProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; skipped?: boolean };

export type WorkspaceRuntimeDiagnosisEntry = {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type WorkspaceRuntimeDebugRoot = {
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloWorkspaceRuntimeSnapshot?: () => Promise<unknown>;
  __vesloWorkspaceRuntimeDiff?: () => Promise<unknown>;
  __vesloWorkspaceRuntimeLastSnapshot?: unknown;
  __vesloWorkspaceRuntimeDebugHelp?: string;
  __vesloRequestBrokerSnapshot?: () => unknown;
  __vesloWorkspaceBusyTrace?: Array<Record<string, unknown>>;
  __wsActivateLog?: string;
};

export type WorkspaceRuntimeDebugProbeDeps = {
  windowTarget?: WorkspaceRuntimeDebugRoot | null | (() => WorkspaceRuntimeDebugRoot | null);
  readSnapshot: () => Promise<Record<string, any>>;
  getRequestBrokerSnapshot: () => unknown;
  log?: (event: string, payload?: Record<string, unknown>) => void;
  consoleLog?: (label: string, payload: unknown) => void;
};

const workspaceRuntimeDebugHelp =
  "Use await window.__vesloWorkspaceRuntimeSnapshot() before an action, await window.__vesloWorkspaceRuntimeDiff() after it, or window.__vesloRequestBrokerSnapshot() for Veslo server request counters.";

function debugProbeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function debugProbeCall<T>(fn: () => Promise<T> | T): Promise<DebugProbeResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: debugProbeErrorMessage(error) };
  }
}

export function debugProbeSkipped<T>(reason: string): DebugProbeResult<T> {
  return {
    ok: false,
    skipped: true,
    error: reason,
  };
}

function debugNormalizePath(value?: string | null) {
  return normalizeDirectoryPath(value?.trim() ?? "");
}

export function debugSummarizeWorkspace(workspace?: Partial<WorkspaceInfo> | null) {
  if (!workspace) return null;
  return {
    id: workspace.id ?? "",
    name: workspace.displayName || workspace.name || "",
    type: workspace.workspaceType ?? null,
    remoteType: workspace.remoteType ?? null,
    path: workspace.path ?? "",
    directory: workspace.directory ?? null,
    baseUrl: workspace.baseUrl ?? null,
    vesloWorkspaceId: workspace.vesloWorkspaceId ?? null,
  };
}

export function debugWorkspaceIdFromMountedBaseUrl(baseUrl?: string | null) {
  const value = baseUrl?.trim() ?? "";
  if (!value) return "";
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.match(/^\/workspace\/([^/]+)\/opencode(?:\/.*)?$/)?.[1] ?? "");
  } catch {
    return "";
  }
}

export function buildWorkspaceRuntimeDiagnosis(snapshot: Record<string, any>): WorkspaceRuntimeDiagnosisEntry[] {
  const diagnosis: WorkspaceRuntimeDiagnosisEntry[] = [];
  const activeWorkspaceId = String(snapshot.app?.activeWorkspaceId ?? "").trim();
  const activeWorkspace = snapshot.app?.activeWorkspace as ReturnType<typeof debugSummarizeWorkspace>;
  const activeWorkspaceRoot = debugNormalizePath(String(snapshot.app?.activeWorkspaceRoot ?? ""));
  const currentEngine = snapshot.app?.engine ?? null;

  if (snapshot.app?.connectingWorkspaceId) {
    diagnosis.push({
      level: "info",
      code: "workspace-switch-in-progress",
      message: "A workspace activation is currently in progress.",
      details: {
        activeWorkspaceId,
        connectingWorkspaceId: snapshot.app.connectingWorkspaceId,
      },
    });
  }

  const selectedScope = snapshot.session?.selectedScope;
  if (selectedScope?.workspaceId && selectedScope.workspaceId !== activeWorkspaceId) {
    diagnosis.push({
      level: "info",
      code: "browse-only-selected-session",
      message: "The visible selected session is scoped to a different workspace than the active runtime workspace.",
      details: {
        activeWorkspaceId,
        selectedSessionId: snapshot.session.selectedSessionId,
        selectedWorkspaceId: selectedScope.workspaceId,
      },
    });
  }

  const sendTarget = snapshot.session?.sendTarget;
  if (sendTarget?.workspaceId && sendTarget.workspaceId !== activeWorkspaceId) {
    diagnosis.push({
      level: "warning",
      code: "send-would-activate-workspace",
      message: "A send from the current visible session would first activate another workspace.",
      details: {
        activeWorkspaceId,
        sendTargetWorkspaceId: sendTarget.workspaceId,
      },
    });
  }

  const tauriActiveId = snapshot.tauri?.workspaceBootstrap?.ok
    ? String(snapshot.tauri.workspaceBootstrap.value?.activeId ?? "").trim()
    : "";
  if (tauriActiveId && activeWorkspaceId && tauriActiveId !== activeWorkspaceId) {
    diagnosis.push({
      level: "error",
      code: "app-tauri-active-mismatch",
      message: "Frontend active workspace id differs from Tauri persisted active id.",
      details: {
        appActiveId: activeWorkspaceId,
        tauriActiveId,
      },
    });
  }

  const serverList = snapshot.server?.workspaces?.ok ? snapshot.server.workspaces.value : null;
  const serverItems = Array.isArray(serverList?.items) ? serverList.items : [];
  const serverActiveId = String(serverList?.activeId ?? "").trim();
  const serverActive = serverItems.find((item: any) => item?.id === serverActiveId) ?? null;
  const serverActiveRoot = debugNormalizePath(
    serverActive?.opencode?.directory ?? serverActive?.directory ?? serverActive?.path ?? "",
  );
  if (activeWorkspace?.type === "local" && serverActiveId) {
    if (activeWorkspaceRoot && serverActiveRoot && activeWorkspaceRoot !== serverActiveRoot) {
      diagnosis.push({
        level: "error",
        code: "app-server-active-path-mismatch",
        message: "Frontend active local workspace path differs from Veslo server active workspace path.",
        details: {
          appActiveId: activeWorkspaceId,
          appActiveRoot: activeWorkspaceRoot,
          serverActiveId,
          serverActiveRoot,
        },
      });
    } else if (activeWorkspaceId && serverActiveId !== activeWorkspaceId) {
      diagnosis.push({
        level: "warning",
        code: "app-server-active-id-mismatch",
        message: "Frontend active workspace id differs from Veslo server active id, but paths may still match.",
        details: {
          appActiveId: activeWorkspaceId,
          serverActiveId,
          serverActiveRoot,
        },
      });
    }
  }

  const orchestratorStatusSnapshot = snapshot.orchestrator?.status?.ok
    ? snapshot.orchestrator.status.value
    : null;
  const orchestratorActiveId = String(orchestratorStatusSnapshot?.activeId ?? "").trim();
  const orchestratorItems = Array.isArray(orchestratorStatusSnapshot?.workspaces)
    ? orchestratorStatusSnapshot.workspaces
    : [];
  const orchestratorActive = orchestratorItems.find((item: any) => item?.id === orchestratorActiveId) ?? null;
  const orchestratorActiveRoot = debugNormalizePath(orchestratorActive?.directory ?? orchestratorActive?.path ?? "");
  if (activeWorkspace?.type === "local" && orchestratorActiveId) {
    if (activeWorkspaceRoot && orchestratorActiveRoot && activeWorkspaceRoot !== orchestratorActiveRoot) {
      diagnosis.push({
        level: "error",
        code: "app-orchestrator-active-path-mismatch",
        message: "Frontend active local workspace path differs from orchestrator active workspace path.",
        details: {
          appActiveId: activeWorkspaceId,
          appActiveRoot: activeWorkspaceRoot,
          orchestratorActiveId,
          orchestratorActiveRoot,
        },
      });
    } else if (activeWorkspaceId && orchestratorActiveId !== activeWorkspaceId) {
      diagnosis.push({
        level: "warning",
        code: "app-orchestrator-active-id-mismatch",
        message: "Frontend active workspace id differs from orchestrator active id, but paths may still match.",
        details: {
          appActiveId: activeWorkspaceId,
          orchestratorActiveId,
          orchestratorActiveRoot,
        },
      });
    }
  }

  const routeEntry = activeWorkspaceId ? snapshot.routing?.entries?.find((entry: any) => entry.workspaceId === activeWorkspaceId) : null;
  if (snapshot.app?.engineReady && activeWorkspaceId && !routeEntry) {
    diagnosis.push({
      level: "error",
      code: "engine-ready-without-active-route",
      message: "engineReady is true but no routed client exists for the active workspace.",
      details: { activeWorkspaceId },
    });
  }

  const engineProjectRoot = debugNormalizePath(currentEngine?.projectDir ?? "");
  if (activeWorkspace?.type === "local" && activeWorkspaceRoot && engineProjectRoot && activeWorkspaceRoot !== engineProjectRoot) {
    diagnosis.push({
      level: "error",
      code: "app-engine-project-dir-mismatch",
      message: "Current engine projectDir differs from the active local workspace root.",
      details: {
        appActiveRoot: activeWorkspaceRoot,
        engineProjectDir: currentEngine?.projectDir ?? null,
      },
    });
  }

  const currentEngineMountId = debugWorkspaceIdFromMountedBaseUrl(currentEngine?.baseUrl ?? "");
  if (currentEngineMountId && activeWorkspaceId && currentEngineMountId !== activeWorkspaceId) {
    diagnosis.push({
      level: "error",
      code: "current-engine-mount-id-mismatch",
      message: "Current engine baseUrl is mounted for a different workspace id than the active workspace.",
      details: {
        activeWorkspaceId,
        currentEngineMountId,
        baseUrl: currentEngine?.baseUrl ?? null,
      },
    });
  }

  const liveEngineInfo = snapshot.tauri?.engineInfo?.ok ? snapshot.tauri.engineInfo.value : null;
  const liveEngineMountId = debugWorkspaceIdFromMountedBaseUrl(liveEngineInfo?.baseUrl ?? "");
  if (liveEngineMountId && activeWorkspaceId && liveEngineMountId !== activeWorkspaceId) {
    diagnosis.push({
      level: "error",
      code: "live-engine-info-mount-id-mismatch",
      message: "Live Tauri engine_info baseUrl is mounted for a different workspace id than the active workspace.",
      details: {
        activeWorkspaceId,
        liveEngineMountId,
        baseUrl: liveEngineInfo?.baseUrl ?? null,
      },
    });
  }

  if (!diagnosis.length) {
    diagnosis.push({
      level: "info",
      code: "no-obvious-active-workspace-mismatch",
      message: "No obvious active workspace mismatch was detected in the sampled layers.",
    });
  }

  return diagnosis;
}

export function summarizeWorkspaceRuntimeSnapshotForDiff(snapshot: any) {
  return {
    route: snapshot?.app?.route ?? null,
    activeWorkspaceId: snapshot?.app?.activeWorkspaceId ?? "",
    connectingWorkspaceId: snapshot?.app?.connectingWorkspaceId ?? null,
    activeWorkspaceRoot: snapshot?.app?.activeWorkspaceRoot ?? "",
    projectDir: snapshot?.app?.projectDir ?? "",
    engineReady: Boolean(snapshot?.app?.engineReady),
    selectedSessionId: snapshot?.session?.selectedSessionId ?? null,
    selectedScopeWorkspaceId: snapshot?.session?.selectedScope?.workspaceId ?? null,
    sendTargetWorkspaceId: snapshot?.session?.sendTarget?.workspaceId ?? null,
    routedWorkspaceIds: snapshot?.routing?.entryIds ?? [],
    tauriActiveId: snapshot?.tauri?.workspaceBootstrap?.ok
      ? snapshot.tauri.workspaceBootstrap.value?.activeId ?? null
      : null,
    serverActiveId: snapshot?.server?.workspaces?.ok
      ? snapshot.server.workspaces.value?.activeId ?? null
      : null,
    orchestratorActiveId: snapshot?.orchestrator?.status?.ok
      ? snapshot.orchestrator.status.value?.activeId ?? null
      : null,
    diagnosis: Array.isArray(snapshot?.diagnosis)
      ? snapshot.diagnosis.map((entry: any) => `${entry.level}:${entry.code}`)
      : [],
  };
}

function resolveWindowTarget(
  target: WorkspaceRuntimeDebugProbeDeps["windowTarget"],
): WorkspaceRuntimeDebugRoot | null {
  if (typeof target === "function") return target();
  if (target) return target;
  if (typeof window === "undefined") return null;
  return window as unknown as WorkspaceRuntimeDebugRoot;
}

function ensureWorkspaceRuntimeDiagnosis(snapshot: Record<string, any>) {
  if (!Array.isArray(snapshot.diagnosis)) {
    snapshot.diagnosis = buildWorkspaceRuntimeDiagnosis(snapshot);
  }
  return snapshot;
}

export function createWorkspaceRuntimeDebugProbe(deps: WorkspaceRuntimeDebugProbeDeps) {
  const consoleLog = deps.consoleLog ?? (() => {});

  const readSnapshot = async () => ensureWorkspaceRuntimeDiagnosis(await deps.readSnapshot());

  const readDiff = async () => {
    const root = resolveWindowTarget(deps.windowTarget);
    if (!root) {
      return { error: "window is unavailable" };
    }

    const previous = root.__vesloWorkspaceRuntimeLastSnapshot;
    const next = await readSnapshot();
    root.__vesloWorkspaceRuntimeLastSnapshot = next;
    return {
      changed: JSON.stringify(summarizeWorkspaceRuntimeSnapshotForDiff(previous)) !==
        JSON.stringify(summarizeWorkspaceRuntimeSnapshotForDiff(next)),
      previous: previous ? summarizeWorkspaceRuntimeSnapshotForDiff(previous) : null,
      next: summarizeWorkspaceRuntimeSnapshotForDiff(next),
      diagnosis: next.diagnosis,
      snapshot: next,
    };
  };

  const install = () => {
    const root = resolveWindowTarget(deps.windowTarget);
    if (!root) return () => {};

    const snapshotFn = async () => {
      const snapshot = await readSnapshot();
      root.__vesloWorkspaceRuntimeLastSnapshot = snapshot;
      consoleLog("[WSDBG] runtime-snapshot", snapshot);
      return snapshot;
    };
    const diffFn = async () => {
      const diff = await readDiff();
      consoleLog("[WSDBG] runtime-diff", diff);
      return diff;
    };

    root.__vesloWorkspaceRuntimeSnapshot = snapshotFn;
    root.__vesloWorkspaceRuntimeDiff = diffFn;
    root.__vesloRequestBrokerSnapshot = deps.getRequestBrokerSnapshot;
    root.__vesloWorkspaceRuntimeDebugHelp = workspaceRuntimeDebugHelp;
    deps.log?.("runtime-probe:installed", {
      snapshot: "__vesloWorkspaceRuntimeSnapshot()",
      diff: "__vesloWorkspaceRuntimeDiff()",
      requestBroker: "__vesloRequestBrokerSnapshot()",
    });

    return () => {
      delete root.__vesloWorkspaceRuntimeSnapshot;
      delete root.__vesloWorkspaceRuntimeDiff;
      delete root.__vesloWorkspaceRuntimeDebugHelp;
      delete root.__vesloRequestBrokerSnapshot;
    };
  };

  return {
    readSnapshot,
    readDiff,
    install,
  };
}
