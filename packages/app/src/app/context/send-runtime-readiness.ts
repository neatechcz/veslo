export const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";

export type SendRuntimePreflightTargetWorkspace = {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
};

export type SendRuntimePreflightContext = {
  traceId?: string | null;
  runtimeHealthOk?: boolean;
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
  baseUrl?: string | null;
  projectDir?: string | null;
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
};

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

export type SendRuntimeReadinessDeps<Client extends SendRuntimeClient = SendRuntimeClient> = {
  isTauriRuntime: () => boolean;
  activeWorkspaceDisplay: () => SendRuntimeWorkspaceInfo;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  clientDirectory: () => string;
  workspaces: () => SendRuntimeWorkspaceInfo[];
  routedClient: (workspaceId?: string) => Client | null | undefined;
  ensureEngineForWorkspace: (workspaceId?: string) => Promise<boolean>;
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
  hasUsableManagedAiRuntimeConfigForSend: () => Promise<boolean>;
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
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
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
  return (
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

  const ensureManagedAiBootstrapReady = async (): Promise<boolean> => {
    try {
      const canUseCurrentManagedConfig =
        deps.managedAiAccessBusy() &&
        deps.managedAiBootstrapPendingCount() === 0 &&
        !deps.reloadBusy() &&
        (await deps.hasUsableManagedAiRuntimeConfigForSend());
      await deps.waitForManagedAiBootstrapReady({
        hasManagedProfile: (Boolean(deps.managedAiAccess()) || deps.managedAiBootstrapBusy()) && !canUseCurrentManagedConfig,
        isBootstrapBusy: deps.managedAiBootstrapBusy,
        isReloadBusy: deps.reloadBusy,
        hasClient: () => Boolean(deps.routedClient()),
      });
      return true;
    } catch (error) {
      deps.setError(errorMessage(error));
      return false;
    }
  };

  async function ensureLocalRuntimeReachableForSend(
    reason: string,
    preflightOrTraceId?: SendRuntimePreflightContext | string | null,
  ): Promise<boolean> {
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
    if (!deps.isTauriRuntime() || targetWorkspaceType !== "local") {
      deps.recordSendTrace(`${reason}:runtime-health-skipped`, {
        ...(tracePayload ?? {}),
        isTauriRuntime: deps.isTauriRuntime(),
        workspaceType: targetWorkspaceType,
        targetWorkspaceId: targetWorkspaceId || null,
      });
      return true;
    }

    const currentClient = targetWorkspaceId ? deps.routedClient(targetWorkspaceId) : deps.routedClient();
    if (preflight?.runtimeHealthOk) {
      deps.recordSendTrace(`${reason}:runtime-health-skip`, {
        ...(tracePayload ?? {}),
        reason: "send-preflight-already-healthy",
        targetWorkspaceId: targetWorkspaceId || null,
      });
      return true;
    }
    if (currentClient) {
      try {
        await deps.sendTraceStep(
          `${reason}:runtime-health`,
          () => withLocalRuntimeHealthTimeout(currentClient.global.health()),
          {
            ...(tracePayload ?? {}),
            hasClient: true,
            targetWorkspaceId: targetWorkspaceId || null,
          },
        );
        deps.recordSendTrace(`${reason}:runtime-health-ok`, tracePayload);
        if (preflight) preflight.runtimeHealthOk = true;
        return true;
      } catch (error) {
        const message = errorMessage(error);
        deps.recordSendTrace(`${reason}:runtime-health-error`, {
          ...(tracePayload ?? {}),
          message,
        });
        if (
          !isLocalRuntimeHealthTimeoutError(error, deps.safeStringify) &&
          !shouldRecoverLocalRuntimeFromHealthError(error, deps.safeStringify)
        ) {
          return true;
        }
      }
    } else {
      deps.recordSendTrace(`${reason}:runtime-missing-client`, tracePayload);
    }

    deps.recordSendTrace(`${reason}:runtime-recovery-start`, tracePayload);
    deps.setEngineReady(false);
    deps.setSseConnected(false);
    deps.setBusy(true);
    deps.setBusyLabel("status.connecting");
    deps.setBusyStartedAt(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const started = await deps.sendTraceStep(
        `${reason}:runtime-recovery-ensure-engine`,
        () => deps.ensureEngineForWorkspace(targetWorkspaceId || undefined),
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
        deps.setBusy(false);
        deps.setBusyLabel(null);
        deps.setBusyStartedAt(null);
        return false;
      }
      deps.recordSendTrace(`${reason}:runtime-recovery-ok`, {
        ...(tracePayload ?? {}),
        hasClient: Boolean(recoveredClient),
        targetWorkspaceId: targetWorkspaceId || null,
      });
      if (preflight) preflight.runtimeHealthOk = true;
      return true;
    } catch (error) {
      deps.recordSendTrace(`${reason}:runtime-recovery-error`, {
        ...(tracePayload ?? {}),
        message: errorMessage(error),
      });
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
      return false;
    }
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
    connectLocalRuntimeClientFromEngineInfo,
    messageFromUnknownError: errorMessage,
  };
}
