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
  __vesloSendFailureSnapshots?: Record<string, unknown>;
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloWorkspaceRuntimeSnapshot?: () => Promise<unknown>;
  __vesloWorkspaceRuntimeDiff?: () => Promise<unknown>;
  __vesloWorkspaceRuntimeLastSnapshot?: unknown;
  __vesloWorkspaceRuntimeDebugHelp?: string;
  __vesloRequestBrokerSnapshot?: () => unknown;
  __vesloWorkspaceBusyTrace?: Array<Record<string, unknown>>;
  __wsActivateLog?: string;
};

type RuntimeRecord = Record<string, unknown>;
type WorkspaceRuntimeSnapshot = RuntimeRecord & {
  diagnosis?: unknown;
};

export type WorkspaceRuntimeDebugProbeDeps = {
  windowTarget?: WorkspaceRuntimeDebugRoot | null | (() => WorkspaceRuntimeDebugRoot | null);
  readSnapshot: () => Promise<WorkspaceRuntimeSnapshot>;
  getRequestBrokerSnapshot: () => unknown;
  log?: (event: string, payload?: Record<string, unknown>) => void;
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

function recordFromValue(value: unknown): RuntimeRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RuntimeRecord
    : {};
}

function recordsFromValue(value: unknown): RuntimeRecord[] {
  return Array.isArray(value) ? value.map(recordFromValue) : [];
}

function stringFromValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringField(record: RuntimeRecord, key: string): string {
  return stringFromValue(record[key]);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringFromValue(value);
    if (text) return text;
  }
  return "";
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

export function buildWorkspaceRuntimeDiagnosis(snapshot: WorkspaceRuntimeSnapshot): WorkspaceRuntimeDiagnosisEntry[] {
  const diagnosis: WorkspaceRuntimeDiagnosisEntry[] = [];
  const app = recordFromValue(snapshot.app);
  const session = recordFromValue(snapshot.session);
  const routing = recordFromValue(snapshot.routing);
  const tauri = recordFromValue(snapshot.tauri);
  const server = recordFromValue(snapshot.server);
  const orchestrator = recordFromValue(snapshot.orchestrator);
  const activeWorkspaceId = String(app.activeWorkspaceId ?? "").trim();
  const activeWorkspace = recordFromValue(app.activeWorkspace);
  const activeWorkspaceRoot = debugNormalizePath(String(app.activeWorkspaceRoot ?? ""));
  const currentEngine = recordFromValue(app.engine);

  if (app.connectingWorkspaceId) {
    diagnosis.push({
      level: "info",
      code: "workspace-switch-in-progress",
      message: "A workspace activation is currently in progress.",
      details: {
        activeWorkspaceId,
        connectingWorkspaceId: app.connectingWorkspaceId,
      },
    });
  }

  const selectedScope = recordFromValue(session.selectedScope);
  const selectedWorkspaceId = stringField(selectedScope, "workspaceId");
  if (selectedWorkspaceId && selectedWorkspaceId !== activeWorkspaceId) {
    diagnosis.push({
      level: "info",
      code: "browse-only-selected-session",
      message: "The visible selected session is scoped to a different workspace than the active runtime workspace.",
      details: {
        activeWorkspaceId,
        selectedSessionId: session.selectedSessionId,
        selectedWorkspaceId,
      },
    });
  }

  const sendTarget = recordFromValue(session.sendTarget);
  const sendTargetWorkspaceId = stringField(sendTarget, "workspaceId");
  if (sendTargetWorkspaceId && sendTargetWorkspaceId !== activeWorkspaceId) {
    diagnosis.push({
      level: "warning",
      code: "send-would-activate-workspace",
      message: "A send from the current visible session would first activate another workspace.",
      details: {
        activeWorkspaceId,
        sendTargetWorkspaceId,
      },
    });
  }

  const workspaceBootstrap = recordFromValue(tauri.workspaceBootstrap);
  const workspaceBootstrapValue = recordFromValue(workspaceBootstrap.value);
  const tauriActiveId = workspaceBootstrap.ok
    ? String(workspaceBootstrapValue.activeId ?? "").trim()
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

  const serverWorkspaces = recordFromValue(server.workspaces);
  const serverList = serverWorkspaces.ok ? recordFromValue(serverWorkspaces.value) : {};
  const serverItems = recordsFromValue(serverList.items);
  const serverActiveId = String(serverList.activeId ?? "").trim();
  const serverActive = serverItems.find((item) => item.id === serverActiveId) ?? {};
  const serverActiveOpencode = recordFromValue(serverActive.opencode);
  const serverActiveRoot = debugNormalizePath(
    firstString(serverActiveOpencode.directory, serverActive.directory, serverActive.path),
  );
  if (activeWorkspace.type === "local" && serverActiveId) {
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

  const orchestratorStatus = recordFromValue(orchestrator.status);
  const orchestratorStatusSnapshot = orchestratorStatus.ok
    ? recordFromValue(orchestratorStatus.value)
    : {};
  const orchestratorActiveId = String(orchestratorStatusSnapshot.activeId ?? "").trim();
  const orchestratorItems = recordsFromValue(orchestratorStatusSnapshot.workspaces);
  const orchestratorActive = orchestratorItems.find((item) => item.id === orchestratorActiveId) ?? {};
  const orchestratorActiveRoot = debugNormalizePath(firstString(orchestratorActive.directory, orchestratorActive.path));
  if (activeWorkspace.type === "local" && orchestratorActiveId) {
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

  const routeEntry = activeWorkspaceId
    ? recordsFromValue(routing.entries).find((entry) => entry.workspaceId === activeWorkspaceId)
    : null;
  if (app.engineReady && activeWorkspaceId && !routeEntry) {
    diagnosis.push({
      level: "error",
      code: "engine-ready-without-active-route",
      message: "engineReady is true but no routed client exists for the active workspace.",
      details: { activeWorkspaceId },
    });
  }

  const engineProjectRoot = debugNormalizePath(stringField(currentEngine, "projectDir"));
  if (activeWorkspace.type === "local" && activeWorkspaceRoot && engineProjectRoot && activeWorkspaceRoot !== engineProjectRoot) {
    diagnosis.push({
      level: "error",
      code: "app-engine-project-dir-mismatch",
      message: "Current engine projectDir differs from the active local workspace root.",
      details: {
        appActiveRoot: activeWorkspaceRoot,
        engineProjectDir: currentEngine.projectDir ?? null,
      },
    });
  }

  const currentEngineBaseUrl = stringField(currentEngine, "baseUrl");
  const currentEngineMountId = debugWorkspaceIdFromMountedBaseUrl(currentEngineBaseUrl);
  if (currentEngineMountId && activeWorkspaceId && currentEngineMountId !== activeWorkspaceId) {
    diagnosis.push({
      level: "error",
      code: "current-engine-mount-id-mismatch",
      message: "Current engine baseUrl is mounted for a different workspace id than the active workspace.",
      details: {
        activeWorkspaceId,
        currentEngineMountId,
        baseUrl: currentEngineBaseUrl || null,
      },
    });
  }

  const engineInfo = recordFromValue(tauri.engineInfo);
  const liveEngineInfo = engineInfo.ok ? recordFromValue(engineInfo.value) : {};
  const liveEngineBaseUrl = stringField(liveEngineInfo, "baseUrl");
  const liveEngineMountId = debugWorkspaceIdFromMountedBaseUrl(liveEngineBaseUrl);
  if (liveEngineMountId && activeWorkspaceId && liveEngineMountId !== activeWorkspaceId) {
    diagnosis.push({
      level: "error",
      code: "live-engine-info-mount-id-mismatch",
      message: "Live Tauri engine_info baseUrl is mounted for a different workspace id than the active workspace.",
      details: {
        activeWorkspaceId,
        liveEngineMountId,
        baseUrl: liveEngineBaseUrl || null,
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

export function summarizeWorkspaceRuntimeSnapshotForDiff(snapshot: unknown) {
  const record = recordFromValue(snapshot);
  const app = recordFromValue(record.app);
  const session = recordFromValue(record.session);
  const selectedScope = recordFromValue(session.selectedScope);
  const sendTarget = recordFromValue(session.sendTarget);
  const routing = recordFromValue(record.routing);
  const tauri = recordFromValue(record.tauri);
  const workspaceBootstrap = recordFromValue(tauri.workspaceBootstrap);
  const workspaceBootstrapValue = recordFromValue(workspaceBootstrap.value);
  const server = recordFromValue(record.server);
  const serverWorkspaces = recordFromValue(server.workspaces);
  const serverWorkspacesValue = recordFromValue(serverWorkspaces.value);
  const orchestrator = recordFromValue(record.orchestrator);
  const orchestratorStatus = recordFromValue(orchestrator.status);
  const orchestratorStatusValue = recordFromValue(orchestratorStatus.value);
  return {
    route: app.route ?? null,
    activeWorkspaceId: app.activeWorkspaceId ?? "",
    connectingWorkspaceId: app.connectingWorkspaceId ?? null,
    activeWorkspaceRoot: app.activeWorkspaceRoot ?? "",
    projectDir: app.projectDir ?? "",
    engineReady: Boolean(app.engineReady),
    selectedSessionId: session.selectedSessionId ?? null,
    selectedScopeWorkspaceId: selectedScope.workspaceId ?? null,
    sendTargetWorkspaceId: sendTarget.workspaceId ?? null,
    routedWorkspaceIds: Array.isArray(routing.entryIds) ? routing.entryIds : [],
    tauriActiveId: workspaceBootstrap.ok
      ? workspaceBootstrapValue.activeId ?? null
      : null,
    serverActiveId: serverWorkspaces.ok
      ? serverWorkspacesValue.activeId ?? null
      : null,
    orchestratorActiveId: orchestratorStatus.ok
      ? orchestratorStatusValue.activeId ?? null
      : null,
    diagnosis: Array.isArray(record.diagnosis)
      ? record.diagnosis.map((entry) => {
          const diagnosisEntry = recordFromValue(entry);
          return `${diagnosisEntry.level}:${diagnosisEntry.code}`;
        })
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

function ensureWorkspaceRuntimeDiagnosis(snapshot: WorkspaceRuntimeSnapshot) {
  if (!Array.isArray(snapshot.diagnosis)) {
    snapshot.diagnosis = buildWorkspaceRuntimeDiagnosis(snapshot);
  }
  return snapshot;
}

export function createWorkspaceRuntimeDebugProbe(deps: WorkspaceRuntimeDebugProbeDeps) {
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
      return snapshot;
    };
    const diffFn = async () => {
      const diff = await readDiff();
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
