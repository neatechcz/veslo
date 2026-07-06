import {
  resolveManagedAiBootstrapCurrentConfigCheck,
  resolveManagedAiBootstrapWaitDecision,
} from "../controllers/managed-ai-bootstrap-readiness-controller";
import type { RuntimeEngineState } from "../lib/tauri";

export const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";
export const managedAiRuntimeConfigNotReadyMessage =
  "Managed AI gateway setup is not ready for this runtime. Please wait a moment and try again.";
export const managedAiRuntimeAuthorizationNotReadyMessage =
  "Managed AI gateway authorization is not ready for this runtime. Please wait a moment and try again.";

export type SendRuntimePreflightTargetWorkspace = {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
};

export type SendRuntimePreflightContext = {
  traceId?: string | null;
  managedAiReady?: boolean;
  runtimeHealthOk?: boolean;
  forceRecovery?: boolean;
  enginePrepared?: boolean;
  effectiveSandbox?: unknown;
  targetWorkspace?: SendRuntimePreflightTargetWorkspace | null;
};

export type SendRuntimeWorkspaceInfo = {
  id?: string | null;
  workspaceType?: string | null;
  path?: string | null;
  directory?: string | null;
};

export type SendRuntimeEngineInfo = {
  running?: boolean;
  engineState?: RuntimeEngineState | null;
  baseUrl?: string | null;
  projectDir?: string | null;
  childKind?: "direct" | "wsl" | string | null;
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
};

function isReadyRuntimeEngine(info: SendRuntimeEngineInfo): boolean {
  return Boolean(info.running && (info.engineState === "ready" || info.engineState === "process_ready"));
}

export type SendRuntimeClient = {
  global: {
    health: () => Promise<unknown>;
  };
};

export type SendRuntimeConnectMetadata = {
  workspaceId?: string;
  workspaceType?: "local" | "remote";
  targetRoot?: string;
  reason?: string;
};

export type SendRuntimeConnectOptions = {
  quiet?: boolean;
  navigate?: boolean;
  forceRefresh?: boolean;
};

export type SendRuntimeManagedAiBootstrapReadyOptions = {
  hasManagedProfile: boolean;
  isBootstrapBusy: () => boolean;
  isReloadBusy: () => boolean;
  hasClient: () => boolean;
};

export type SendRuntimePreparationResult = {
  ok: boolean;
  runtimeReady: boolean;
  managedAiReady: boolean;
  workspaceId: string | null;
  activeWorkspace: boolean;
  recoveryAttempted: boolean;
  reason:
    | "runtime-health-skipped"
    | "runtime-health-skip"
    | "runtime-health-ok"
    | "runtime-recovery-ok"
    | "runtime-recovery-not-started"
    | "runtime-recovery-error"
    | "managed-ai-bootstrap-blocked";
};

export type SendRuntimeReadinessDeps<Client extends SendRuntimeClient = SendRuntimeClient> = {
  isTauriRuntime: () => boolean;
  activeWorkspaceDisplay: () => SendRuntimeWorkspaceInfo;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  clientDirectory: () => string;
  workspaces: () => SendRuntimeWorkspaceInfo[];
  routedClient: (workspaceId?: string) => Client | null | undefined;
  releaseWorkspaceRoute?: (workspaceId: string) => void;
  ensureEngineForWorkspace: (
    workspaceId?: string,
    options?: { reason?: string; loadSessions?: boolean },
  ) => Promise<boolean>;
  connectToServer: (
    baseUrl: string,
    directory?: string,
    metadata?: SendRuntimeConnectMetadata,
    auth?: { username: string; password: string },
    options?: SendRuntimeConnectOptions,
  ) => Promise<boolean>;
  engineInfo: (workspaceId?: string, workspaceRoot?: string) => Promise<SendRuntimeEngineInfo>;
  managedAiAccess: () => unknown;
  managedAiAccessBusy: () => boolean;
  managedAiBootstrapBusy: () => boolean;
  managedAiBootstrapPendingCount: () => number;
  reloadBusy: () => boolean;
  hasUsableManagedAiRuntimeConfigForSend: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => Promise<boolean>;
  ensureManagedAiRuntimeAuthorizationForSend?: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => Promise<boolean>;
  waitForManagedAiBootstrapReady: (options: SendRuntimeManagedAiBootstrapReadyOptions) => Promise<void>;
  sendTraceStep: <T>(
    event: string,
    fn: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  setError: (message: string) => void;
  setEngineReady: (value: boolean) => void;
  setSseConnected: (value: boolean) => void;
  safeStringify: (value: unknown) => string;
};

function stringifyUnknown(value: unknown): string {
  try {
    const stringified = JSON.stringify(value);
    return stringified === undefined ? String(value) : stringified;
  } catch {
    return String(value);
  }
}

export function messageFromUnknownError(
  error: unknown,
  safeStringify: (value: unknown) => string = stringifyUnknown,
): string {
  if (error instanceof Error) return error.message;
  let message: string;
  try {
    message = safeStringify(error);
  } catch {
    message = stringifyUnknown(error);
  }
  return typeof message === "string" ? message : String(message);
}

export function isLocalRuntimeHealthTimeoutError(
  error: unknown,
  safeStringify?: (value: unknown) => string,
): boolean {
  return messageFromUnknownError(error, safeStringify).includes(localRuntimeHealthTimeoutMessage);
}

export function shouldRecoverLocalRuntimeFromHealthError(
  error: unknown,
  safeStringify?: (value: unknown) => string,
): boolean {
  const message = messageFromUnknownError(error, safeStringify);
  const normalized = message.toLowerCase();
  const localRuntimeUnavailable =
    normalized.includes("engine_not_running") ||
    normalized.includes("engine_starting") ||
    normalized.includes("local runtime chain is not ready") ||
    normalized.includes("orchestrator daemon is not running") ||
    normalized.includes('"enginestate":"starting"') ||
    normalized.includes('"engine_state":"starting"') ||
    normalized.includes("opencode_request_failed") ||
    normalized.includes("workspace not found") ||
    normalized.includes("workspace_not_found") ||
    normalized.includes("workspace_id_mismatch") ||
    normalized.includes("opencode_proxy_failed") ||
    normalized.includes("socket closed") ||
    normalized.includes("socket connection was closed") ||
    /\b(?:upstream\s+)?status\s+(?:404|502|503)\b/.test(normalized) ||
    /"status"\s*:\s*(?:404|502|503)\b/.test(normalized);
  return (
    localRuntimeUnavailable ||
    normalized.includes("error sending request") ||
    normalized.includes("connection refused") ||
    message.includes("ECONNREFUSED") ||
    normalized.includes("failed to connect") ||
    normalized.includes("could not connect") ||
    normalized.includes("couldn't connect") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("fetch failed") ||
    normalized.includes("load failed") ||
    normalized.includes("connection reset") ||
    message.includes("ECONNRESET") ||
    normalized.includes("networkerror")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertLocalRuntimeHealthOk(
  result: unknown,
  safeStringify: (value: unknown) => string,
): unknown {
  let payload = result;
  if (isRecord(result)) {
    if ("data" in result) {
      if (result.data !== undefined) {
        payload = result.data;
      } else if (result.error !== undefined && result.error !== null) {
        throw new Error(messageFromUnknownError(result.error, safeStringify));
      }
    } else if (result.error !== undefined && result.error !== null) {
      throw new Error(messageFromUnknownError(result.error, safeStringify));
    }

    if (isRecord(result.response)) {
      const status = typeof result.response.status === "number" ? result.response.status : null;
      if (status !== null && status >= 400) {
        throw new Error(`OpenCode health returned status ${status}`);
      }
    }
  }

  if (isRecord(payload) && payload.healthy === false) {
    throw new Error("Server reported unhealthy");
  }
  return payload;
}

export async function withLocalRuntimeHealthTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 3_000,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(localRuntimeHealthTimeoutMessage)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function createSendRuntimeReadiness<Client extends SendRuntimeClient = SendRuntimeClient>(
  deps: SendRuntimeReadinessDeps<Client>,
) {
  const errorMessage = (error: unknown) => messageFromUnknownError(error, deps.safeStringify);

  const ensureManagedAiBootstrapReady = async (
    preflightOrTraceId?: SendRuntimePreflightContext | string | null,
  ): Promise<boolean> => {
    try {
      const preflight = typeof preflightOrTraceId === "object" ? preflightOrTraceId ?? undefined : undefined;
      const targetWorkspace = preflight?.targetWorkspace ?? null;
      const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() ?? "";
      const hasManagedProfile = Boolean(deps.managedAiAccess());
      const currentConfigCheck = resolveManagedAiBootstrapCurrentConfigCheck({
        accessBusy: deps.managedAiAccessBusy(),
        bootstrapPendingCount: deps.managedAiBootstrapPendingCount(),
        reloadBusy: deps.reloadBusy(),
      });
      const canUseCurrentManagedConfig =
        (hasManagedProfile || currentConfigCheck.type === "check-current-config") &&
        (await deps.hasUsableManagedAiRuntimeConfigForSend(targetWorkspace));
      if (canUseCurrentManagedConfig && deps.ensureManagedAiRuntimeAuthorizationForSend) {
        const runtimeAuthorizationReady =
          await deps.ensureManagedAiRuntimeAuthorizationForSend(targetWorkspace);
        if (!runtimeAuthorizationReady) {
          deps.setError(managedAiRuntimeAuthorizationNotReadyMessage);
          return false;
        }
      }
      const waitDecision = resolveManagedAiBootstrapWaitDecision({
        managedProfilePresent: hasManagedProfile,
        bootstrapBusy: deps.managedAiBootstrapBusy(),
        canUseCurrentManagedConfig,
      });
      if (
        hasManagedProfile &&
        !canUseCurrentManagedConfig &&
        !deps.managedAiBootstrapBusy() &&
        !deps.reloadBusy()
      ) {
        deps.setError(managedAiRuntimeConfigNotReadyMessage);
        return false;
      }
      await deps.waitForManagedAiBootstrapReady({
        hasManagedProfile: waitDecision.hasManagedProfile,
        isBootstrapBusy: deps.managedAiBootstrapBusy,
        isReloadBusy: deps.reloadBusy,
        hasClient: () => Boolean(targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient()),
      });
      return true;
    } catch (error) {
      deps.setError(errorMessage(error));
      return false;
    }
  };

  async function ensureLocalRuntimeReachableForSendResult(
    reason: string,
    preflightOrTraceId?: SendRuntimePreflightContext | string | null,
  ): Promise<SendRuntimePreparationResult> {
    const preflight = typeof preflightOrTraceId === "object" ? preflightOrTraceId ?? undefined : undefined;
    const traceId = typeof preflightOrTraceId === "string"
      ? preflightOrTraceId
      : preflightOrTraceId?.traceId ?? null;
    const tracePayload = traceId ? { traceId } : undefined;
    const targetWorkspaceId = preflight?.targetWorkspace?.workspaceId?.trim() ?? "";
    const targetWorkspace = targetWorkspaceId
      ? deps.workspaces().find((workspace) => workspace.id === targetWorkspaceId) ?? null
      : null;
    const targetWorkspaceType = targetWorkspace?.workspaceType ?? deps.activeWorkspaceDisplay().workspaceType;
    const resultWorkspaceId = targetWorkspaceId || deps.activeWorkspaceId().trim() || null;
    const targetIsActiveWorkspace = !targetWorkspaceId || targetWorkspaceId === deps.activeWorkspaceId().trim();
    if (!deps.isTauriRuntime() || targetWorkspaceType !== "local") {
      deps.recordSendTrace(`${reason}:runtime-health-skipped`, {
        ...(tracePayload ?? {}),
        isTauriRuntime: deps.isTauriRuntime(),
        workspaceType: targetWorkspaceType,
        targetWorkspaceId: targetWorkspaceId || null,
      });
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: false,
        workspaceId: resultWorkspaceId,
        activeWorkspace: targetIsActiveWorkspace,
        recoveryAttempted: false,
        reason: "runtime-health-skipped",
      };
    }

    const currentClient = targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient();
    const forceRecovery = preflight?.forceRecovery === true;
    if (preflight?.runtimeHealthOk && !forceRecovery) {
      deps.recordSendTrace(`${reason}:runtime-health-skip`, {
        ...(tracePayload ?? {}),
        reason: "send-preflight-already-healthy",
        targetWorkspaceId: targetWorkspaceId || null,
      });
      if (targetIsActiveWorkspace) deps.setEngineReady(true);
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: false,
        workspaceId: resultWorkspaceId,
        activeWorkspace: targetIsActiveWorkspace,
        recoveryAttempted: false,
        reason: "runtime-health-skip",
      };
    }
    if (forceRecovery) {
      deps.recordSendTrace(`${reason}:runtime-force-recovery`, {
        ...(tracePayload ?? {}),
        targetWorkspaceId: targetWorkspaceId || null,
      });
    } else if (currentClient) {
      try {
        await deps.sendTraceStep(
          `${reason}:runtime-health`,
          async () => {
            await withLocalRuntimeHealthTimeout(
              currentClient.global.health().then((result) =>
                assertLocalRuntimeHealthOk(result, deps.safeStringify)
              ),
            );
            const engineInfo = await deps.engineInfo(
              resultWorkspaceId ?? undefined,
              preflight?.targetWorkspace?.workspaceRoot ?? targetWorkspace?.path ?? deps.activeWorkspaceRoot(),
            );
            if (!isReadyRuntimeEngine(engineInfo)) {
              throw new Error(
                `local runtime chain is not ready: engineState=${engineInfo.engineState ?? "unknown"} running=${Boolean(engineInfo.running)}`,
              );
            }
          },
          {
            ...(tracePayload ?? {}),
            hasClient: true,
            targetWorkspaceId: targetWorkspaceId || null,
          },
        );
        deps.recordSendTrace(`${reason}:runtime-health-ok`, tracePayload);
        if (preflight) preflight.runtimeHealthOk = true;
        if (preflight) preflight.forceRecovery = false;
        if (targetIsActiveWorkspace) deps.setEngineReady(true);
        return {
          ok: true,
          runtimeReady: true,
          managedAiReady: false,
          workspaceId: resultWorkspaceId,
          activeWorkspace: targetIsActiveWorkspace,
          recoveryAttempted: false,
          reason: "runtime-health-ok",
        };
      } catch (error) {
        const message = errorMessage(error);
        const timedOut = isLocalRuntimeHealthTimeoutError(error, deps.safeStringify);
        const classifiedRecoverable = shouldRecoverLocalRuntimeFromHealthError(error, deps.safeStringify);
        deps.recordSendTrace(`${reason}:runtime-health-error`, {
          ...(tracePayload ?? {}),
          message,
          recoverable: timedOut || classifiedRecoverable,
          recoverByDefault: !timedOut && !classifiedRecoverable,
          willRecover: true,
        });
        // A routed client that fails health is not ready; unknown probe failures recover once.
      }
    } else {
      deps.recordSendTrace(`${reason}:runtime-missing-client`, tracePayload);
    }

    deps.recordSendTrace(`${reason}:runtime-recovery-start`, tracePayload);
    const recoveryWorkspaceId = targetWorkspaceId || deps.activeWorkspaceId().trim();
    if (recoveryWorkspaceId) {
      deps.releaseWorkspaceRoute?.(recoveryWorkspaceId);
      deps.recordSendTrace(`${reason}:runtime-route-released`, {
        ...(tracePayload ?? {}),
        workspaceId: recoveryWorkspaceId,
      });
    }
    if (targetIsActiveWorkspace) {
      deps.setEngineReady(false);
      deps.setSseConnected(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const started = await deps.sendTraceStep(
        `${reason}:runtime-recovery-ensure-engine`,
        () => deps.ensureEngineForWorkspace(targetWorkspaceId || undefined, {
          reason: `${reason}-runtime-recovery`,
          loadSessions: false,
        }),
        {
          ...(tracePayload ?? {}),
          activeWorkspaceId: deps.activeWorkspaceId().trim(),
          activeWorkspaceRoot: deps.activeWorkspaceRoot().trim(),
          targetWorkspaceId: targetWorkspaceId || null,
        },
      );
      const recoveredClient = targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient();
      if (!started || !recoveredClient) {
        deps.recordSendTrace(`${reason}:runtime-recovery-not-started`, {
          ...(tracePayload ?? {}),
          started,
          hasClient: Boolean(recoveredClient),
          targetWorkspaceId: targetWorkspaceId || null,
        });
        return {
          ok: false,
          runtimeReady: false,
          managedAiReady: false,
          workspaceId: resultWorkspaceId,
          activeWorkspace: targetIsActiveWorkspace,
          recoveryAttempted: true,
          reason: "runtime-recovery-not-started",
        };
      }
      deps.recordSendTrace(`${reason}:runtime-recovery-ok`, {
        ...(tracePayload ?? {}),
        hasClient: Boolean(recoveredClient),
        targetWorkspaceId: targetWorkspaceId || null,
      });
      if (preflight) preflight.runtimeHealthOk = true;
      if (preflight) preflight.forceRecovery = false;
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: false,
        workspaceId: resultWorkspaceId,
        activeWorkspace: targetIsActiveWorkspace,
        recoveryAttempted: true,
        reason: "runtime-recovery-ok",
      };
    } catch (error) {
      deps.recordSendTrace(`${reason}:runtime-recovery-error`, {
        ...(tracePayload ?? {}),
        message: errorMessage(error),
      });
      return {
        ok: false,
        runtimeReady: false,
        managedAiReady: false,
        workspaceId: resultWorkspaceId,
        activeWorkspace: targetIsActiveWorkspace,
        recoveryAttempted: true,
        reason: "runtime-recovery-error",
      };
    }
  }

  async function ensureLocalRuntimeReachableForSend(
    reason: string,
    preflightOrTraceId?: SendRuntimePreflightContext | string | null,
  ): Promise<boolean> {
    return (await ensureLocalRuntimeReachableForSendResult(reason, preflightOrTraceId)).ok;
  }

  async function prepareSendRuntimeForSend(
    reason: string,
    preflight: SendRuntimePreflightContext,
  ): Promise<SendRuntimePreparationResult> {
    const tracePayload = preflight.traceId ? { traceId: preflight.traceId } : undefined;
    const targetWorkspaceId = preflight.targetWorkspace?.workspaceId?.trim() ?? "";
    const targetWorkspace = targetWorkspaceId
      ? deps.workspaces().find((workspace) => workspace.id === targetWorkspaceId) ?? null
      : null;
    const workspaceType = targetWorkspace?.workspaceType ?? deps.activeWorkspaceDisplay().workspaceType;

    const runtimeResult = await deps.sendTraceStep(
      `${reason}:ensure-local-runtime-reachable`,
      () => ensureLocalRuntimeReachableForSendResult(reason, preflight),
      {
        ...(tracePayload ?? {}),
        activeWorkspaceId: deps.activeWorkspaceId().trim(),
        targetWorkspaceId: targetWorkspaceId || null,
        workspaceType,
        hasClient: Boolean(targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient()),
      },
    );
    if (!runtimeResult.ok) {
      deps.recordSendTrace(`${reason}:blocked-runtime-unreachable`, {
        ...(tracePayload ?? {}),
        runtimeReason: runtimeResult.reason,
        runtimeRecoveryAttempted: runtimeResult.recoveryAttempted,
        targetWorkspaceId: runtimeResult.workspaceId,
      });
      return runtimeResult;
    }
    preflight.enginePrepared = true;

    const managedAiReady = await deps.sendTraceStep(
      `${reason}:ensure-managed-ai-bootstrap-ready`,
      () => ensureManagedAiBootstrapReady(preflight),
      {
        ...(tracePayload ?? {}),
        managedAiBootstrapBusy: deps.managedAiBootstrapBusy(),
        reloadBusy: deps.reloadBusy(),
        hasClient: Boolean(targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient()),
      },
    );
    if (!managedAiReady) {
      deps.recordSendTrace(`${reason}:blocked-managed-ai-bootstrap`, tracePayload);
      return {
        ...runtimeResult,
        ok: false,
        runtimeReady: true,
        managedAiReady: false,
        reason: "managed-ai-bootstrap-blocked",
      };
    }
    preflight.managedAiReady = true;
    return {
      ...runtimeResult,
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
    };
  }

  async function connectLocalRuntimeClientFromEngineInfo(reason: string): Promise<Client | null> {
    if (!deps.isTauriRuntime() || deps.activeWorkspaceDisplay().workspaceType !== "local") {
      return deps.routedClient() ?? null;
    }

    try {
      const activeWorkspaceId = deps.activeWorkspaceId().trim();
      const activeWorkspaceRoot = deps.activeWorkspaceRoot().trim();
      const info = await deps.engineInfo(activeWorkspaceId || undefined, activeWorkspaceRoot || undefined);
      const nextBaseUrl = info.baseUrl?.trim() ?? "";
      if (!info.running || !nextBaseUrl) {
        deps.recordSendTrace(`${reason}:engine-info-unavailable`, {
          activeWorkspaceId: activeWorkspaceId || null,
          activeWorkspaceRoot: activeWorkspaceRoot || null,
          running: Boolean(info.running),
          engineState: info.engineState ?? null,
          hasBaseUrl: Boolean(nextBaseUrl),
        });
        return null;
      }

      const directory = info.projectDir?.trim() || activeWorkspaceRoot || deps.clientDirectory().trim() || undefined;
      const username = info.opencodeUsername?.trim() ?? "";
      const password = info.opencodePassword?.trim() ?? "";
      const auth = username && password ? { username, password } : undefined;
      const connected = await deps.connectToServer(
        nextBaseUrl,
        directory,
        {
          workspaceId: activeWorkspaceId || undefined,
          workspaceType: "local",
          targetRoot: directory,
          reason,
        },
        auth,
        { quiet: true, navigate: false, forceRefresh: true },
      );
      const nextClient = activeWorkspaceId ? deps.routedClient(activeWorkspaceId) : deps.routedClient();
      if (!connected || !nextClient) {
        deps.recordSendTrace(`${reason}:engine-info-connect-failed`, {
          activeWorkspaceId: activeWorkspaceId || null,
          activeWorkspaceRoot: activeWorkspaceRoot || null,
          hasClient: Boolean(nextClient),
        });
        return null;
      }
      deps.setEngineReady(true);
      deps.recordSendTrace(`${reason}:engine-info-client`, {
        activeWorkspaceId: activeWorkspaceId || null,
        activeWorkspaceRoot: activeWorkspaceRoot || null,
        hasDirectory: Boolean(directory),
        hasAuth: Boolean(auth),
      });
      return nextClient;
    } catch (error) {
      deps.recordSendTrace(`${reason}:engine-info-error`, {
        message: errorMessage(error),
      });
      return null;
    }
  }

  return {
    ensureManagedAiBootstrapReady,
    ensureLocalRuntimeReachableForSend,
    ensureLocalRuntimeReachableForSendResult,
    prepareSendRuntimeForSend,
    connectLocalRuntimeClientFromEngineInfo,
    messageFromUnknownError: errorMessage,
  };
}
