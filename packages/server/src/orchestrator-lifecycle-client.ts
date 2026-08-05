export type LifecycleRunStatus = "submitted" | "running" | "blocked" | "completed" | "failed" | "aborted";
export type LifecycleRunActivityKind = "local_tool" | "assistant_output" | "model_retry" | "idle" | "unknown";
export type LifecycleRunWaitReason =
  | "running_tool"
  | "model_retry_no_output"
  | "assistant_message_open"
  | "session_idle"
  | "engine_unreachable"
  | "none";
export type LifecycleRunUnavailableReason =
  | "no_current_engine"
  | "session_status_http"
  | "session_messages_missing"
  | "session_messages_http"
  | "request_timeout"
  | "request_transport_error";
export type LifecycleRunSessionStatusObservation = "busy" | "retry" | "explicit_idle" | "absent" | "unknown";
export type LifecycleRunFailureClassification =
  | "runtime_authorization_recovery_unavailable"
  | "runtime_authorization_recovery_mismatch";

export const ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER = "X-Veslo-Orchestrator-Token";

export type LifecycleRunStatusResult = {
  runId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  engineSessionId?: string | null;
  status: LifecycleRunStatus;
  stale: boolean;
  /**
   * A terminal transcript alone is not permission to admit its successor.
   * `false` means the exact OpenCode session is still busy; `true` means the
   * orchestrator observed it idle after the terminal result.
   */
  runtimeReadyForSuccessor?: boolean | null;
  engineSlotId?: string | null;
  engineOwnerId?: string | null;
  engineOwnerState?: "pending" | "attached" | "lost" | null;
  enginePid?: number | null;
  engineStartedAt?: number | null;
  engineBaseUrl?: string | null;
  error?: string | null;
  failureClassification?: LifecycleRunFailureClassification | null;
  clientMessageId?: string | null;
  opencodeMessageId?: string | null;
  origin?: string | null;
  directory?: string | null;
  expectsAiGatewayStart?: boolean;
  runtimeAuthorizationActorTokenHash?: string | null;
  runtimeAuthorizationOrgId?: string | null;
  gatewayRecoveryExpiresAt?: number | null;
  gatewayRecoveryState?: "active" | "terminal" | null;
  activityKind?: LifecycleRunActivityKind | null;
  waitReason?: LifecycleRunWaitReason | null;
  lastUsefulProgressAt?: number | null;
  retrySince?: number | null;
  noProgressSeconds?: number | null;
  unavailableReason?: LifecycleRunUnavailableReason | null;
  unavailableHttpStatus?: number | null;
  sessionStatusObserved?: LifecycleRunSessionStatusObservation | null;
};

export const ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS = 5_000;

const ACTIVITY_KINDS = new Set<LifecycleRunActivityKind>([
  "local_tool",
  "assistant_output",
  "model_retry",
  "idle",
  "unknown",
]);
const WAIT_REASONS = new Set<LifecycleRunWaitReason>([
  "running_tool",
  "model_retry_no_output",
  "assistant_message_open",
  "session_idle",
  "engine_unreachable",
  "none",
]);
const LIFECYCLE_RUN_STATUSES = new Set<LifecycleRunStatus>([
  "submitted",
  "running",
  "blocked",
  "completed",
  "failed",
  "aborted",
]);
const UNAVAILABLE_REASONS = new Set<LifecycleRunUnavailableReason>([
  "no_current_engine",
  "session_status_http",
  "session_messages_missing",
  "session_messages_http",
  "request_timeout",
  "request_transport_error",
]);
const SESSION_STATUS_OBSERVATIONS = new Set<LifecycleRunSessionStatusObservation>([
  "busy", "retry", "explicit_idle", "absent", "unknown",
]);

const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const optionalActivityKind = (value: unknown) =>
  typeof value === "string" && ACTIVITY_KINDS.has(value as LifecycleRunActivityKind)
    ? value as LifecycleRunActivityKind
    : null;

const optionalWaitReason = (value: unknown) =>
  typeof value === "string" && WAIT_REASONS.has(value as LifecycleRunWaitReason)
    ? value as LifecycleRunWaitReason
    : null;

export class RunAlreadyActiveError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("run_already_active");
    this.name = "RunAlreadyActiveError";
    this.activeRunId = activeRunId;
  }
}

export class OrchestratorLifecycleRequestError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`orchestrator lifecycle request failed: ${status}`);
    this.name = "OrchestratorLifecycleRequestError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export class OrchestratorLifecycleTimeoutError extends OrchestratorLifecycleRequestError {
  readonly timeoutMs: number;

  constructor(path: string, timeoutMs: number) {
    super(path, 504, { error: "request_timeout", timeoutMs });
    this.name = "OrchestratorLifecycleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type OrchestratorLifecycleClient = {
  register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    opencodeSessionId: string;
    clientMessageId?: string | null;
    opencodeMessageId?: string | null;
    origin?: string | null;
    expectsAiGatewayStart?: boolean;
    runtimeAuthorizationActorTokenHash?: string | null;
    runtimeAuthorizationOrgId?: string | null;
    directory: string;
    kind: string;
  }): Promise<LifecycleRunStatusResult | null>;
  markFailed(workspaceId: string, runId: string, error: string): Promise<void>;
  markAborted(workspaceId: string, runId: string, error?: string): Promise<void>;
  markAbortRequested(workspaceId: string, runId: string): Promise<void>;
  /**
   * Last-resort recovery for one terminal provider-start timeout whose exact
   * OpenCode session stayed busy after a successful abort acknowledgement.
   */
  recoverProviderStartTimeout(workspaceId: string, runId: string): Promise<LifecycleRunStatusResult | null>;
  /**
   * Releases a stale terminal owner only when the orchestrator proves that no
   * current engine exists. Unlike provider-start recovery, this never
   * suspends a running engine.
   */
  recoverTerminalRuntimeHandoff(workspaceId: string, runId: string): Promise<LifecycleRunStatusResult | null>;
  status(
    workspaceId: string,
    conversationId: string,
    runIdOrLatest: string,
  ): Promise<LifecycleRunStatusResult | null>;
  active(workspaceId: string, conversationId: string): Promise<LifecycleRunStatusResult | null>;
  activeGatewayRecovery?(workspaceId: string): Promise<LifecycleRunStatusResult[]>;
};

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function createOrchestratorLifecycleClient(options: {
  daemonUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): OrchestratorLifecycleClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.daemonUrl.replace(/\/+$/, "");
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.floor(options.timeoutMs ?? ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS)
    : ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS;
  const headers = {
    "Content-Type": "application/json",
    [ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER]: options.token,
  };

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // ignore abort errors; the timeout error below is the API surface
        }
        reject(new OrchestratorLifecycleTimeoutError(path, timeoutMs));
      }, timeoutMs);
    });
    const initWithSignal =
      controller && !init?.signal
        ? { ...init, signal: controller.signal }
        : init;

    try {
      return await Promise.race([
        fetchImpl(`${baseUrl}${path}`, initWithSignal),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof OrchestratorLifecycleTimeoutError) {
        throw error;
      }
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new OrchestratorLifecycleTimeoutError(path, timeoutMs);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const payload = await readJsonSafely(response) as { activeRunId?: unknown } | null;
      if (path.endsWith("/runs/register") && typeof payload?.activeRunId === "string") {
        throw new RunAlreadyActiveError(payload.activeRunId);
      }
      throw new OrchestratorLifecycleRequestError(path, response.status, payload);
    }
    if (!response.ok) {
      throw new OrchestratorLifecycleRequestError(path, response.status, await readJsonSafely(response));
    }
    return await readJsonSafely(response);
  };

  const parseLifecycleRunPayload = (path: string, payload: unknown): LifecycleRunStatusResult | null => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (
      typeof record.runId !== "string" ||
      !record.runId.trim() ||
      typeof record.status !== "string" ||
      !LIFECYCLE_RUN_STATUSES.has(record.status as LifecycleRunStatus)
    ) {
      throw new OrchestratorLifecycleRequestError(path, 502, payload);
    }
    const result: LifecycleRunStatusResult = {
      runId: record.runId,
      status: record.status as LifecycleRunStatus,
      stale: record.stale === true,
    };
    if (typeof record.workspaceId === "string") result.workspaceId = record.workspaceId;
    else if (record.workspaceId === null) result.workspaceId = null;
    if (typeof record.conversationId === "string") result.conversationId = record.conversationId;
    else if (record.conversationId === null) result.conversationId = null;
    if (typeof record.engineSessionId === "string") result.engineSessionId = record.engineSessionId;
    else if (record.engineSessionId === null) result.engineSessionId = null;
    if (record.runtimeReadyForSuccessor === true || record.runtimeReadyForSuccessor === false) {
      result.runtimeReadyForSuccessor = record.runtimeReadyForSuccessor;
    } else if (record.runtimeReadyForSuccessor === null) {
      result.runtimeReadyForSuccessor = null;
    }
    if (typeof record.engineSlotId === "string") result.engineSlotId = record.engineSlotId;
    else if (record.engineSlotId === null) result.engineSlotId = null;
    if (typeof record.engineOwnerId === "string") result.engineOwnerId = record.engineOwnerId;
    else if (record.engineOwnerId === null) result.engineOwnerId = null;
    if (record.engineOwnerState === "pending" || record.engineOwnerState === "attached" || record.engineOwnerState === "lost") {
      result.engineOwnerState = record.engineOwnerState;
    } else if (record.engineOwnerState === null) {
      result.engineOwnerState = null;
    }
    if (typeof record.enginePid === "number" && Number.isFinite(record.enginePid)) result.enginePid = record.enginePid;
    else if (record.enginePid === null) result.enginePid = null;
    if (typeof record.engineStartedAt === "number" && Number.isFinite(record.engineStartedAt)) result.engineStartedAt = record.engineStartedAt;
    else if (record.engineStartedAt === null) result.engineStartedAt = null;
    if (typeof record.engineBaseUrl === "string") result.engineBaseUrl = record.engineBaseUrl;
    else if (record.engineBaseUrl === null) result.engineBaseUrl = null;
    if ("error" in record) result.error = typeof record.error === "string" ? record.error : null;
    if (
      record.failureClassification === "runtime_authorization_recovery_unavailable" ||
      record.failureClassification === "runtime_authorization_recovery_mismatch"
    ) {
      result.failureClassification = record.failureClassification;
    } else if (record.failureClassification === null) {
      result.failureClassification = null;
    }
    if (typeof record.clientMessageId === "string") result.clientMessageId = record.clientMessageId;
    else if (record.clientMessageId === null) result.clientMessageId = null;
    if (typeof record.opencodeMessageId === "string") result.opencodeMessageId = record.opencodeMessageId;
    else if (record.opencodeMessageId === null) result.opencodeMessageId = null;
    if (typeof record.origin === "string") result.origin = record.origin;
    else if (record.origin === null) result.origin = null;
    if (typeof record.directory === "string") result.directory = record.directory;
    else if (record.directory === null) result.directory = null;
    if (record.expectsAiGatewayStart === true || record.expectsAiGatewayStart === false) {
      result.expectsAiGatewayStart = record.expectsAiGatewayStart;
    }
    if (typeof record.runtimeAuthorizationActorTokenHash === "string") {
      result.runtimeAuthorizationActorTokenHash = record.runtimeAuthorizationActorTokenHash;
    } else if (record.runtimeAuthorizationActorTokenHash === null) {
      result.runtimeAuthorizationActorTokenHash = null;
    }
    if (typeof record.runtimeAuthorizationOrgId === "string") result.runtimeAuthorizationOrgId = record.runtimeAuthorizationOrgId;
    else if (record.runtimeAuthorizationOrgId === null) result.runtimeAuthorizationOrgId = null;
    const gatewayRecoveryExpiresAt = optionalNumber(record.gatewayRecoveryExpiresAt);
    if (gatewayRecoveryExpiresAt !== null) result.gatewayRecoveryExpiresAt = gatewayRecoveryExpiresAt;
    else if (record.gatewayRecoveryExpiresAt === null) result.gatewayRecoveryExpiresAt = null;
    if (record.gatewayRecoveryState === "active" || record.gatewayRecoveryState === "terminal") {
      result.gatewayRecoveryState = record.gatewayRecoveryState;
    } else if (record.gatewayRecoveryState === null) {
      result.gatewayRecoveryState = null;
    }
    const activityKind = optionalActivityKind(record.activityKind);
    const waitReason = optionalWaitReason(record.waitReason);
    const lastUsefulProgressAt = optionalNumber(record.lastUsefulProgressAt);
    const retrySince = optionalNumber(record.retrySince);
    const noProgressSeconds = optionalNumber(record.noProgressSeconds);
    const unavailableReason = typeof record.unavailableReason === "string" &&
      UNAVAILABLE_REASONS.has(record.unavailableReason as LifecycleRunUnavailableReason)
      ? record.unavailableReason as LifecycleRunUnavailableReason
      : null;
    const unavailableHttpStatus = optionalNumber(record.unavailableHttpStatus);
    const sessionStatusObserved = typeof record.sessionStatusObserved === "string" &&
      SESSION_STATUS_OBSERVATIONS.has(record.sessionStatusObserved as LifecycleRunSessionStatusObservation)
      ? record.sessionStatusObserved as LifecycleRunSessionStatusObservation
      : null;
    if (activityKind) result.activityKind = activityKind;
    if (waitReason) result.waitReason = waitReason;
    if (lastUsefulProgressAt !== null) result.lastUsefulProgressAt = lastUsefulProgressAt;
    if (retrySince !== null) result.retrySince = retrySince;
    if (noProgressSeconds !== null) result.noProgressSeconds = noProgressSeconds;
    if (unavailableReason) result.unavailableReason = unavailableReason;
    else if (record.unavailableReason === null) result.unavailableReason = null;
    if (unavailableHttpStatus !== null) result.unavailableHttpStatus = unavailableHttpStatus;
    else if (record.unavailableHttpStatus === null) result.unavailableHttpStatus = null;
    if (sessionStatusObserved) result.sessionStatusObserved = sessionStatusObserved;
    else if (record.sessionStatusObserved === null) result.sessionStatusObserved = null;
    return result;
  };

  const getStatus = async (
    workspaceId: string,
    conversationId: string,
    runIdOrLatest: string,
  ): Promise<LifecycleRunStatusResult | null> => {
    const path = `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runIdOrLatest)}`;
    const response = await request(path, { headers });
    if (response.status === 404) {
      const body = await readJsonSafely(response);
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        (body as { error?: unknown }).error === "run not found"
      ) return null;
      throw new OrchestratorLifecycleRequestError(path, response.status, body);
    }
    if (!response.ok) {
      throw new OrchestratorLifecycleRequestError(path, response.status, await readJsonSafely(response));
    }
    const result = parseLifecycleRunPayload(path, await response.json());
    if (
      result &&
      runIdOrLatest !== "active" &&
      runIdOrLatest !== "latest" &&
      result.runId !== runIdOrLatest
    ) {
      throw new OrchestratorLifecycleRequestError(path, 502, result);
    }
    return result;
  };

  const activeGatewayRecovery = async (workspaceId: string): Promise<LifecycleRunStatusResult[]> => {
    const path = `/workspace/${encodeURIComponent(workspaceId)}/runs/active-gateway-recovery`;
    const response = await request(path, { headers });
    if (!response.ok) {
      throw new OrchestratorLifecycleRequestError(path, response.status, await readJsonSafely(response));
    }
    const payload = await readJsonSafely(response);
    const items = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { items?: unknown }).items
      : null;
    if (!Array.isArray(items)) throw new OrchestratorLifecycleRequestError(path, 502, payload);
    return items.map((item) => {
      const parsed = parseLifecycleRunPayload(path, item);
      if (!parsed) throw new OrchestratorLifecycleRequestError(path, 502, item);
      return parsed;
    });
  };

  return {
    async register(input) {
      const path = `/workspace/${encodeURIComponent(input.workspaceId)}/runs/register`;
      return parseLifecycleRunPayload(path, await post(path, {
        conversationId: input.conversationId,
        runId: input.runId,
        opencodeSessionId: input.opencodeSessionId,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.opencodeMessageId ? { opencodeMessageId: input.opencodeMessageId } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.expectsAiGatewayStart === true ? { expectsAiGatewayStart: true } : {}),
        ...(input.runtimeAuthorizationActorTokenHash
          ? { runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash }
          : {}),
        ...(input.runtimeAuthorizationOrgId ? { runtimeAuthorizationOrgId: input.runtimeAuthorizationOrgId } : {}),
        directory: input.directory,
        kind: input.kind,
      }));
    },

    async markFailed(workspaceId, runId, error) {
      await post(
        `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/failed`,
        { error },
      );
    },

    async markAborted(workspaceId, runId, error) {
      await post(
        `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/aborted`,
        error ? { error } : {},
      );
    },

    async markAbortRequested(workspaceId, runId) {
      await post(
        `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/abort-requested`,
        {},
      );
    },

    activeGatewayRecovery,

    async recoverProviderStartTimeout(workspaceId, runId) {
      const path = `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/recover-provider-start-timeout`;
      return parseLifecycleRunPayload(path, await post(path, {}));
    },

    async recoverTerminalRuntimeHandoff(workspaceId, runId) {
      const path = `/workspace/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/recover-terminal-runtime-handoff`;
      return parseLifecycleRunPayload(path, await post(path, {}));
    },

    async status(workspaceId, conversationId, runIdOrLatest) {
      return getStatus(workspaceId, conversationId, runIdOrLatest);
    },

    async active(workspaceId, conversationId) {
      return getStatus(workspaceId, conversationId, "active");
    },
  };
}
