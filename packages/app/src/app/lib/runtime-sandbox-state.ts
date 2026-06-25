export type RuntimeSandboxBackend =
  | "none"
  | "docker"
  | "container"
  | "mac-sandbox-exec"
  | "windows-wsl2"
  | "windows-job-object"
  | "stub"
  | "unknown";

export type RuntimeEngineChildKind = "direct" | "wsl";
export type RuntimeDirectoryQueryPathMode = "auto" | "sandbox" | "non-sandbox";

export type RuntimeSandboxCapability = {
  enabled?: boolean | null;
  backend?: string | null;
} | null | undefined;

export type RuntimeSandboxEngineInfo = {
  running?: boolean | null;
  runtime?: string | null;
  childKind?: string | null;
  projectDir?: string | null;
  baseUrl?: string | null;
} | null | undefined;

export type RuntimeSandboxEngineSnapshot = {
  workspaceId?: string | null;
  workdir?: string | null;
  childKind?: string | null;
  state?: string | null;
} | null | undefined;

export type EffectiveRuntimeSandboxState = {
  configuredBackend: RuntimeSandboxBackend;
  configuredEnabled: boolean;
  effectiveBackend: RuntimeSandboxBackend;
  isSandboxed: boolean;
  childKind: RuntimeEngineChildKind | null;
  childKindSource: "engine-info" | "orchestrator-engine" | "inferred-direct-runtime" | "none";
  directoryQueryMode: RuntimeDirectoryQueryPathMode;
  requiresEngineBridgeUrl: boolean;
  sandboxFallback: boolean;
};

const KNOWN_BACKENDS = new Set<RuntimeSandboxBackend>([
  "none",
  "docker",
  "container",
  "mac-sandbox-exec",
  "windows-wsl2",
  "windows-job-object",
  "stub",
  "unknown",
]);

const ACTIVE_BACKENDS = new Set<RuntimeSandboxBackend>([
  "mac-sandbox-exec",
  "windows-wsl2",
]);

function normalizeBackend(value: string | null | undefined): RuntimeSandboxBackend {
  const normalized = value?.trim() as RuntimeSandboxBackend | undefined;
  return normalized && KNOWN_BACKENDS.has(normalized) ? normalized : "none";
}

function normalizeChildKind(value: string | null | undefined): RuntimeEngineChildKind | null {
  const normalized = value?.trim();
  return normalized === "direct" || normalized === "wsl" ? normalized : null;
}

function normalizePath(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function findMatchingEngineSnapshot(input: {
  engines?: RuntimeSandboxEngineSnapshot[] | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceRoot?: string | null;
}): RuntimeSandboxEngineSnapshot | null {
  const engines = input.engines ?? [];
  const targetWorkspaceId = input.targetWorkspaceId?.trim() ?? "";
  if (targetWorkspaceId) {
    const byId = engines.find((engine) => engine?.workspaceId?.trim() === targetWorkspaceId);
    if (byId) return byId;
  }

  const targetRoot = normalizePath(input.targetWorkspaceRoot);
  if (!targetRoot) return null;
  return engines.find((engine) => normalizePath(engine?.workdir) === targetRoot) ?? null;
}

function resolveChildKind(input: {
  engineInfo?: RuntimeSandboxEngineInfo;
  engineSnapshot?: RuntimeSandboxEngineSnapshot | null;
}): Pick<EffectiveRuntimeSandboxState, "childKind" | "childKindSource"> {
  const engineInfoChildKind = normalizeChildKind(input.engineInfo?.childKind);
  if (engineInfoChildKind) {
    return { childKind: engineInfoChildKind, childKindSource: "engine-info" };
  }

  const snapshotChildKind = normalizeChildKind(input.engineSnapshot?.childKind);
  if (snapshotChildKind) {
    return { childKind: snapshotChildKind, childKindSource: "orchestrator-engine" };
  }

  if (input.engineInfo?.runtime === "direct" && input.engineInfo.running === true) {
    return { childKind: "direct", childKindSource: "inferred-direct-runtime" };
  }

  return { childKind: null, childKindSource: "none" };
}

export function resolveEffectiveRuntimeSandboxState(input: {
  configuredSandbox?: RuntimeSandboxCapability;
  engineInfo?: RuntimeSandboxEngineInfo;
  orchestratorEngines?: RuntimeSandboxEngineSnapshot[] | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceRoot?: string | null;
}): EffectiveRuntimeSandboxState {
  const configuredBackend = normalizeBackend(input.configuredSandbox?.backend);
  const configuredEnabled =
    input.configuredSandbox?.enabled === true && ACTIVE_BACKENDS.has(configuredBackend);
  const engineSnapshot = findMatchingEngineSnapshot({
    engines: input.orchestratorEngines,
    targetWorkspaceId: input.targetWorkspaceId,
    targetWorkspaceRoot: input.targetWorkspaceRoot,
  });
  const { childKind, childKindSource } = resolveChildKind({
    engineInfo: input.engineInfo,
    engineSnapshot,
  });

  let effectiveBackend: RuntimeSandboxBackend = configuredEnabled ? configuredBackend : "none";
  if (configuredBackend === "windows-wsl2") {
    if (childKind === "wsl") {
      effectiveBackend = "windows-wsl2";
    } else if (childKind === "direct") {
      effectiveBackend = "none";
    } else {
      effectiveBackend = configuredEnabled ? "windows-wsl2" : "none";
    }
  }

  const isSandboxed = ACTIVE_BACKENDS.has(effectiveBackend);
  const sandboxFallback = configuredBackend === "windows-wsl2" && childKind === "direct";
  const directoryQueryMode: RuntimeDirectoryQueryPathMode =
    effectiveBackend === "windows-wsl2"
      ? childKind === "wsl"
        ? "sandbox"
        : "auto"
      : "non-sandbox";

  return {
    configuredBackend,
    configuredEnabled,
    effectiveBackend,
    isSandboxed,
    childKind,
    childKindSource,
    directoryQueryMode,
    requiresEngineBridgeUrl: effectiveBackend === "windows-wsl2" && childKind === "wsl",
    sandboxFallback,
  };
}
