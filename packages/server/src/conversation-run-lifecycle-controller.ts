import {
  ConversationRunQueueConflictError,
  ConversationRunReservationConflictError,
  type ConversationRunQueueItem,
  type ConversationRunQueueStore,
  type ConversationWorkspaceRuntimeOperation,
  type ConversationWorkspaceRuntimeOperationKind,
  type ConversationWorkspaceRunEngineOwner,
  type ConversationWorkspaceRunReservation,
} from "./conversation-run-queue-store.js";
import { ApiError } from "./errors.js";
import { lifecycleRequestApiError } from "./lifecycle-error-mapping.js";
import {
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
  type LifecycleRunStatus,
  type LifecycleRunStatusResult,
  type OrchestratorLifecycleClient,
} from "./orchestrator-lifecycle-client.js";
import { createConversationRunOpenCodeMessageId } from "./conversation-run-message-id.js";
import { createConversationRunCorrelation } from "./operation-correlation.js";
import { decideEngineLossAdmission } from "./conversation-run-admission-policy.js";
import { createKeyedLifecycleScheduler } from "./keyed-lifecycle-scheduler.js";
import {
  classifyExhaustedReconciliation,
  classifyReconciliationEvidence,
  isActiveLifecycleStatus,
  normalizeTerminalizationReasonCode,
  terminalizationErrorMessage,
  terminalizationMessageForReason,
  type TerminalizationReasonCode,
} from "./conversation-run-reconciliation-policy.js";
import type { OrchestratorWorkspaceRegistrationScope } from "./orchestrator-workspace-registration-scope.js";
import type { WorkspaceInfo } from "./types.js";

export type ConversationRunLifecycleKind = "prompt_async" | "command" | "shell" | "summarize";

export type ConversationRunLifecycleTracer = {
  entries: Array<Record<string, unknown>>;
  traceId: string | null;
  record(event: string, payload?: Record<string, unknown>): void;
  step<T>(event: string, fn: () => Promise<T>, payload?: Record<string, unknown>): Promise<T>;
};

export type ConversationRunLifecycleTarget = {
  directory: string;
  binding?: unknown | null;
  opencodeSessionId: string;
  conversationId: string;
};

export type ConversationRunLifecycleTimerPort = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
};

export type ConversationRunLifecycleTracePort = {
  record(event: string, payload?: Record<string, unknown>): void;
};

export type ConversationRunLifecycleSubmitOpenCodeInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  kind: ConversationRunLifecycleKind;
  body: Record<string, unknown>;
  clientMessageId: string | null;
  opencodeMessageId?: string | null;
  origin: string | null;
  orchestratorRegistrationScope?: OrchestratorWorkspaceRegistrationScope | null;
  captureEngineOwner?: (owner: ConversationWorkspaceRunEngineOwner) => void;
};

export type ConversationRunLifecycleSubmitOpenCodePort = (
  input: ConversationRunLifecycleSubmitOpenCodeInput,
) => Promise<unknown>;

export type ConversationRunLifecycleAiGatewayActiveRunInput = {
  traceId: string | null;
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  runtimeAuthorizationActorTokenHash: string | null;
  runtimeAuthorizationOrgId: string | null;
};

export type ConversationRunLifecycleAiGatewayActiveRunPort = {
  register(input: ConversationRunLifecycleAiGatewayActiveRunInput): void;
  unregister(input: Omit<
    ConversationRunLifecycleAiGatewayActiveRunInput,
    "traceId" | "clientMessageId" | "origin" | "runtimeAuthorizationActorTokenHash" | "runtimeAuthorizationOrgId"
  >): void;
};

export type ConversationRunLifecycleProviderStartWatchInput = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  startedAt: number;
};

export type ConversationRunLifecycleProviderStartWatchResult = {
  started: boolean;
  timeoutMs: number;
  providerHitScope?: "session" | "workspace" | "none";
  providerHitCount?: number;
  firstProviderHitAt?: number | null;
  lastProviderHitAt?: number | null;
};

export type ConversationRunLifecycleAiGatewayProviderWatchPort = {
  waitForProviderStart(
    input: ConversationRunLifecycleProviderStartWatchInput,
  ): Promise<ConversationRunLifecycleProviderStartWatchResult>;
};

export type ConversationRunLifecycleAbortOpenCodeInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
};

export type ConversationRunLifecycleAbortOpenCodePort = (
  input: ConversationRunLifecycleAbortOpenCodeInput,
) => Promise<unknown>;

export type ConversationRunLifecycleAbortActiveGatewayProxyRequestsInput = {
  workspaceId: string;
  runId: string;
  sessionId: string;
  reason: string;
};

export type ConversationRunLifecycleAbortActiveGatewayProxyRequestsPort = (
  input: ConversationRunLifecycleAbortActiveGatewayProxyRequestsInput,
) => unknown[];

export type ConversationRunLifecycleScheduleReconcileInput = {
  workspace: WorkspaceInfo;
  conversationId: string;
  runId: string;
  directory?: string | null;
  opencodeSessionId?: string | null;
  reason: string;
  abortRequested?: boolean;
  /**
   * A server-owned failure reason that may be written only after the exact
   * engine owner is observed terminal. It is never a timeout-based assertion.
   */
  terminalFailureReason?: string | null;
  delayMs?: number;
  attempt?: number;
  /**
   * Set only when the caller already holds orchestrator proof that this exact
   * run is terminal and its engine owner is lost. It suppresses the
   * provider-start abort deferral, which would otherwise keep retrying a
   * provider start against an engine that is known to be gone. It never
   * authorizes a release on its own: reconciliation still re-reads the
   * lifecycle record and decides from that fresh status.
   */
  predecessorReleaseProven?: boolean;
};

export type ConversationRunLifecycleSubmitQueuePolicy = "normal" | "send-now" | "server-queue-only";

export type ConversationRunLifecycleSubmitInput = {
  runTrace: ConversationRunLifecycleTracer;
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  kind: ConversationRunLifecycleKind;
  body: Record<string, unknown>;
  clientMessageId: string | null;
  /** Durable server queue identity, present only while draining a queued intent. */
  queueItemId?: string | null;
  opencodeMessageId?: string | null;
  origin: string | null;
  orchestratorRegistrationScope?: OrchestratorWorkspaceRegistrationScope | null;
  submitQueuePolicy?: ConversationRunLifecycleSubmitQueuePolicy;
  expectAiGatewayStart: boolean;
  runtimeAuthorizationActorTokenHash?: string | null;
  runtimeAuthorizationOrgId?: string | null;
};

export type ConversationRunLifecycleSubmitResult = {
  httpStatus: number;
  payload: Record<string, unknown>;
};

export type ConversationRunLifecycleAbortInput = {
  workspace: WorkspaceInfo;
  target: ConversationRunLifecycleTarget;
  runId: string;
  /** A server-owned fail-closed reason; unlike an interactive abort it records failed. */
  terminalFailureReason?: string | null;
};

export type ConversationRunLifecycleAbortResult = {
  upstream: unknown;
  abortedGatewayRequestCount: number;
};

export type ConversationRunEngineLossNotification = {
  eventId: string;
  workspaceId: string;
  engineSlotId: string;
  engineOwnerId: string;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
  runIds: string[];
  reason: string;
};

export type ConversationRunEngineLossResult = {
  eventId: string;
  acceptedRunIds: string[];
  ignoredRunIds: string[];
  drainedConversations: string[];
  duplicate: boolean;
};

export type ConversationRunLifecycleControllerOptions = {
  lifecycleClient?: OrchestratorLifecycleClient | null;
  queueStore?: ConversationRunQueueStore | null;
  resolveWorkspace?: (workspaceId: string) => WorkspaceInfo | null;
  createBackgroundRunTrace?: () => ConversationRunLifecycleTracer;
  submitOpenCode?: ConversationRunLifecycleSubmitOpenCodePort | null;
  abortOpenCode?: ConversationRunLifecycleAbortOpenCodePort | null;
  abortActiveGatewayProxyRequests?: ConversationRunLifecycleAbortActiveGatewayProxyRequestsPort | null;
  aiGatewayActiveRun?: ConversationRunLifecycleAiGatewayActiveRunPort | null;
  aiGatewayProviderWatch?: ConversationRunLifecycleAiGatewayProviderWatchPort | null;
  queueDrainPollMs?: number;
  resolveLifecycleReconcileInitialDelayMs?: () => number;
  resolveLifecycleReconcilePollMs?: () => number;
  resolveLifecycleReconcileMaxAttempts?: () => number;
  // An engine-loss callback can arrive just before the upstream response
  // exposes the engine owner. Keep that narrowly-scoped evidence only long
  // enough for the same request to persist its owner.
  resolveEngineOwnerAttachGraceMs?: () => number;
  ingestTerminalTranscript?: (input: {
    workspace: WorkspaceInfo;
    directory: string;
    opencodeSessionId: string;
    runId: string;
  }) => Promise<{ kind: "persisted" | "unchanged" | "incomplete" | "exhausted" } | void>;
  onTerminalTranscriptRecovery?: (input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    lifecycle: LifecycleRunStatus;
    canonicalRecovery: "recovered" | "unavailable" | "failed";
  }) => void;
  persistPromptIdentity?: (input: ConversationRunLifecycleSubmitInput) => void;
  timers?: Partial<ConversationRunLifecycleTimerPort>;
  trace?: ConversationRunLifecycleTracePort | null;
  diagnostics?: {
    intervalMs?: number | null;
  };
};

export type ConversationRunLifecycleSnapshot = {
  started: boolean;
  activeTimerCount: number;
  diagnostics: {
    enabled: boolean;
    intervalMs: number | null;
    runs: number;
  };
  lifecycle: {
    pendingQueueDrains: Array<{ workspaceId: string; conversationId: string }>;
    pendingLifecycleReconciles: Array<{ workspaceId: string; conversationId: string; runId: string }>;
    inFlightQueueDrains: Array<{ workspaceId: string; conversationId: string }>;
    inFlightLifecycleReconciles: Array<{ workspaceId: string; conversationId: string; runId: string }>;
  };
  ports: {
    lifecycleClient: boolean;
    queueStore: boolean;
    submitOpenCode: boolean;
    aiGatewayProviderWatch: boolean;
  };
};

export type ConversationRunLifecycleRuntimeOperationRequest = {
  workspaceId: string;
  operationId?: string;
  kind: ConversationWorkspaceRuntimeOperationKind;
  sourceClass: ConversationWorkspaceRuntimeOperation["sourceClass"];
  reasonCode: string;
  expiresAt: number;
};

export type ConversationRunLifecycleRuntimeOperationResult =
  | { kind: "granted"; operation: ConversationWorkspaceRuntimeOperation }
  | {
    kind: "blocked";
    reason: "active-runs" | "reconciliation-pending" | "runtime-operation";
    operation?: ConversationWorkspaceRuntimeOperation;
  };

export type ConversationRunLifecycleController = {
  submitRun(input: ConversationRunLifecycleSubmitInput): Promise<ConversationRunLifecycleSubmitResult>;
  submitAcceptedRun(
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
  ): Promise<unknown>;
  scheduleQueueDrain(
    workspaceId: string,
    conversationId: string,
    delayMs?: number,
  ): void;
  drainConversationQueue(workspaceId: string, conversationId: string): Promise<void>;
  scheduleLifecycleReconcile(input: ConversationRunLifecycleScheduleReconcileInput): void;
  reconcileConversationRunLifecycle(input: ConversationRunLifecycleScheduleReconcileInput): Promise<void>;
  retryTerminalRuntimeHandoff(input: ConversationRunLifecycleScheduleReconcileInput): Promise<boolean>;
  abortRun(input: ConversationRunLifecycleAbortInput): Promise<ConversationRunLifecycleAbortResult>;
  notifyEngineLoss(input: ConversationRunEngineLossNotification): ConversationRunEngineLossResult;
  reloadWorkspaceEngineIfIdle(input: {
    workspaceId: string;
    reload: () => Promise<void>;
  }): Promise<{ kind: "reloaded" } | { kind: "blocked"; reason: "active-runs" | "reconciliation-pending" }>;
  requestWorkspaceRuntimeOperation(
    input: ConversationRunLifecycleRuntimeOperationRequest,
  ): Promise<ConversationRunLifecycleRuntimeOperationResult>;
  beginWorkspaceRuntimeOperation(
    workspaceId: string,
    operationId: string,
  ): Promise<ConversationWorkspaceRuntimeOperation | null>;
  completeWorkspaceRuntimeOperation(input: {
    workspaceId: string;
    operationId: string;
    state: Extract<ConversationWorkspaceRuntimeOperation["state"], "completed" | "failed" | "outcome_unknown">;
    terminalCode?: string | null;
  }): Promise<ConversationWorkspaceRuntimeOperation | null>;
  subscribeWorkspaceIdle(listener: (workspaceId: string) => void): () => void;
  start(): void;
  stop(): void;
  snapshotForTests(): ConversationRunLifecycleSnapshot;
};

const STARTUP_ORPHANED_ASSISTANT_MESSAGE_GRACE_MS = 60_000;
const ENGINE_UNREACHABLE_GRACE_MS = 60_000;
const PROVIDER_START_ABORT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const PROVIDER_START_ABORT_MAX_ATTEMPTS = PROVIDER_START_ABORT_RETRY_DELAYS_MS.length;
const PROVIDER_START_ABORT_RECOVERY_WINDOW_MS = 120_000;
const PROVIDER_START_ABORT_RETRY_REASON = "ai-gateway-provider-start-timeout-abort-retry";
const PROVIDER_START_ABORT_RECOVERY_EXHAUSTED_REASON = "ai-gateway-provider-start-timeout-abort-recovery-exhausted";
const PROVIDER_START_ABORT_RECOVERY_TIMEOUT_MS = 30_000;
// A provider-start timeout has already proved that no managed-AI request was
// dispatched, and the exact OpenCode abort plus terminal lifecycle write have
// both succeeded. Ask the lifecycle owner to recover immediately; it repeats
// the exact-engine and active-peer checks before it can suspend anything.
const PROVIDER_START_TERMINAL_HANDOFF_RECOVERY_ATTEMPT = 1;
// A recovery can be refused while a peer still owns the exact engine, or can
// lose a short-lived transport race. Retry only a small bounded number of
// times; the normal terminal handoff poll remains the durable fallback.
const PROVIDER_START_TERMINAL_HANDOFF_RECOVERY_MAX_ATTEMPTS = 3;
const ENGINE_OWNER_ATTACH_GRACE_DEFAULT_MS = 80_000;
// A conflicting predecessor is often still draining its provider-start abort
// budget (5s + 10s + 20s), which at the queue-drain cadence is roughly 24
// conflicts. Stay clearly above that so this cap only ever catches a runtime
// record that no existing recovery is still working on.
const QUEUE_DRAIN_RESERVATION_CONFLICT_MAX_ATTEMPTS = 40;

class ConversationRunPromptIdentityPersistenceError extends ApiError {
  constructor(error: unknown) {
    if (error instanceof ApiError) {
      super(error.status, error.code, error.message, error.details);
      return;
    }
    super(
      503,
      "prompt_identity_persistence_failed",
      "Prompt identity could not be persisted before dispatch.",
      { recoverable: true },
    );
  }
}

function withOpenCodeAdmissionMessageId(
  input: ConversationRunLifecycleSubmitInput,
  timestamp = Date.now(),
): ConversationRunLifecycleSubmitInput {
  if (input.kind !== "prompt_async" || !input.clientMessageId?.trim()) return input;
  if (input.opencodeMessageId?.trim()) return input;
  return {
    ...input,
    opencodeMessageId: createConversationRunOpenCodeMessageId({
      workspaceId: input.workspace.id,
      engineSessionId: input.target.opencodeSessionId,
      clientMessageId: input.clientMessageId,
      runId: input.runId,
      timestamp,
    }),
  };
}

function lifecycleRunKind(kind: ConversationRunLifecycleKind) {
  return kind === "prompt_async" ? "prompt" : kind;
}

function parseQueuedRunKind(kind: string): ConversationRunLifecycleKind {
  if (kind === "prompt_async" || kind === "command" || kind === "shell" || kind === "summarize") {
    return kind;
  }
  throw new Error("queued run kind must be prompt_async, command, shell, or summarize");
}

function optionalBodyBoolean(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === "boolean" ? value : null;
}

function optionalBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIntervalMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeNonNegativeDelayMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function sortQueueDiagnostics(
  entries: Array<{ workspaceId: string; conversationId: string }>,
): Array<{ workspaceId: string; conversationId: string }> {
  return entries.sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) || a.conversationId.localeCompare(b.conversationId)
  );
}

function sortReconcileDiagnostics(
  entries: Array<{ workspaceId: string; conversationId: string; runId: string }>,
): Array<{ workspaceId: string; conversationId: string; runId: string }> {
  return entries.sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) ||
    a.conversationId.localeCompare(b.conversationId) ||
    a.runId.localeCompare(b.runId)
  );
}

function queueDiagnosticsFromKeys(keys: Iterable<string>): Array<{ workspaceId: string; conversationId: string }> {
  const entries: Array<{ workspaceId: string; conversationId: string }> = [];
  for (const key of keys) {
    const [workspaceId, conversationId] = key.split("\0");
    if (!workspaceId || !conversationId) continue;
    entries.push({ workspaceId, conversationId });
  }
  return sortQueueDiagnostics(entries);
}

function reconcileDiagnosticsFromKeys(
  keys: Iterable<string>,
): Array<{ workspaceId: string; conversationId: string; runId: string }> {
  const entries: Array<{ workspaceId: string; conversationId: string; runId: string }> = [];
  for (const key of keys) {
    const [workspaceId, conversationId, runId] = key.split("\0");
    if (!workspaceId || !conversationId || !runId) continue;
    entries.push({ workspaceId, conversationId, runId });
  }
  return sortReconcileDiagnostics(entries);
}

function lifecycleStatusTraceFields(
  status: LifecycleRunStatusResult | null | undefined,
): Record<string, unknown> {
  const rawError = status?.error?.trim() ?? "";
  // Terminal OpenCode/provider messages are operationally valuable, but must
  // remain safe for the always-on local workflow trace. Keep the bounded
  // reason while masking the common credential-bearing assignment forms.
  const terminalError = rawError
    ? rawError
      .replace(/\b(bearer|authorization|token|api[_-]?key|password)\b\s*(?:=|:)?\s*(?:bearer\s+|basic\s+)?\S+/gi, "$1=[redacted]")
      .slice(0, 300)
    : null;
  return {
    terminalError,
    failureClassification: status?.failureClassification ?? null,
    runtimeReadyForSuccessor: status?.runtimeReadyForSuccessor ?? null,
    clientMessageId: status?.clientMessageId ?? null,
    origin: status?.origin ?? null,
    engineSlotId: status?.engineSlotId ?? null,
    engineOwnerId: status?.engineOwnerId ?? null,
    engineOwnerState: status?.engineOwnerState ?? null,
    enginePid: status?.enginePid ?? null,
    engineStartedAt: status?.engineStartedAt ?? null,
    activityKind: status?.activityKind ?? null,
    waitReason: status?.waitReason ?? null,
    lastUsefulProgressAt: status?.lastUsefulProgressAt ?? null,
    retrySince: status?.retrySince ?? null,
    noProgressSeconds: status?.noProgressSeconds ?? null,
    unavailableReason: status?.unavailableReason ?? null,
    unavailableHttpStatus: status?.unavailableHttpStatus ?? null,
    sessionStatusObserved: status?.sessionStatusObserved ?? null,
  };
}

function lifecycleErrorKind(error: unknown): string {
  if (error instanceof OrchestratorLifecycleRequestError) {
    return error.status === 504 ? "lifecycle_timeout" : "lifecycle_request_failed";
  }
  return error instanceof Error ? error.name : "unknown_error";
}

function lifecycleErrorReason(error: unknown): string {
  if (!(error instanceof OrchestratorLifecycleRequestError)) return lifecycleErrorKind(error);
  const body = error.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return lifecycleErrorKind(error);
  const reason = (body as { reason?: unknown }).reason;
  if (typeof reason === "string" && /^[a-z0-9_:-]{1,120}$/i.test(reason)) return reason;
  const code = (body as { error?: unknown }).error;
  if (typeof code === "string" && /^[a-z0-9_:-]{1,120}$/i.test(code)) return code;
  return lifecycleErrorKind(error);
}

function lifecycleErrorEvidenceKind(error: unknown): string | null {
  if (!(error instanceof OrchestratorLifecycleRequestError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const evidenceKind = (body as { evidenceKind?: unknown }).evidenceKind;
  return typeof evidenceKind === "string" && /^[a-z_]{1,64}$/.test(evidenceKind)
    ? evidenceKind
    : null;
}

function lifecycleErrorHttpStatus(error: unknown): number | null {
  return error instanceof OrchestratorLifecycleRequestError ? error.status : null;
}

const NO_OUTPUT_MODEL_RETRY_BACKGROUND_POLL_MS = 30_000;

function createNoopRunTrace(): ConversationRunLifecycleTracer {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    traceId: null,
    record(event: string, payload: Record<string, unknown> = {}) {
      entries.push({ event, ...payload });
    },
    async step<T>(_event: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

export function createConversationRunLifecycleController(
  options: ConversationRunLifecycleControllerOptions = {},
): ConversationRunLifecycleController {
  const scheduleTimeout = options.timers?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduledTimeout = options.timers?.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const unrefTimer = options.timers?.unref ??
    ((handle) => (handle as { unref?: () => void } | null | undefined)?.unref?.());
  const diagnosticsIntervalMs = normalizeIntervalMs(options.diagnostics?.intervalMs);
  const queueDrainPollMs = normalizeIntervalMs(options.queueDrainPollMs) ?? 1_500;
  const activeTimers = new Set<unknown>();
  const queueDrainTimers = new Map<string, unknown>();
  const queueDrainInFlight = new Set<string>();
  // A queued conversation is polled while its owner is active. Remember only
  // its current blocking decision so trace files show why it waits without
  // repeating the identical decision on every poll.
  const queueDrainBlockingDecisions = new Map<string, string>();
  const queueDrainReservationConflicts = new Map<string, number>();
  const lifecycleReconcileTimers = new Map<string, unknown>();
  const lifecycleReconcileInFlight = new Set<string>();
  const terminalizationTimers = new Map<string, unknown>();
  const startingRecoveryTimers = new Map<string, unknown>();
  const workspaceExecutionGateTails = new Map<string, Promise<void>>();
  const workspaceRunReservations = new Map<string, Map<string, ConversationWorkspaceRunReservation>>();
  const workspaceReconciliationPending = new Set<string>();
  const workspaceIdleListeners = new Set<(workspaceId: string) => void>();
  const engineLossEvents = new Map<string, ConversationRunEngineLossResult>();
  const pendingEngineLosses = new Map<string, ConversationRunEngineLossNotification>();
  const pendingEngineLossTimers = new Map<string, unknown>();
  const persistPromptIdentity = (input: ConversationRunLifecycleSubmitInput) => {
    if (input.kind !== "prompt_async") return;
    try {
      if (!options.persistPromptIdentity) {
        throw new Error("Prompt identity persistence is required for admitted prompt runs");
      }
      options.persistPromptIdentity(input);
    } catch (error) {
      throw new ConversationRunPromptIdentityPersistenceError(error);
    }
  };
  const providerStartAbortRecoveries = new Map<string, {
    input: ConversationRunLifecycleSubmitInput;
    lifecycleOwner: OrchestratorLifecycleClient;
    timeoutMs: number;
    attempts: number;
    deadlineAt: number;
    lastError: string | null;
    nextAttemptAt?: number | null;
  }>();
  const providerStartHandoffRecoveryAttempts = new Map<string, number>();
  // A stale terminal record can survive a previous daemon generation. Ask the
  // orchestrator once to prove that its old owner is gone; repeated polling
  // must not become repeated destructive recovery requests.
  const staleTerminalHandoffRecoveryAttempts = new Map<string, number>();
  let started = false;
  let diagnosticsRuns = 0;

  const recordTrace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.record(event, payload);
  };

  const keyedScheduler = createKeyedLifecycleScheduler({
    timers: { setTimeout: scheduleTimeout, clearTimeout: clearScheduledTimeout, unref: unrefTimer },
    onTimerScheduled: (handle) => activeTimers.add(handle),
    onTimerCleared: (handle) => activeTimers.delete(handle),
    onTimerFired: (entry) => recordTrace("server:conversation-run:scheduler-wake", {
      namespace: entry.namespace,
      key: entry.key,
      delayMs: entry.delayMs,
      reason: entry.reason ?? null,
      attempt: entry.attempt ?? null,
    }),
    onCallbackError: (entry, error) => recordTrace("server:conversation-run:scheduler-callback-error", {
      namespace: entry.namespace,
      key: entry.key,
      message: error instanceof Error ? error.message : String(error),
    }),
  });

  const normalizeWorkspaceExecutionKey = (workspaceId: string) => workspaceId.trim();
  const providerStartAbortRecoveryKey = (workspaceId: string, conversationId: string, runId: string) =>
    `${normalizeWorkspaceExecutionKey(workspaceId)}\0${conversationId.trim()}\0${runId.trim()}`;

  const scheduleUnconfirmedRegistrationRecovery = (
    input: ConversationRunLifecycleSubmitInput,
    reason: string,
  ) => {
    input.runTrace.record("server:conversation-run:lifecycle-register-unconfirmed", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      reason,
    });
    scheduleLifecycleReconcile({
      workspace: input.workspace,
      conversationId: input.target.conversationId,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      reason,
      delayMs: 0,
    });
  };

  const withWorkspaceExecutionGate = async <T>(workspaceIdRaw: string, run: () => Promise<T>): Promise<T> => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    if (!workspaceId) return run();
    const previous = workspaceExecutionGateTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    workspaceExecutionGateTails.set(workspaceId, tail);
    void tail.then(() => {
      if (workspaceExecutionGateTails.get(workspaceId) === tail) {
        workspaceExecutionGateTails.delete(workspaceId);
      }
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };

  const reservationsForWorkspace = (workspaceIdRaw: string) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    let reservations = workspaceRunReservations.get(workspaceId);
    if (!reservations) {
      reservations = new Map();
      workspaceRunReservations.set(workspaceId, reservations);
    }
    return reservations;
  };

  const reserveStarting = (input: Pick<
    ConversationRunLifecycleSubmitInput,
    "workspace" | "target" | "runId" | "runTrace"
  >) => {
    const workspaceId = normalizeWorkspaceExecutionKey(input.workspace.id);
    const runId = input.runId.trim();
    if (!workspaceId || !runId) return;
    const reservation = options.queueStore?.reserveWorkspaceRun({
      workspaceId,
      conversationId: input.target.conversationId,
      runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      state: "starting",
    }) ?? {
      workspaceId,
      conversationId: input.target.conversationId,
      runId,
      state: "starting" as const,
      engineSlotId: null,
      engineOwnerId: null,
      directoryInstanceEpoch: null,
      enginePid: null,
      engineStartedAt: null,
      engineBaseUrl: null,
      skillViewRevision: null,
      authorizationRevision: null,
      openCodeConfigDigest: null,
      terminalizationReason: null,
      terminalizationAttempts: 0,
      terminalizationLastError: null,
      terminalizationNextAttemptAt: null,
      terminalizationDeadlineAt: null,
      terminalHandoffReason: null,
      terminalHandoffFingerprint: null,
      terminalHandoffAttempts: 0,
      terminalHandoffRequestedAt: null,
      terminalHandoffDecidedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    reservationsForWorkspace(workspaceId).set(runId, reservation);
    workspaceReconciliationPending.delete(workspaceId);
    input.runTrace.record("server:conversation-run:workspace-reserved", {
      workspaceId,
      conversationId: input.target.conversationId,
      runId,
      state: reservation.state,
    });
  };

  const terminalHandoffFingerprint = (
    workspaceId: string,
    runId: string,
    status: LifecycleRunStatusResult,
  ): string => [
    normalizeWorkspaceExecutionKey(workspaceId),
    runId.trim(),
    status.runId.trim(),
    status.engineOwnerId?.trim() ?? "",
    status.enginePid ?? "",
    status.engineStartedAt ?? "",
    status.unavailableReason ?? "",
  ].join("\0");

  const persistTerminalHandoffPending = (input: {
    workspaceId: string;
    runId: string;
    status: LifecycleRunStatusResult;
  }): ConversationWorkspaceRunReservation | null => {
    const fingerprint = terminalHandoffFingerprint(input.workspaceId, input.runId, input.status);
    const reservations = reservationsForWorkspace(input.workspaceId);
    const previous = reservations.get(input.runId);
    const next = options.queueStore?.markWorkspaceRunTerminalHandoffPending({
      workspaceId: input.workspaceId,
      runId: input.runId,
      reason: input.status.unavailableReason ?? "unknown",
      fingerprint,
      attempts: Math.max(1, (previous?.terminalHandoffAttempts ?? 0) + 1),
    }) ?? (previous ? {
      ...previous,
      state: "terminal_handoff_pending" as const,
      terminalHandoffReason: input.status.unavailableReason ?? "unknown",
      terminalHandoffFingerprint: fingerprint,
      terminalHandoffAttempts: Math.max(1, (previous.terminalHandoffAttempts ?? 0) + 1),
      terminalHandoffRequestedAt: Date.now(),
      terminalHandoffDecidedAt: null,
      updatedAt: Date.now(),
    } : null);
    if (next) reservations.set(input.runId, next);
    return next;
  };

  const terminalHandoffBarrier = (workspaceId: string, conversationId: string, runId: string) =>
    options.queueStore?.getTerminalHandoffBarrier(workspaceId, conversationId, runId) ?? null;

  const markTerminalHandoffBarrierUnresolved = (input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    reason: string;
  }) => options.queueStore?.markTerminalHandoffBarrierUnresolved(input) ?? null;

  const persistTerminalHandoffUnresolved = (input: {
    workspaceId: string;
    runId: string;
    status: LifecycleRunStatusResult;
    reason: string;
  }): ConversationWorkspaceRunReservation | null => {
    const fingerprint = terminalHandoffFingerprint(input.workspaceId, input.runId, input.status);
    const reservations = reservationsForWorkspace(input.workspaceId);
    const previous = reservations.get(input.runId);
    const next = options.queueStore?.markWorkspaceRunTerminalHandoffUnresolved({
      workspaceId: input.workspaceId,
      runId: input.runId,
      reason: input.reason,
      fingerprint,
      attempts: Math.max(1, previous?.terminalHandoffAttempts ?? 1),
    }) ?? (previous ? {
      ...previous,
      state: "terminal_handoff_unresolved" as const,
      terminalHandoffReason: input.reason,
      terminalHandoffFingerprint: fingerprint,
      terminalHandoffAttempts: Math.max(1, previous.terminalHandoffAttempts ?? 1),
      terminalHandoffDecidedAt: Date.now(),
      updatedAt: Date.now(),
    } : null);
    if (next) reservations.set(input.runId, next);
    return next;
  };

  const restoreReservedRunForHandoff = (workspaceIdRaw: string, runIdRaw: string) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    const runId = runIdRaw.trim();
    if (!workspaceId || !runId) return;
    const next = options.queueStore?.activateWorkspaceRun(workspaceId, runId);
    const reservations = reservationsForWorkspace(workspaceId);
    const previous = reservations.get(runId);
    if (next) {
      reservations.set(runId, next);
    } else if (previous) {
      reservations.set(runId, { ...previous, state: "active", updatedAt: Date.now() });
    }
  };

  const activeWorkspaceRuntimeOperation = (workspaceIdRaw: string) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    if (!workspaceId) return null;
    const operation = options.queueStore?.getWorkspaceRuntimeOperation(workspaceId) ?? null;
    if (!operation) return null;
    if (
      (operation.state === "granted" || operation.state === "executing") &&
      operation.expiresAt > Date.now()
    ) {
      return operation;
    }
    if (operation.state === "granted" || operation.state === "executing") {
      // Expiry is a durable outcome, not merely an in-memory admission hint.
      // A crashed desktop can therefore never leave a permanent invisible gate.
      options.queueStore?.expireWorkspaceRuntimeOperations();
      return options.queueStore?.getWorkspaceRuntimeOperation(workspaceId) ?? null;
    }
    // `outcome_unknown` is deliberately still an admission fence. The next
    // explicit recovery request may replace it only after it rechecks the
    // workspace gate and reservation state; a queued user message must not
    // turn an unconfirmed rebind into a new runtime dispatch.
    return operation.state === "outcome_unknown"
      ? operation
      : null;
  };

  const activateReservedRun = (input: ConversationRunLifecycleSubmitInput) => {
    restoreReservedRunForHandoff(input.workspace.id, input.runId);
  };

  const notifyWorkspaceIdle = (workspaceId: string) => {
    for (const listener of workspaceIdleListeners) {
      try {
        listener(workspaceId);
      } catch (error) {
        recordTrace("server:conversation-run:workspace-idle-listener-error", {
          workspaceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const attachReservedRunEngineOwner = (
    workspaceIdRaw: string,
    runIdRaw: string,
    owner: ConversationWorkspaceRunEngineOwner,
  ): boolean => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    const runId = runIdRaw.trim();
    if (!workspaceId || !runId) return false;
    const reservations = reservationsForWorkspace(workspaceId);
    const current = reservations.get(runId);
    if (!current) return false;
    const pendingKey = `${workspaceId}\0${runId}`;
    const pendingLoss = pendingEngineLosses.get(pendingKey);
    if (pendingLoss && decideEngineLossAdmission({ ...current, ...owner }, pendingLoss).kind === "release-matching-owner") {
      clearPendingEngineLoss(pendingKey);
      releaseRun(workspaceId, runId, "engine-loss-before-owner-persisted");
      scheduleQueueDrain(workspaceId, current.conversationId, 0);
      return false;
    }
    const attached = options.queueStore?.attachWorkspaceRunEngineOwner(workspaceId, runId, owner) ?? {
      ...current,
      ...owner,
      updatedAt: Date.now(),
    };
    if (!attached) return false;
    reservations.set(runId, attached);
    return true;
  };

  const releaseRun = (workspaceIdRaw: string, runIdRaw: string, reason: string) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    const runId = runIdRaw.trim();
    if (!workspaceId || !runId) return false;
    clearPendingEngineLoss(`${workspaceId}\0${runId}`);
    for (const [key, recovery] of providerStartAbortRecoveries) {
      if (normalizeWorkspaceExecutionKey(recovery.input.workspace.id) === workspaceId && recovery.input.runId === runId) {
        providerStartAbortRecoveries.delete(key);
      }
    }
    for (const key of providerStartHandoffRecoveryAttempts.keys()) {
      if (key.startsWith(`${workspaceId}\0`) && key.endsWith(`\0${runId}`)) {
        providerStartHandoffRecoveryAttempts.delete(key);
      }
    }
    for (const key of staleTerminalHandoffRecoveryAttempts.keys()) {
      if (key.startsWith(`${workspaceId}\0`) && key.endsWith(`\0${runId}`)) {
        staleTerminalHandoffRecoveryAttempts.delete(key);
      }
    }
    const reservations = workspaceRunReservations.get(workspaceId);
    const existed = reservations?.delete(runId) === true;
    if (reservations?.size === 0) {
      workspaceRunReservations.delete(workspaceId);
      workspaceReconciliationPending.delete(workspaceId);
      notifyWorkspaceIdle(workspaceId);
    }
    const persisted = options.queueStore?.releaseWorkspaceRun(workspaceId, runId) ?? false;
    void reason;
    return existed || persisted;
  };

  const notifyEngineLoss = (input: ConversationRunEngineLossNotification): ConversationRunEngineLossResult => {
    const eventId = input.eventId.trim();
    const workspaceId = normalizeWorkspaceExecutionKey(input.workspaceId);
    const cached = eventId ? engineLossEvents.get(eventId) : undefined;
    if (cached) return { ...cached, duplicate: true };

    const acceptedRunIds: string[] = [];
    const ignoredRunIds: string[] = [];
    const drainedConversations = new Set<string>();
    const reservations = workspaceRunReservations.get(workspaceId);
    const runIds = [...new Set(input.runIds.map((runId) => runId.trim()).filter(Boolean))];
    for (const runId of runIds) {
      const reservation = reservations?.get(runId);
      if (!reservation) {
        ignoredRunIds.push(runId);
        continue;
      }
      const decision = decideEngineLossAdmission(reservation, input);
      if (decision.kind === "buffer-pre-attachment") {
        rememberPendingEngineLoss(workspaceId, reservation, input);
        ignoredRunIds.push(runId);
        continue;
      }
      if (decision.kind !== "release-matching-owner") {
        ignoredRunIds.push(runId);
        continue;
      }
      if (releaseRun(workspaceId, runId, "engine-loss-notification")) {
        acceptedRunIds.push(runId);
        drainedConversations.add(reservation.conversationId);
      } else {
        ignoredRunIds.push(runId);
      }
    }
    for (const conversationId of drainedConversations) {
      scheduleQueueDrain(workspaceId, conversationId, 0);
    }
    const result: ConversationRunEngineLossResult = {
      eventId,
      acceptedRunIds,
      ignoredRunIds,
      drainedConversations: [...drainedConversations].sort(),
      duplicate: false,
    };
    if (eventId) {
      engineLossEvents.set(eventId, result);
      if (engineLossEvents.size > 1024) {
        const oldest = engineLossEvents.keys().next().value;
        if (typeof oldest === "string") engineLossEvents.delete(oldest);
      }
    }
    recordTrace("server:conversation-run:engine-loss-notified", {
      eventId: eventId || null,
      workspaceId,
      engineSlotId: input.engineSlotId ?? null,
      engineOwnerId: input.engineOwnerId.trim() || null,
      reason: input.reason,
      acceptedRunIds,
      ignoredRunIds,
      drainedConversations: [...drainedConversations],
    });
    return result;
  };

  for (const reservation of options.queueStore?.listWorkspaceRunReservations?.() ?? []) {
    reservationsForWorkspace(reservation.workspaceId).set(reservation.runId, reservation);
    workspaceReconciliationPending.add(reservation.workspaceId);
  }

  const queueRun = (input: ConversationRunLifecycleSubmitInput, activeRunId: string | null) => {
    if (!options.queueStore) {
      throw new Error("Conversation run queue store is required for queued lifecycle admission");
    }
    const bodyJson = JSON.stringify({
      ...input.body,
      directory: input.target.directory,
      kind: input.kind,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.submitQueuePolicy ? { submitQueuePolicy: input.submitQueuePolicy } : {}),
      ...(input.runtimeAuthorizationActorTokenHash
        ? { runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash }
        : {}),
      ...(input.runtimeAuthorizationOrgId
        ? { runtimeAuthorizationOrgId: input.runtimeAuthorizationOrgId }
        : {}),
    });
    let queued: ReturnType<ConversationRunQueueStore["enqueue"]>;
    try {
      queued = options.queueStore.enqueue({
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        directory: input.target.directory,
        reservedRunId: input.runId,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        kind: input.kind,
        bodyJson,
        activeRunId,
      });
    } catch (error) {
      if (error instanceof ConversationRunQueueConflictError) {
        throw new ApiError(409, "idempotency_conflict", error.message, {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          clientMessageId: input.clientMessageId,
        });
      }
      throw error;
    }
    input.runTrace.record("server:conversation-run:queued", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: queued.item.reservedRunId,
      queueItemId: queued.item.queueItemId,
      activeRunId: queued.item.activeRunId,
      queuePosition: queued.queuePosition,
      inserted: queued.inserted,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      submitQueuePolicy: input.submitQueuePolicy ?? null,
      correlation: createConversationRunCorrelation({
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        clientMessageId: input.clientMessageId,
        queueItemId: queued.item.queueItemId,
        origin: input.origin,
        phase: "queued",
      }),
    });
    input.runTrace.record("server:conversation-run:admission-decision", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: queued.item.reservedRunId,
      queueItemId: queued.item.queueItemId,
      clientMessageId: input.clientMessageId,
      decision: "queued",
      activeRunId: queued.item.activeRunId,
    });
    scheduleQueueDrain(input.workspace.id, input.target.conversationId, queueDrainPollMs);
    return {
      httpStatus: queued.inserted ? 202 : 200,
      payload: {
        ok: true,
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        runId: queued.item.reservedRunId,
        reservedRunId: queued.item.reservedRunId,
        queueItemId: queued.item.queueItemId,
        activeRunId: queued.item.activeRunId,
        queuePosition: queued.queuePosition,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
        status: "queued",
        kind: input.kind,
        debugTrace: input.runTrace.entries,
      },
    };
  };

  const activeRunMatchesClientMessage = (
    active: LifecycleRunStatusResult | null,
    input: ConversationRunLifecycleSubmitInput,
  ): boolean => {
    return Boolean(
      active &&
        input.clientMessageId &&
        active.clientMessageId &&
        active.clientMessageId === input.clientMessageId,
    );
  };

  const existingActiveRunPayload = (
    input: ConversationRunLifecycleSubmitInput,
    active: LifecycleRunStatusResult,
  ) => ({
    httpStatus: 200,
    payload: {
      ok: true,
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: active.runId,
      clientMessageId: active.clientMessageId ?? input.clientMessageId,
      origin: active.origin ?? input.origin,
      status: "submitted",
      kind: input.kind,
      reusedActiveRun: true,
      debugTrace: input.runTrace.entries,
    },
  });

  type PredecessorDecision =
    | { kind: "ready"; status: LifecycleRunStatusResult | null; recoveredTerminalHandoff: boolean }
    | { kind: "active_exact_owner"; status: LifecycleRunStatusResult }
    | { kind: "terminal_handoff_pending"; status: LifecycleRunStatusResult }
    | { kind: "terminal_handoff_unresolved"; status: LifecycleRunStatusResult; reason: string };

  /**
   * `active` deliberately hides terminal runs, while orchestrator register
   * correctly fences a terminal transcript until its exact OpenCode session is
   * idle. Keep that distinction here, before a direct submit can turn a
   * recoverable historical handoff into an ordinary queue row.
   */
  const classifyPredecessor = async (input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    lifecycleOwner: OrchestratorLifecycleClient;
    runTrace: ConversationRunLifecycleTracer;
    source: "direct-admission" | "register-conflict" | "queue-drain";
  }): Promise<PredecessorDecision> => {
    let status = await input.runTrace.step(
      input.source === "queue-drain"
        ? "server:conversation-run:lifecycle-latest-for-queue-drain"
        : "server:conversation-run:lifecycle-active-peek",
      () => input.source === "queue-drain"
        ? input.lifecycleOwner.status(input.workspace.id, input.conversationId, "latest")
        : input.lifecycleOwner.active(input.workspace.id, input.conversationId),
      {
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        source: input.source,
      },
    );

    // The active fast path is sufficient for a current run. Only its absence
    // requires the broader latest read, where a terminal handoff can be seen.
    if (!status && input.source !== "queue-drain") {
      status = await input.runTrace.step(
        "server:conversation-run:lifecycle-latest-predecessor",
        () => input.lifecycleOwner.status(input.workspace.id, input.conversationId, "latest"),
        {
          workspaceId: input.workspace.id,
          conversationId: input.conversationId,
          source: input.source,
        },
      );
    }

    const record = (decision: PredecessorDecision) => {
      input.runTrace.record("server:conversation-run:predecessor-classified", {
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        source: input.source,
        classification: decision.kind,
        reason: decision.kind === "terminal_handoff_unresolved" ? decision.reason : null,
        blockingRunId: decision.status?.runId ?? null,
        ...lifecycleStatusTraceFields(decision.status),
      });
      return decision;
    };

    // A current run is never bypassed by a stale or inconsistent readiness
    // projection. `active` is the stronger ownership fact; readiness only
    // governs terminal predecessors.
    if (status && isActiveLifecycleStatus(status.status)) {
      return record({ kind: "active_exact_owner", status });
    }
    if (!status || status.runtimeReadyForSuccessor === true) {
      return record({ kind: "ready", status, recoveredTerminalHandoff: false });
    }

    // A terminal, non-stale session can still be completing its normal
    // OpenCode handoff. It is safe to retain one FIFO queue item behind it.
    if (status.runtimeReadyForSuccessor === false && status.stale !== true) {
      return record({ kind: "terminal_handoff_pending", status });
    }
    const initialTerminalStatus = status;

    // Only the existing generation authority may prove a stale terminal owner
    // lost. Always read the lifecycle record again after that guarded call;
    // the response alone is not permission to admit a successor.
    if (status.stale === true && status.unavailableReason === "no_current_engine") {
      try {
        input.runTrace.record("server:conversation-run:terminal-handoff-recovery:start", {
          workspaceId: input.workspace.id,
          conversationId: input.conversationId,
          runId: status.runId,
          source: input.source,
          ...lifecycleStatusTraceFields(status),
        });
        await input.lifecycleOwner.recoverTerminalRuntimeHandoff(input.workspace.id, status.runId);
      } catch (error) {
        input.runTrace.record("server:conversation-run:terminal-handoff-recovery:result", {
          workspaceId: input.workspace.id,
          conversationId: input.conversationId,
          runId: initialTerminalStatus.runId,
          source: input.source,
          outcome: "unresolved",
          reason: lifecycleErrorReason(error),
          generationEvidenceKind: lifecycleErrorEvidenceKind(error),
        });
        return record({
          kind: "terminal_handoff_unresolved",
          status: status ?? initialTerminalStatus,
          reason: lifecycleErrorReason(error),
        });
      }

      // A recovery result is evidence only. This read is intentionally outside
      // the recovery catch: a transport failure must use the ordinary
      // lifecycle retry path, never become a durable unresolved handoff.
      status = await input.runTrace.step(
        "server:conversation-run:lifecycle-latest-after-terminal-handoff-recovery",
        () => input.lifecycleOwner.status(input.workspace.id, input.conversationId, "latest"),
        {
          workspaceId: input.workspace.id,
          conversationId: input.conversationId,
          source: input.source,
          blockingRunId: initialTerminalStatus.runId,
        },
      );
      // An absent predecessor unblocks admission but proves nothing about the
      // old process, so it must not be reported as a generation loss proof.
      const recoveryOutcome = !status
        ? "predecessor_absent"
        : isActiveLifecycleStatus(status.status) || status.runtimeReadyForSuccessor === true
        ? "lost_proven"
        : "unresolved";
      input.runTrace.record("server:conversation-run:terminal-handoff-recovery:result", {
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        runId: initialTerminalStatus.runId,
        source: input.source,
        outcome: recoveryOutcome,
        generationEvidenceKind: recoveryOutcome,
      });
      if (status && isActiveLifecycleStatus(status.status)) {
        return record({ kind: "active_exact_owner", status });
      }
      if (!status || status.runtimeReadyForSuccessor === true) {
        return record({ kind: "ready", status, recoveredTerminalHandoff: true });
      }
    }

    return record({
      kind: "terminal_handoff_unresolved",
      status: status ?? initialTerminalStatus,
      reason: (status ?? initialTerminalStatus).unavailableReason ?? "runtime_not_ready",
    });
  };

  /**
   * A blocked predecessor must leave the same durable barrier whether it was
   * found by the queue drain or by a direct submit. Without it a rejected
   * submit reports a bare error: the run status has nothing to project, so the
   * app cannot offer its existing retry-verification affordance.
   */
  const persistBlockedTerminalHandoffBarrier = (
    workspaceIdRaw: string,
    conversationId: string,
    decision: Extract<PredecessorDecision, { kind: "terminal_handoff_unresolved" }>,
  ) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspaceIdRaw);
    const runId = decision.status.runId.trim();
    if (!workspaceId || !runId) return;
    const fingerprint = terminalHandoffFingerprint(workspaceId, runId, decision.status);
    const observedBarrier = terminalHandoffBarrier(workspaceId, conversationId, runId) ??
      options.queueStore?.observeTerminalHandoffBarrier({
        workspaceId,
        conversationId,
        runId,
        fingerprint,
        reason: decision.reason,
      }) ?? null;
    if (observedBarrier?.state === "observed") {
      options.queueStore?.requestTerminalHandoffBarrierEvidence({
        workspaceId,
        conversationId,
        runId,
        fingerprint,
        reason: decision.reason,
      });
    }
    markTerminalHandoffBarrierUnresolved({
      workspaceId,
      conversationId,
      runId,
      reason: decision.reason,
    });
  };

  const terminalHandoffRecoveryRequired = (
    input: ConversationRunLifecycleSubmitInput,
    decision: Extract<PredecessorDecision, { kind: "terminal_handoff_unresolved" }>,
  ): ApiError => new ApiError(
    409,
    "terminal_handoff_recovery_required",
    "The previous conversation runtime could not be safely verified. Keep the draft and retry verification once the runtime is available.",
    {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      blockingRunId: decision.status.runId,
      reason: decision.reason,
    },
  );

  const registerActiveAiGatewayRun = (input: ConversationRunLifecycleSubmitInput) => {
    if (input.expectAiGatewayStart !== true || !options.aiGatewayActiveRun) {
      return false;
    }
    options.aiGatewayActiveRun.register({
      traceId: input.runTrace.traceId,
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      opencodeSessionId: input.target.opencodeSessionId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash?.trim() || null,
      runtimeAuthorizationOrgId: input.runtimeAuthorizationOrgId?.trim() || null,
    });
    return true;
  };

  const unregisterActiveAiGatewayRun = (input: ConversationRunLifecycleSubmitInput) => {
    options.aiGatewayActiveRun?.unregister({
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      opencodeSessionId: input.target.opencodeSessionId,
    });
  };

  const unregisterScheduledAiGatewayRun = (
    input: ConversationRunLifecycleScheduleReconcileInput,
    opencodeSessionId?: string | null,
  ) => {
    const normalizedOpencodeSessionId = opencodeSessionId?.trim() || input.opencodeSessionId?.trim() || "";
    if (!normalizedOpencodeSessionId) return;
    options.aiGatewayActiveRun?.unregister({
      workspaceId: input.workspace.id,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId: normalizedOpencodeSessionId,
    });
    recordTrace("server:ai-gateway-active-run:unregister", {
      workspaceId: input.workspace.id,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId: normalizedOpencodeSessionId,
      reason: input.reason,
    });
  };

  const scheduleAcceptedRunReconcile = (
    input: ConversationRunLifecycleSubmitInput,
    reason: string,
    delayMs: number,
  ) => {
    scheduleLifecycleReconcile({
      workspace: input.workspace,
      conversationId: input.target.conversationId,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      reason,
      delayMs,
    });
  };

  const requestTerminalTranscriptIngest = (
    input: ConversationRunLifecycleScheduleReconcileInput,
    status: LifecycleRunStatus,
    source: "lifecycle-terminal" | "reconcile-exhausted",
  ) => {
    const directory = input.directory?.trim() ?? "";
    const opencodeSessionId = input.opencodeSessionId?.trim() ?? "";
    const reportTerminalRecovery = (canonicalRecovery: "recovered" | "unavailable" | "failed") => {
      options.onTerminalTranscriptRecovery?.({
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        runId: input.runId,
        lifecycle: status,
        canonicalRecovery,
      });
    };
    if (!directory || !opencodeSessionId || !options.ingestTerminalTranscript) {
      reportTerminalRecovery("unavailable");
      return;
    }
    void options.ingestTerminalTranscript({
      workspace: input.workspace,
      directory,
      opencodeSessionId,
      runId: input.runId,
    }).then((outcome) => {
      reportTerminalRecovery(
        outcome?.kind === "persisted" || outcome?.kind === "unchanged"
          ? "recovered"
          : "unavailable",
      );
      recordTrace("server:conversation-run:terminal-transcript-ingest", {
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        runId: input.runId,
        opencodeSessionId,
        status,
        source,
      });
    }).catch((error) => {
      reportTerminalRecovery("failed");
      recordTrace("server:conversation-run:terminal-transcript-ingest-error", {
        workspaceId: input.workspace.id,
        conversationId: input.conversationId,
        runId: input.runId,
        opencodeSessionId,
        status,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const markLifecycleFailed = async (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
    event: string,
    reason: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!lifecycleOwner) return true;
    return await input.runTrace.step(
      event,
      () => lifecycleOwner.markFailed(input.workspace.id, input.runId, reason),
      {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        ...payload,
      },
    ).then(() => true).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const tracePayload = {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        reason,
        message,
        ...payload,
      };
      input.runTrace.record(`${event}:error`, tracePayload);
      recordTrace(`${event}:error`, tracePayload);
      return false;
    });
  };

  const scheduleProviderStartTimeoutAbortRetry = (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient,
    timeoutMs: number,
    recovery?: { attempts: number; deadlineAt: number; lastError: string | null; nextAttemptAt?: number | null },
  ) => {
    const key = providerStartAbortRecoveryKey(input.workspace.id, input.target.conversationId, input.runId);
    const previous = recovery ?? providerStartAbortRecoveries.get(key) ?? null;
    const attempts = Math.max(0, previous?.attempts ?? 0);
    const deadlineAt = previous?.deadlineAt ?? Date.now() + PROVIDER_START_ABORT_RECOVERY_WINDOW_MS;
    if (attempts >= PROVIDER_START_ABORT_MAX_ATTEMPTS || Date.now() >= deadlineAt) {
      options.queueStore?.markWorkspaceRunProviderStartAbortPending({
        workspaceId: input.workspace.id,
        runId: input.runId,
        directory: input.target.directory,
        opencodeSessionId: input.target.opencodeSessionId,
        attempts,
        lastError: previous?.lastError ?? "provider-start abort recovery budget exhausted",
        nextAttemptAt: null,
        deadlineAt,
      });
      providerStartAbortRecoveries.set(key, {
        input,
        lifecycleOwner,
        timeoutMs,
        attempts,
        deadlineAt,
        lastError: previous?.lastError ?? "provider-start abort recovery budget exhausted",
      });
      recordTrace("server:conversation-run:provider-start-timeout-abort:recovery-exhausted", {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        attempts,
        deadlineAt,
        lastError: previous?.lastError ?? null,
      });
      // Exhausting the abort retry budget is not evidence that this run can be
      // released. It does, however, require one normal exact-run status read:
      // a prior process may already have persisted terminality and runtime
      // readiness. Without that read a durable reservation can block its own
      // ready successor forever after restart.
      scheduleLifecycleReconcile({
        workspace: input.workspace,
        conversationId: input.target.conversationId,
        runId: input.runId,
        directory: input.target.directory,
        opencodeSessionId: input.target.opencodeSessionId,
        reason: PROVIDER_START_ABORT_RECOVERY_EXHAUSTED_REASON,
        delayMs: 0,
      });
      return;
    }
    const retryDelayMs = PROVIDER_START_ABORT_RETRY_DELAYS_MS[Math.max(0, attempts - 1)]
      ?? PROVIDER_START_ABORT_RETRY_DELAYS_MS.at(-1)!;
    const nextAttemptAt = typeof previous?.nextAttemptAt === "number"
      ? previous.nextAttemptAt
      : Date.now() + retryDelayMs;
    providerStartAbortRecoveries.set(
      key,
      {
        input,
        lifecycleOwner,
        timeoutMs,
        attempts,
        deadlineAt,
        lastError: previous?.lastError ?? null,
        nextAttemptAt,
      },
    );
    options.queueStore?.markWorkspaceRunProviderStartAbortPending({
      workspaceId: input.workspace.id,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      attempts,
      lastError: previous?.lastError ?? null,
      nextAttemptAt,
      deadlineAt,
    });
    scheduleLifecycleReconcile({
      workspace: input.workspace,
      conversationId: input.target.conversationId,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      reason: PROVIDER_START_ABORT_RETRY_REASON,
      abortRequested: true,
      delayMs: Math.max(0, nextAttemptAt - Date.now()),
    });
  };

  const recoverProviderStartTimeout = async (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient,
    timeoutMs: number,
  ) => {
    const tracePayload = {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      opencodeSessionId: input.target.opencodeSessionId,
      timeoutMs,
    };
    const key = providerStartAbortRecoveryKey(input.workspace.id, input.target.conversationId, input.runId);
    const previous = providerStartAbortRecoveries.get(key);
    const attempts = Math.max(0, previous?.attempts ?? 0);
    const deadlineAt = previous?.deadlineAt ?? Date.now() + PROVIDER_START_ABORT_RECOVERY_WINDOW_MS;
    if (attempts >= PROVIDER_START_ABORT_MAX_ATTEMPTS || Date.now() >= deadlineAt) {
      scheduleProviderStartTimeoutAbortRetry(input, lifecycleOwner, timeoutMs, {
        attempts,
        deadlineAt,
        lastError: previous?.lastError ?? "provider-start abort recovery budget exhausted",
        nextAttemptAt: null,
      });
      return;
    }
    const currentAttempt = attempts + 1;
    providerStartAbortRecoveries.set(key, {
      input,
      lifecycleOwner,
      timeoutMs,
      attempts: currentAttempt,
      deadlineAt,
      lastError: previous?.lastError ?? null,
    });
    options.queueStore?.markWorkspaceRunProviderStartAbortPending({
      workspaceId: input.workspace.id,
      runId: input.runId,
      directory: input.target.directory,
      opencodeSessionId: input.target.opencodeSessionId,
      attempts: currentAttempt,
      lastError: previous?.lastError ?? null,
      nextAttemptAt: Date.now(),
      deadlineAt,
    });
    const abortedGatewayRequests = options.abortActiveGatewayProxyRequests?.({
      workspaceId: input.workspace.id,
      runId: input.runId,
      sessionId: input.target.opencodeSessionId,
      reason: "ai-gateway-provider-start-timeout",
    }) ?? [];

    if (!options.abortOpenCode) {
      input.runTrace.record("server:conversation-run:provider-start-timeout-abort:unavailable", tracePayload);
      scheduleProviderStartTimeoutAbortRetry(input, lifecycleOwner, timeoutMs, {
        attempts: currentAttempt,
        deadlineAt,
        lastError: "OpenCode abort control is unavailable",
      });
      return;
    }

    try {
      await input.runTrace.step(
        "server:conversation-run:provider-start-timeout-abort",
        () => options.abortOpenCode!({
          runTrace: input.runTrace,
          workspace: input.workspace,
          target: input.target,
          runId: input.runId,
        }),
        { ...tracePayload, abortedGatewayRequestCount: abortedGatewayRequests.length },
      );
    } catch (error) {
      input.runTrace.record("server:conversation-run:provider-start-timeout-abort:error", {
        ...tracePayload,
        message: error instanceof Error ? error.message : String(error),
      });
      scheduleProviderStartTimeoutAbortRetry(input, lifecycleOwner, timeoutMs, {
        attempts: currentAttempt,
        deadlineAt,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const terminalized = await markLifecycleFailed(
      input,
      lifecycleOwner,
      "server:conversation-run:provider-start-timeout-mark-failed",
      `AI gateway provider request did not start within ${timeoutMs}ms; OpenCode session was aborted.`,
      { abortedGatewayRequestCount: abortedGatewayRequests.length },
    );
    if (terminalized) {
      unregisterActiveAiGatewayRun(input);
      providerStartAbortRecoveries.delete(key);
      // Abort acknowledgement is not the same as an idle OpenCode session.
      // Re-enter the normal exact-run handoff barrier before releasing the
      // reservation, otherwise a 204 successor can still be undispatched.
      scheduleLifecycleReconcile({
        workspace: input.workspace,
        conversationId: input.target.conversationId,
        runId: input.runId,
        directory: input.target.directory,
        opencodeSessionId: input.target.opencodeSessionId,
        reason: "provider-start-timeout-aborted",
        delayMs: 0,
      });
      return;
    }

    scheduleTerminalizationRetry({
      workspace: input.workspace,
      conversationId: input.target.conversationId,
      runId: input.runId,
      reasonCode: "reconcile_exhausted",
      terminalMessage: `AI gateway provider request did not start within ${timeoutMs}ms; OpenCode session was aborted.`,
      attempts: 1,
      lastError: "provider-start timeout lifecycle terminalization failed",
      deadlineAt: Date.now() + 300_000,
      onTerminalized: () => unregisterActiveAiGatewayRun(input),
    });
  };

  const scheduleProviderStartWatch = (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
    providerWatchStartedAt: number,
  ): boolean => {
    if (!lifecycleOwner || input.expectAiGatewayStart !== true) return false;

    const tracePayload = {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      opencodeSessionId: input.target.opencodeSessionId,
    };

    if (!options.aiGatewayProviderWatch) {
      input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:unavailable", tracePayload);
      return false;
    }

    input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:scheduled", tracePayload);
    void (async () => {
      try {
        const providerStart = await input.runTrace.step(
          "server:conversation-run:ai-gateway-provider-start-watch",
          () => options.aiGatewayProviderWatch!.waitForProviderStart({
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            opencodeSessionId: input.target.opencodeSessionId,
            clientMessageId: input.clientMessageId,
            origin: input.origin,
            startedAt: providerWatchStartedAt,
          }),
          tracePayload,
        );
        if (!providerStart.started) {
          input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:timeout", {
            ...tracePayload,
            timeoutMs: providerStart.timeoutMs,
            providerHitScope: providerStart.providerHitScope ?? "none",
            providerHitCount: providerStart.providerHitCount ?? 0,
            firstProviderHitAt: providerStart.firstProviderHitAt ?? null,
            lastProviderHitAt: providerStart.lastProviderHitAt ?? null,
            message: `AI gateway provider request did not start within ${providerStart.timeoutMs}ms.`,
          });
          await recoverProviderStartTimeout(input, lifecycleOwner, providerStart.timeoutMs);
        }
      } catch (error) {
        input.runTrace.record("server:conversation-run:ai-gateway-provider-start-watch:error", {
          ...tracePayload,
          message: error instanceof Error ? error.message : String(error),
        });
        scheduleAcceptedRunReconcile(input, "ai-gateway-provider-start-watch-error", 0);
      }
    })();
    return true;
  };

  const submitAcceptedRun = async (
    input: ConversationRunLifecycleSubmitInput,
    lifecycleOwner: OrchestratorLifecycleClient | null,
  ) => {
    if (!options.submitOpenCode) {
      throw new Error("OpenCode submit port is required for admitted conversation runs");
    }
    // Lifecycle registration/reservation has already crossed the durable
    // admission boundary. Record it before any upstream call so a submit
    // failure remains joinable to its exact accepted run.
    input.runTrace.record("server:conversation-run:admitted", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      runId: input.runId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      correlation: createConversationRunCorrelation({
        admittedRunId: input.runId,
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        clientMessageId: input.clientMessageId,
        queueItemId: input.queueItemId,
        origin: input.origin,
        phase: "admitted",
        outcome: "accepted",
      }),
    });
    const providerWatchStartedAt = Date.now();
    let activeAiGatewayRunRegistered = registerActiveAiGatewayRun(input);
    const unregisterRegisteredAiGatewayRun = () => {
      if (!activeAiGatewayRunRegistered) return;
      activeAiGatewayRunRegistered = false;
      unregisterActiveAiGatewayRun(input);
    };

    let upstream: unknown;
    try {
      upstream = await options.submitOpenCode({
        runTrace: input.runTrace,
        workspace: input.workspace,
        target: input.target,
        runId: input.runId,
        kind: input.kind,
        body: input.body,
        clientMessageId: input.clientMessageId,
        opencodeMessageId: input.opencodeMessageId ?? null,
        origin: input.origin,
        orchestratorRegistrationScope: input.orchestratorRegistrationScope ?? null,
        captureEngineOwner: (owner) => {
          if (!attachReservedRunEngineOwner(input.workspace.id, input.runId, owner)) {
            input.runTrace.record("server:conversation-run:engine-owner-persist-failed", {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: input.runId,
              engineSlotId: owner.engineSlotId,
              engineOwnerId: owner.engineOwnerId,
              enginePid: owner.enginePid,
              engineStartedAt: owner.engineStartedAt,
              engineBaseUrl: owner.engineBaseUrl,
            });
          }
        },
      });
    } catch (error) {
      const terminalized = await markLifecycleFailed(
        input,
        lifecycleOwner,
        "server:conversation-run:lifecycle-mark-failed",
        error instanceof Error ? error.message : String(error),
      );
      unregisterRegisteredAiGatewayRun();
      if (terminalized && lifecycleOwner) {
        // A transport failure is outcome-unknown: OpenCode may have accepted
        // the prompt before the response was lost. A durable failed lifecycle
        // record therefore still has to pass the exact runtime handoff check
        // before this conversation can admit a successor.
        scheduleTerminalRuntimeHandoff({
          workspace: input.workspace,
          conversationId: input.target.conversationId,
          runId: input.runId,
          directory: input.target.directory,
          opencodeSessionId: input.target.opencodeSessionId,
          reason: "upstream-submit-failed-terminalized",
        });
      } else if (terminalized) {
        // The legacy direct runtime has no lifecycle evidence with which to
        // fence an uncertain handoff. It also cannot accept server-queue-only
        // work (that path is rejected above), so retaining the reservation
        // would only make a retry permanently conflict with its own failure.
        releaseRun(input.workspace.id, input.runId, "upstream-submit-failed-no-lifecycle-owner");
        scheduleQueueDrain(input.workspace.id, input.target.conversationId, 0);
      } else {
        scheduleTerminalizationRetry({
          workspace: input.workspace,
          conversationId: input.target.conversationId,
          runId: input.runId,
          reasonCode: "upstream_submit_failed",
          terminalMessage: terminalizationErrorMessage(error),
          attempts: 1,
          lastError: terminalizationErrorMessage(error),
          deadlineAt: Date.now() + 300_000,
        });
      }
      throw error;
    }

    activateReservedRun(input);

    const providerWatchOwnsGatewayRun = scheduleProviderStartWatch(
      input,
      lifecycleOwner,
      providerWatchStartedAt,
    );
    // Direct `orchestrator start` has no lifecycle daemon, but OpenCode can
    // issue its managed-AI provider request immediately after prompt_async
    // returns. Keep the correlation until the runtime-owner TTL in that mode;
    // without it the `${OPENCODE_SESSION_ID}` provider header is unresolvable.
    if (!providerWatchOwnsGatewayRun && lifecycleOwner) {
      unregisterRegisteredAiGatewayRun();
    }

    scheduleAcceptedRunReconcile(
      input,
      "accepted",
      options.resolveLifecycleReconcileInitialDelayMs?.() ?? 0,
    );
    return upstream;
  };

  const clearTimer = (handle: unknown) => {
    if (!activeTimers.delete(handle)) return;
    clearScheduledTimeout(handle);
  };

  const clearAllTimers = () => {
    keyedScheduler.cancelAll();
    for (const handle of [...activeTimers]) {
      clearTimer(handle);
    }
    queueDrainTimers.clear();
    lifecycleReconcileTimers.clear();
    terminalizationTimers.clear();
    startingRecoveryTimers.clear();
    queueDrainBlockingDecisions.clear();
    queueDrainReservationConflicts.clear();
  };

  const clearPendingEngineLoss = (key: string) => {
    const timer = pendingEngineLossTimers.get(key);
    if (timer) keyedScheduler.cancel("engine-loss-pre-attachment", key);
    pendingEngineLossTimers.delete(key);
    pendingEngineLosses.delete(key);
  };

  const rememberPendingEngineLoss = (
    workspaceId: string,
    reservation: ConversationWorkspaceRunReservation,
    notification: ConversationRunEngineLossNotification,
  ) => {
    const key = `${workspaceId}\0${reservation.runId}`;
    clearPendingEngineLoss(key);
    pendingEngineLosses.set(key, notification);
    const graceMs = Math.max(
      0,
      options.resolveEngineOwnerAttachGraceMs?.() ?? ENGINE_OWNER_ATTACH_GRACE_DEFAULT_MS,
    );
    const scheduled = keyedScheduler.schedule({
      namespace: "engine-loss-pre-attachment",
      key,
      delayMs: graceMs,
      reason: "engine-loss-pre-attachment-expiry",
      replaceExisting: true,
      run: () => {
        pendingEngineLossTimers.delete(key);
        if (pendingEngineLosses.get(key) !== notification) return;
        pendingEngineLosses.delete(key);
        recordTrace("server:conversation-run:engine-loss-pre-attachment-expired", {
          workspaceId,
          conversationId: reservation.conversationId,
          runId: reservation.runId,
          graceMs,
        });
      },
    });
    if (scheduled.kind === "scheduled") pendingEngineLossTimers.set(key, scheduled.handle);
    recordTrace("server:conversation-run:engine-loss-pre-attachment-buffered", {
      workspaceId,
      conversationId: reservation.conversationId,
      runId: reservation.runId,
      graceMs,
    });
  };

  const queueKey = (workspaceId: string, conversationId: string) => `${workspaceId}\0${conversationId}`;
  const reconcileKey = (workspaceId: string, conversationId: string, runId: string) =>
    `${workspaceId}\0${conversationId}\0${runId}`;
  const terminalizationKey = reconcileKey;

  const recordQueueDrainBlockingDecision = (
    runTrace: ConversationRunLifecycleTracer,
    event: string,
    input: {
      workspaceId: string;
      conversationId: string;
      decisionKey: string;
      payload?: Record<string, unknown>;
    },
  ) => {
    const key = queueKey(input.workspaceId, input.conversationId);
    const decision = `${event}\0${input.decisionKey}`;
    if (queueDrainBlockingDecisions.get(key) === decision) return;
    queueDrainBlockingDecisions.set(key, decision);
    runTrace.record(event, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...(input.payload ?? {}),
    });
  };

  const clearQueueDrainBlockingDecision = (workspaceId: string, conversationId: string) => {
    queueDrainBlockingDecisions.delete(queueKey(workspaceId, conversationId));
  };

  const clearQueueDrainReservationConflicts = (workspaceId: string, conversationId: string) => {
    const prefix = `${queueKey(workspaceId, conversationId)}\0`;
    for (const key of queueDrainReservationConflicts.keys()) {
      if (key.startsWith(prefix)) queueDrainReservationConflicts.delete(key);
    }
  };

  const terminalizationDelayMs = (attempt: number) =>
    [1_000, 2_000, 4_000, 8_000, 15_000][Math.min(Math.max(0, attempt - 1), 4)] ?? 60_000;

  const scheduleTerminalizationRetry = (input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    runId: string;
    reasonCode: TerminalizationReasonCode;
    terminalMessage?: string;
    attempts: number;
    lastError?: string;
    deadlineAt: number;
    nextAttemptAt?: number | null;
    onTerminalized?: () => void;
  }) => {
    const key = terminalizationKey(input.workspace.id, input.conversationId, input.runId);
    const now = Date.now();
    const retryDelayMs = input.attempts > 5 ? 60_000 : terminalizationDelayMs(input.attempts);
    const persistedNextAttemptAt = input.nextAttemptAt;
    const nextAttemptAt = typeof persistedNextAttemptAt === "number" && Number.isFinite(persistedNextAttemptAt)
      ? persistedNextAttemptAt
      : now + retryDelayMs;
    const delayMs = Math.max(0, nextAttemptAt - now);
    const previous = terminalizationTimers.get(key);
    if (previous) keyedScheduler.cancel("terminalization", key);
    const reservation = options.queueStore?.markWorkspaceRunTerminalizationPending({
      workspaceId: input.workspace.id,
      runId: input.runId,
      reason: input.reasonCode,
      attempts: input.attempts,
      lastError: input.lastError ?? "terminal lifecycle write unavailable",
      nextAttemptAt,
      deadlineAt: input.deadlineAt,
    });
    const reservations = reservationsForWorkspace(input.workspace.id);
    if (reservation) {
      reservations.set(input.runId, reservation);
    } else {
      const previousReservation = reservations.get(input.runId);
      if (previousReservation) {
        reservations.set(input.runId, {
          ...previousReservation,
          state: "terminalization_pending",
          terminalizationReason: input.reasonCode,
          terminalizationAttempts: input.attempts,
          terminalizationLastError: input.lastError ?? "terminal lifecycle write unavailable",
          terminalizationNextAttemptAt: nextAttemptAt,
          terminalizationDeadlineAt: input.deadlineAt,
          updatedAt: Date.now(),
        });
      }
    }
    const scheduled = keyedScheduler.schedule({
      namespace: "terminalization",
      key,
      delayMs,
      reason: input.reasonCode,
      attempt: input.attempts,
      replaceExisting: true,
      run: () => {
        terminalizationTimers.delete(key);
        const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
        if (!lifecycleOwner) return;
        if (Date.now() >= input.deadlineAt) {
          recordTrace("server:conversation-run:terminalization-deadline-exceeded", {
            workspaceId: input.workspace.id,
            conversationId: input.conversationId,
            runId: input.runId,
            reasonCode: input.reasonCode,
            attempts: input.attempts,
            deadlineAt: input.deadlineAt,
          });
        }
        return lifecycleOwner.markFailed(
          input.workspace.id,
          input.runId,
          input.terminalMessage ?? terminalizationMessageForReason(input.reasonCode),
        ).then(() => {
          input.onTerminalized?.();
          // Retrying the terminal write repairs lifecycle durability, not the
          // runtime handoff. Keep the reservation until the exact run reports
          // that its engine is idle as well.
          scheduleTerminalRuntimeHandoff({
            workspace: input.workspace,
            conversationId: input.conversationId,
            runId: input.runId,
            reason: "terminalization-retry-terminalized",
          });
        }).catch((error) => {
          scheduleTerminalizationRetry({
            ...input,
            attempts: input.attempts + 1,
            lastError: terminalizationErrorMessage(error),
            nextAttemptAt: undefined,
          });
        });
      },
    });
    if (scheduled.kind === "scheduled") terminalizationTimers.set(key, scheduled.handle);
    recordTrace("server:conversation-run:terminalization-retry-scheduled", {
      workspaceId: input.workspace.id,
      conversationId: input.conversationId,
      runId: input.runId,
      reasonCode: input.reasonCode,
      attempts: input.attempts,
      delayMs,
      nextAttemptAt,
      deadlineAt: input.deadlineAt,
    });
  };

  function scheduleQueueDrain(
    workspaceId: string,
    conversationId: string,
    delayMs = 0,
  ): void {
    const normalizedConversationId = conversationId.trim();
    if (!workspaceId.trim() || !normalizedConversationId) return;
    const key = queueKey(workspaceId, normalizedConversationId);
    const normalizedDelayMs = normalizeNonNegativeDelayMs(delayMs);
    const existing = queueDrainTimers.get(key);
    if (existing) {
      if (normalizedDelayMs > 0) return;
      keyedScheduler.cancel("queue-drain", key);
      queueDrainTimers.delete(key);
    }
    const scheduled = keyedScheduler.schedule({
      namespace: "queue-drain",
      key,
      delayMs: normalizedDelayMs,
      reason: "queue-drain",
      replaceExisting: normalizedDelayMs === 0,
      run: () => {
        queueDrainTimers.delete(key);
        return drainConversationQueue(workspaceId, normalizedConversationId);
      },
    });
    if (scheduled.kind === "scheduled") queueDrainTimers.set(key, scheduled.handle);
    recordTrace("server:conversation-run:queue-drain-scheduled", {
      workspaceId,
      conversationId: normalizedConversationId,
      delayMs: normalizedDelayMs,
    });
  }

  function scheduleLifecycleReconcile(input: ConversationRunLifecycleScheduleReconcileInput): void {
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!input.workspace.id.trim() || !conversationId || !runId) return;
    const key = reconcileKey(input.workspace.id, conversationId, runId);
    const delayMs = normalizeNonNegativeDelayMs(input.delayMs);
    const existing = lifecycleReconcileTimers.get(key);
    if (existing) {
      if (delayMs > 0 && input.abortRequested !== true) return;
      keyedScheduler.cancel("reconcile", key);
      lifecycleReconcileTimers.delete(key);
    }
    const scheduled = keyedScheduler.schedule({
      namespace: "reconcile",
      key,
      delayMs,
      reason: input.reason,
      attempt: input.attempt ?? 0,
      replaceExisting: delayMs === 0 || input.abortRequested === true,
      run: () => {
        lifecycleReconcileTimers.delete(key);
        return reconcileConversationRunLifecycle({
          ...input,
          conversationId,
          runId,
          attempt: input.attempt ?? 0,
        });
      },
    });
    if (scheduled.kind === "scheduled") lifecycleReconcileTimers.set(key, scheduled.handle);
    recordTrace("server:conversation-run:lifecycle-reconcile-scheduled", {
      workspaceId: input.workspace.id,
      conversationId,
      runId,
      opencodeSessionId: input.opencodeSessionId?.trim() || null,
      reason: input.reason,
      abortRequested: input.abortRequested === true,
      attempt: input.attempt ?? 0,
      delayMs,
      predecessorReleaseProven: input.predecessorReleaseProven === true,
    });
  }

  function scheduleTerminalRuntimeHandoff(
    input: Omit<ConversationRunLifecycleScheduleReconcileInput, "delayMs" | "attempt" | "abortRequested">,
  ): void {
    // A successful terminalization retry must clear only its retry marker.
    // The same durable reservation remains active until reconciliation proves
    // that its exact runtime has become safe for a successor.
    restoreReservedRunForHandoff(input.workspace.id, input.runId);
    scheduleLifecycleReconcile({
      ...input,
      delayMs: 0,
    });
  }

  async function reconcileConversationRunLifecycle(input: ConversationRunLifecycleScheduleReconcileInput): Promise<void> {
    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
    if (!lifecycleOwner) return;
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!conversationId || !runId) return;
    const pendingTerminalization = workspaceRunReservations
      .get(normalizeWorkspaceExecutionKey(input.workspace.id))
      ?.get(runId);
    const pendingTerminalHandoffBarrier = terminalHandoffBarrier(input.workspace.id, conversationId, runId);
    if (pendingTerminalization?.state === "terminalization_pending") {
      scheduleTerminalizationRetry({
        workspace: input.workspace,
        conversationId,
        runId,
        reasonCode: normalizeTerminalizationReasonCode(pendingTerminalization.terminalizationReason),
        attempts: Math.max(1, pendingTerminalization.terminalizationAttempts),
        lastError: pendingTerminalization.terminalizationLastError ?? undefined,
        deadlineAt: pendingTerminalization.terminalizationDeadlineAt ?? Date.now() + 300_000,
        nextAttemptAt: pendingTerminalization.terminalizationNextAttemptAt,
      });
      return;
    }
    const key = reconcileKey(input.workspace.id, conversationId, runId);
    const providerStartAbortRecovery = providerStartAbortRecoveries.get(
      providerStartAbortRecoveryKey(input.workspace.id, conversationId, runId),
    );
    const providerStartAbortRecoveryExhausted = Boolean(
      providerStartAbortRecovery &&
      (
        providerStartAbortRecovery.attempts >= PROVIDER_START_ABORT_MAX_ATTEMPTS ||
        Date.now() >= providerStartAbortRecovery.deadlineAt
      ),
    );
    if (
      providerStartAbortRecovery &&
      !providerStartAbortRecoveryExhausted &&
      input.reason !== PROVIDER_START_ABORT_RETRY_REASON
    ) {
      // Retrying a provider start only makes sense while its engine might still
      // answer. Once the caller proved that exact owner lost, this deferral
      // would hold a successor behind an unrelated retry budget, so the
      // reconciliation below owns the decision instead.
      if (input.predecessorReleaseProven !== true) {
        scheduleProviderStartTimeoutAbortRetry(
          providerStartAbortRecovery.input,
          providerStartAbortRecovery.lifecycleOwner,
          providerStartAbortRecovery.timeoutMs,
        );
        return;
      }
      recordTrace("server:conversation-run:provider-start-abort-recovery-superseded", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        attempts: providerStartAbortRecovery.attempts,
      });
    }
    if (
      pendingTerminalization?.state === "terminal_handoff_unresolved" ||
      pendingTerminalHandoffBarrier?.state === "unresolved"
    ) {
      recordTrace("server:conversation-run:terminal-runtime-handoff-unresolved", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: pendingTerminalization?.terminalHandoffReason ?? pendingTerminalHandoffBarrier?.reason,
        attempts: pendingTerminalization?.terminalHandoffAttempts ?? pendingTerminalHandoffBarrier?.attempts ?? 0,
      });
      return;
    }
    const pollMs = normalizeIntervalMs(options.resolveLifecycleReconcilePollMs?.()) ?? 1_000;
    const generalMaxAttempts = Math.max(1, Math.floor(options.resolveLifecycleReconcileMaxAttempts?.() ?? 600));
    const maxAttempts = generalMaxAttempts;
    if (lifecycleReconcileInFlight.has(key)) {
      scheduleLifecycleReconcile({
        ...input,
        conversationId,
        runId,
        delayMs: pollMs,
      });
      return;
    }

    const attempt = input.attempt ?? 0;
    const scheduleNextAttempt = async (status?: LifecycleRunStatusResult | null) => {
      const nextAttempt = attempt + 1;
        if (nextAttempt >= maxAttempts) {
        recordTrace("server:conversation-run:lifecycle-reconcile-exhausted", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          abortRequested: input.abortRequested === true,
          attempts: nextAttempt,
          status: status?.status ?? null,
          stale: status?.stale ?? null,
          ...lifecycleStatusTraceFields(status),
        });
        if (input.terminalFailureReason) {
          // This recovery path may not manufacture a terminal state just
          // because its observation budget ran out. The durable active run and
          // its reservation remain the fence until an exact owner-loss or
          // terminal lifecycle observation arrives.
          recordTrace("server:conversation-run:lifecycle-reconcile-recovery-fenced", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: input.reason,
            terminalFailureReason: input.terminalFailureReason,
            attempts: nextAttempt,
            ...lifecycleStatusTraceFields(status),
          });
          return;
        }
        if (
          status?.stale === true &&
          !isActiveLifecycleStatus(status.status) &&
          status.runtimeReadyForSuccessor !== true
        ) {
          persistTerminalHandoffUnresolved({
            workspaceId: input.workspace.id,
            runId,
            status,
            reason: "reconcile_exhausted",
          });
          recordTrace("server:conversation-run:terminal-runtime-handoff-unresolved", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: "reconcile_exhausted",
            attempts: nextAttempt,
            ...lifecycleStatusTraceFields(status),
          });
          return;
        }
        const exhaustedDecision = classifyExhaustedReconciliation(status);
        if (exhaustedDecision.kind === "terminalization-required") {
          requestTerminalTranscriptIngest(input, "failed", "reconcile-exhausted");
          await lifecycleOwner.markFailed(
            input.workspace.id,
            status?.runId?.trim() || runId,
            "run lifecycle reconcile exhausted while active status remained unresolved",
          ).then(() => {
            recordTrace("server:conversation-run:lifecycle-reconcile-exhausted-failed", {
              workspaceId: input.workspace.id,
              conversationId,
              runId: status?.runId?.trim() || runId,
              reason: input.reason,
              attempts: nextAttempt,
              status: status?.status ?? null,
              stale: status?.stale ?? null,
              ...lifecycleStatusTraceFields(status),
            });
            unregisterScheduledAiGatewayRun(input);
            releaseRun(input.workspace.id, status?.runId?.trim() || runId, "unresolved-reconcile-failed");
            scheduleQueueDrain(input.workspace.id, conversationId, 0);
          }).catch((error) => {
            scheduleTerminalizationRetry({
              workspace: input.workspace,
              conversationId,
              runId: status?.runId?.trim() || runId,
              reasonCode: "reconcile_exhausted",
              attempts: 1,
              lastError: terminalizationErrorMessage(error),
              deadlineAt: Date.now() + 300_000,
              onTerminalized: () => unregisterScheduledAiGatewayRun(input),
            });
            recordTrace("server:conversation-run:lifecycle-mark-failed-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId: status?.runId?.trim() || runId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (exhaustedDecision.kind === "background-observe-no-output") {
          const backgroundDelayMs = Math.max(pollMs, NO_OUTPUT_MODEL_RETRY_BACKGROUND_POLL_MS);
          recordTrace("server:conversation-run:model-retry-background-reconcile", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            attempts: nextAttempt,
            delayMs: backgroundDelayMs,
            ...lifecycleStatusTraceFields(status),
          });
          scheduleLifecycleReconcile({
            ...input,
            conversationId,
            runId,
            attempt: 0,
            delayMs: backgroundDelayMs,
          });
        }
        return;
      }
      scheduleLifecycleReconcile({
        ...input,
        conversationId,
        runId,
        attempt: nextAttempt,
        delayMs: pollMs,
      });
    };

    lifecycleReconcileInFlight.add(key);
    try {
      const status = await lifecycleOwner.status(input.workspace.id, conversationId, runId);
      recordTrace("server:conversation-run:lifecycle-reconcile", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        ...lifecycleStatusTraceFields(status),
        attempt,
      });
      const evidence = classifyReconciliationEvidence({
        status,
        reason: input.reason,
        now: Date.now(),
        startupOrphanedAssistantMessageGraceMs: STARTUP_ORPHANED_ASSISTANT_MESSAGE_GRACE_MS,
        engineUnreachableWithoutProgressGraceMs: ENGINE_UNREACHABLE_GRACE_MS,
      });

      const abortRecoveryRacedWithStatus = providerStartAbortRecoveries.get(
        providerStartAbortRecoveryKey(input.workspace.id, conversationId, runId),
      );
      if (
        abortRecoveryRacedWithStatus &&
        (evidence.kind === "authoritative-absence" || evidence.kind === "active" || evidence.kind === "unavailable")
      ) {
        if (input.reason === PROVIDER_START_ABORT_RETRY_REASON) {
          await recoverProviderStartTimeout(
            abortRecoveryRacedWithStatus.input,
            abortRecoveryRacedWithStatus.lifecycleOwner,
            abortRecoveryRacedWithStatus.timeoutMs,
          );
        } else {
          scheduleProviderStartTimeoutAbortRetry(
            abortRecoveryRacedWithStatus.input,
            abortRecoveryRacedWithStatus.lifecycleOwner,
            abortRecoveryRacedWithStatus.timeoutMs,
          );
        }
        return;
      }

      if (evidence.kind === "authoritative-absence") {
        if (input.terminalFailureReason) {
          recordTrace("server:conversation-run:lifecycle-reconcile-recovery-owner-unconfirmed", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: input.reason,
            terminalFailureReason: input.terminalFailureReason,
          });
          return;
        }
        unregisterScheduledAiGatewayRun(input);
        const queuedStarting = options.queueStore?.getForReservedRun(
          input.workspace.id,
          conversationId,
          runId,
        );
        if (queuedStarting?.state === "starting") {
          const requeued = options.queueStore?.markPending(queuedStarting.queueItemId);
          recordTrace("server:conversation-run:queue-starting-reconciled-absent", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            queueItemId: queuedStarting.queueItemId,
            requeued: Boolean(requeued),
          });
        }
        releaseRun(input.workspace.id, runId, "lifecycle-status-missing");
        if (input.abortRequested === true) {
          await lifecycleOwner.markAborted(
            input.workspace.id,
            runId,
            "user abort reconciled after missing lifecycle status",
          ).catch((error) => {
            recordTrace("server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        scheduleQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }
      // `authoritative-absence` is the only null classification. Keep this
      // guard explicit at the facade boundary so all later effect paths retain
      // the exact lifecycle response they were classified from.
      if (!status) return;

      if (evidence.kind === "terminalization-required" && evidence.reasonCode === "startup_orphaned_assistant_message") {
        recordTrace("server:conversation-run:lifecycle-reconcile-startup-orphaned", {
          workspaceId: input.workspace.id,
          conversationId,
          runId: status.runId?.trim() || runId,
          reason: input.reason,
          ...lifecycleStatusTraceFields(status),
        });
        await lifecycleOwner.markFailed(
          input.workspace.id,
          status.runId?.trim() || runId,
          "startup lifecycle reservation had no useful progress while its assistant message remained open",
        ).then(() => {
          unregisterScheduledAiGatewayRun(input);
          releaseRun(input.workspace.id, status.runId?.trim() || runId, "startup-orphaned-assistant-message");
          scheduleQueueDrain(input.workspace.id, conversationId, 0);
        }).catch((error) => {
          scheduleTerminalizationRetry({
            workspace: input.workspace,
            conversationId,
            runId: status.runId?.trim() || runId,
            reasonCode: "startup_orphaned_assistant_message",
            attempts: 1,
            lastError: terminalizationErrorMessage(error),
            deadlineAt: Date.now() + 300_000,
            onTerminalized: () => unregisterScheduledAiGatewayRun(input),
          });
          recordTrace("server:conversation-run:lifecycle-mark-failed-error", {
            workspaceId: input.workspace.id,
            conversationId,
            runId: status.runId?.trim() || runId,
            reason: input.reason,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      if (evidence.kind === "terminalization-required" && evidence.reasonCode === "engine_unreachable_without_progress") {
        recordTrace("server:conversation-run:lifecycle-reconcile-engine-unreachable", {
          workspaceId: input.workspace.id,
          conversationId,
          runId: status.runId?.trim() || runId,
          reason: input.reason,
          ...lifecycleStatusTraceFields(status),
        });
        await lifecycleOwner.markFailed(
          input.workspace.id,
          status.runId?.trim() || runId,
          "engine remained unreachable after useful run progress stopped",
        ).then(() => {
          unregisterScheduledAiGatewayRun(input);
          releaseRun(input.workspace.id, status.runId?.trim() || runId, "engine-unreachable-without-progress");
          scheduleQueueDrain(input.workspace.id, conversationId, 0);
        }).catch((error) => {
          scheduleTerminalizationRetry({
            workspace: input.workspace,
            conversationId,
            runId: status.runId?.trim() || runId,
            reasonCode: "engine_unreachable_without_progress",
            attempts: 1,
            lastError: terminalizationErrorMessage(error),
            deadlineAt: Date.now() + 300_000,
            onTerminalized: () => unregisterScheduledAiGatewayRun(input),
          });
          recordTrace("server:conversation-run:lifecycle-mark-failed-error", {
            workspaceId: input.workspace.id,
            conversationId,
            runId: status.runId?.trim() || runId,
            reason: input.reason,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      const terminalHandoffRecoveryKey = providerStartAbortRecoveryKey(
        input.workspace.id,
        conversationId,
        runId,
      );
      const requestedReservation = workspaceRunReservations
        .get(normalizeWorkspaceExecutionKey(input.workspace.id))
        ?.get(runId);
      const requestedBarrier = terminalHandoffBarrier(input.workspace.id, conversationId, runId);
      if (
        status.stale === true &&
        !isActiveLifecycleStatus(status.status) &&
        status.runtimeReadyForSuccessor !== true &&
        status.unavailableReason === "no_current_engine" &&
        (
          requestedReservation?.state === "terminal_handoff_pending" ||
          requestedBarrier?.state === "evidence_requested"
        )
      ) {
        if (requestedReservation?.state === "terminal_handoff_pending") {
          persistTerminalHandoffUnresolved({
            workspaceId: input.workspace.id,
            runId,
            status,
            reason: "recovery_result_not_confirmed",
          });
        }
        markTerminalHandoffBarrierUnresolved({
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: "recovery_result_not_confirmed",
        });
        recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:suppressed", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: "recovery_result_not_confirmed",
          ...lifecycleStatusTraceFields(status),
        });
        return;
      }
      if (
        status.stale === true &&
        !isActiveLifecycleStatus(status.status) &&
        status.runtimeReadyForSuccessor !== true &&
        status.unavailableReason === "no_current_engine" &&
        (staleTerminalHandoffRecoveryAttempts.get(terminalHandoffRecoveryKey) ?? 0) === 0
      ) {
        const persistedReservation = workspaceRunReservations
          .get(normalizeWorkspaceExecutionKey(input.workspace.id))
          ?.get(runId);
        const persistedBarrier = terminalHandoffBarrier(input.workspace.id, conversationId, runId);
        if (
          persistedReservation?.state === "terminal_handoff_pending" ||
          persistedBarrier?.state === "evidence_requested"
        ) {
          if (persistedReservation?.state === "terminal_handoff_pending") {
            persistTerminalHandoffUnresolved({
              workspaceId: input.workspace.id,
              runId,
              status,
              reason: "recovery_result_not_confirmed",
            });
          }
          markTerminalHandoffBarrierUnresolved({
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: "recovery_result_not_confirmed",
          });
          recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:suppressed", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: "already_requested",
            ...lifecycleStatusTraceFields(status),
          });
          return;
        }
        const reservationPending = persistTerminalHandoffPending({ workspaceId: input.workspace.id, runId, status });
        const barrierObserved = reservationPending
          ? null
          : options.queueStore?.observeTerminalHandoffBarrier({
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            fingerprint: terminalHandoffFingerprint(input.workspace.id, runId, status),
            reason: status.unavailableReason ?? "unknown",
          }) ?? null;
        const barrierPending = barrierObserved?.state === "observed"
          ? options.queueStore?.requestTerminalHandoffBarrierEvidence({
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            fingerprint: terminalHandoffFingerprint(input.workspace.id, runId, status),
            reason: status.unavailableReason ?? "unknown",
          }) ?? null
          : null;
        if (!reservationPending && !barrierPending) {
          recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:suppressed", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            // The independent barrier is the durable owner when an old
            // reservation was already released before the server restarted.
            reason: barrierObserved?.state === "unresolved" ? "barrier_unresolved" : "barrier_not_claimed",
          });
          return;
        }
        staleTerminalHandoffRecoveryAttempts.set(terminalHandoffRecoveryKey, 1);
        recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:start", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          ...lifecycleStatusTraceFields(status),
        });
        try {
          await lifecycleOwner.recoverTerminalRuntimeHandoff(input.workspace.id, runId);
          recordTrace("server:conversation-run:terminal-runtime-handoff-recovery", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            outcome: "requested",
          });
          scheduleLifecycleReconcile({
            ...input,
            conversationId,
            runId,
            reason: "terminal-runtime-handoff-recovered",
            attempt: 0,
            delayMs: 0,
          });
          return;
        } catch (error) {
          if (reservationPending) {
            persistTerminalHandoffUnresolved({
              workspaceId: input.workspace.id,
              runId,
              status,
              reason: lifecycleErrorReason(error),
            });
          }
          markTerminalHandoffBarrierUnresolved({
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            reason: lifecycleErrorReason(error),
          });
          recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:error", {
            workspaceId: input.workspace.id,
            conversationId,
            runId,
            errorKind: lifecycleErrorKind(error),
            lifecycleHttpStatus: lifecycleErrorHttpStatus(error),
          });
        }
      }

      if (evidence.kind === "unavailable") {
        recordTrace("server:conversation-run:lifecycle-reconcile-stale", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          status: status.status,
          abortRequested: input.abortRequested === true,
          attempt,
        });
        await scheduleNextAttempt(status);
        return;
      }

      if (evidence.kind === "terminal") {
        if (status.runtimeReadyForSuccessor !== true) {
          const providerStartHandoffKey = providerStartAbortRecoveryKey(
            input.workspace.id,
            conversationId,
            runId,
          );
          if (
            input.reason === "provider-start-timeout-aborted" &&
            attempt + 1 >= PROVIDER_START_TERMINAL_HANDOFF_RECOVERY_ATTEMPT &&
            (providerStartHandoffRecoveryAttempts.get(providerStartHandoffKey) ?? 0) <
              PROVIDER_START_TERMINAL_HANDOFF_RECOVERY_MAX_ATTEMPTS
          ) {
            const recoveryAttempt = (providerStartHandoffRecoveryAttempts.get(providerStartHandoffKey) ?? 0) + 1;
            recordTrace("server:conversation-run:provider-start-timeout-handoff-recovery:start", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              attempt: recoveryAttempt,
              ...lifecycleStatusTraceFields(status),
            });
            try {
              // Keep the destructive generation check and suspend ordered with
              // server-side admission. The orchestrator repeats the exact-owner
              // and active-peer checks, which also protects callers outside this
              // process, but a new local submit must not slip in between them.
              const recoveryRequested = await withWorkspaceExecutionGate(input.workspace.id, async () => {
                const reservation = workspaceRunReservations
                  .get(normalizeWorkspaceExecutionKey(input.workspace.id))
                  ?.get(runId);
                if (!reservation) return false;
                providerStartHandoffRecoveryAttempts.set(providerStartHandoffKey, recoveryAttempt);
                await lifecycleOwner.recoverProviderStartTimeout(input.workspace.id, runId);
                return true;
              });
              if (!recoveryRequested) {
                recordTrace("server:conversation-run:provider-start-timeout-handoff-recovery:stale", {
                  workspaceId: input.workspace.id,
                  conversationId,
                  runId,
                  attempt: recoveryAttempt,
                });
                return;
              }
              recordTrace("server:conversation-run:provider-start-timeout-handoff-recovery", {
                workspaceId: input.workspace.id,
                conversationId,
                runId,
                attempt: recoveryAttempt,
                outcome: "requested",
              });
              scheduleLifecycleReconcile({
                ...input,
                conversationId,
                runId,
                reason: "provider-start-timeout-runtime-recovered",
                attempt: 0,
                delayMs: 0,
              });
              return;
            } catch (error) {
              recordTrace("server:conversation-run:provider-start-timeout-handoff-recovery:error", {
                workspaceId: input.workspace.id,
                conversationId,
                runId,
                attempt: recoveryAttempt,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          recordTrace("server:conversation-run:lifecycle-terminal-handoff-pending", {
            workspaceId: input.workspace.id,
            conversationId,
            runId: status.runId?.trim() || runId,
            status: status.status,
            runtimeReadyForSuccessor: status.runtimeReadyForSuccessor ?? null,
            ...lifecycleStatusTraceFields(status),
          });
          await scheduleNextAttempt(status);
          return;
        }
        unregisterScheduledAiGatewayRun(input);
        // Resolution is durable and independent from the predecessor
        // reservation: an unclean restart may have already removed that row.
        options.queueStore?.resolveTerminalHandoffBarrier({
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: `runtime_ready_${status.status}`,
        });
        releaseRun(input.workspace.id, status.runId?.trim() || runId, `lifecycle-terminal-${status.status}`);
        if (
          input.abortRequested === true &&
          input.reason !== PROVIDER_START_ABORT_RETRY_REASON &&
          status.status !== "aborted"
        ) {
          const terminalize = input.terminalFailureReason
            ? lifecycleOwner.markFailed(
                input.workspace.id,
                runId,
                input.terminalFailureReason,
              )
            : lifecycleOwner.markAborted(
                input.workspace.id,
                runId,
                "user abort reconciled after engine became inactive",
              );
          await terminalize.catch((error) => {
            recordTrace(input.terminalFailureReason
              ? "server:conversation-run:lifecycle-mark-failed-error"
              : "server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              terminalFailureReason: input.terminalFailureReason ?? null,
              status: status.status,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        requestTerminalTranscriptIngest(input, status.status, "lifecycle-terminal");
        scheduleQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }

      await scheduleNextAttempt(status);
    } catch (error) {
      recordTrace("server:conversation-run:lifecycle-reconcile-error", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      await scheduleNextAttempt();
    } finally {
      lifecycleReconcileInFlight.delete(key);
    }
  }

  async function drainConversationQueue(workspaceId: string, conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!workspaceId.trim() || !normalizedConversationId || !options.queueStore) return;
    const key = queueKey(workspaceId, normalizedConversationId);
    if (queueDrainInFlight.has(key)) return;
    queueDrainInFlight.add(key);
    let item = null as ReturnType<ConversationRunQueueStore["nextPending"]>;
    let runTrace: ConversationRunLifecycleTracer | null = null;
    let predecessorStatus: LifecycleRunStatusResult | null = null;
    try {
      const workspace = options.resolveWorkspace?.(workspaceId) ?? null;
      if (!workspace) return;
      const lifecycleOwner = workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
      runTrace = options.createBackgroundRunTrace?.() ?? createNoopRunTrace();
      const initialRuntimeOperation = await withWorkspaceExecutionGate(workspaceId, async () =>
        activeWorkspaceRuntimeOperation(workspaceId),
      );
      if (initialRuntimeOperation) {
        recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-runtime-operation-deferred", {
          workspaceId,
          conversationId: normalizedConversationId,
          decisionKey: `${initialRuntimeOperation.operationId}\0${initialRuntimeOperation.state}`,
          payload: {
            operationId: initialRuntimeOperation.operationId,
            operationKind: initialRuntimeOperation.kind,
            operationState: initialRuntimeOperation.state,
          },
        });
        if (initialRuntimeOperation.state !== "outcome_unknown") {
          scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
        } else {
          clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        }
        return;
      }
      const waitingItem = options.queueStore.nextPending(workspaceId, normalizedConversationId);
      if (!waitingItem) {
        clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        clearQueueDrainReservationConflicts(workspaceId, normalizedConversationId);
        return;
      }
      const waitingItemTraceFields = {
        queueItemId: waitingItem.queueItemId,
        runId: waitingItem.reservedRunId,
        clientMessageId: waitingItem.clientMessageId,
        attempts: waitingItem.attempts,
        queueWaitMs: Math.max(0, Date.now() - waitingItem.createdAt),
      };
      if (lifecycleOwner) {
        try {
          const predecessor = await classifyPredecessor({
            workspace,
            conversationId: normalizedConversationId,
            lifecycleOwner,
            runTrace,
            source: "queue-drain",
          });
          predecessorStatus = predecessor.status;
          if (predecessor.kind === "terminal_handoff_unresolved") {
            const { clientMessageId: blockingClientMessageId, ...blockingLifecycleTraceFields } = lifecycleStatusTraceFields(predecessor.status);
            const fingerprint = terminalHandoffFingerprint(workspaceId, predecessor.status.runId, predecessor.status);
            const observedBarrier = terminalHandoffBarrier(workspaceId, normalizedConversationId, predecessor.status.runId) ??
              options.queueStore?.observeTerminalHandoffBarrier({
                workspaceId,
                conversationId: normalizedConversationId,
                runId: predecessor.status.runId,
                fingerprint,
                reason: predecessor.reason,
              }) ?? null;
            if (observedBarrier?.state === "observed") {
              options.queueStore?.requestTerminalHandoffBarrierEvidence({
                workspaceId,
                conversationId: normalizedConversationId,
                runId: predecessor.status.runId,
                fingerprint,
                reason: predecessor.reason,
              });
            }
            markTerminalHandoffBarrierUnresolved({
              workspaceId,
              conversationId: normalizedConversationId,
              runId: predecessor.status.runId,
              reason: predecessor.reason,
            });
            recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-terminal-handoff-unresolved", {
              workspaceId,
              conversationId: normalizedConversationId,
              decisionKey: `${waitingItem.queueItemId}\0${predecessor.status.runId}\0${predecessor.reason}`,
              payload: {
                ...waitingItemTraceFields,
                blockingRunId: predecessor.status.runId,
                reason: predecessor.reason,
                blockingClientMessageId,
                ...blockingLifecycleTraceFields,
              },
            });
            // An unresolved barrier has a server-owned explicit retry path.
            // Do not keep the queued intent in a periodic drain loop.
            return;
          }
          if (predecessor.kind === "terminal_handoff_pending") {
            const { clientMessageId: blockingClientMessageId, ...blockingLifecycleTraceFields } = lifecycleStatusTraceFields(predecessor.status);
            recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-terminal-handoff-deferred", {
              workspaceId,
              conversationId: normalizedConversationId,
              decisionKey: `${waitingItem.queueItemId}\0${predecessor.status.runId}\0${predecessor.status.status}\0${predecessor.status.waitReason ?? ""}`,
              payload: {
                status: predecessor.status.status,
                blockingRunId: predecessor.status.runId,
                ...waitingItemTraceFields,
                queuedClientMessageId: waitingItem.clientMessageId,
                blockingClientMessageId,
                ...blockingLifecycleTraceFields,
              },
            });
            scheduleLifecycleReconcile({
              workspace,
              conversationId: normalizedConversationId,
              runId: predecessor.status.runId,
              reason: "queue-drain-terminal-handoff-pending",
              delayMs: queueDrainPollMs,
            });
            return;
          }
          if (predecessor.kind === "active_exact_owner") {
            const { clientMessageId: blockingClientMessageId, ...blockingLifecycleTraceFields } = lifecycleStatusTraceFields(predecessor.status);
            if (predecessor.status.stale === true) {
              const activeRunId = predecessor.status.runId?.trim() || "latest";
              recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-stale-active-deferred", {
                workspaceId,
                conversationId: normalizedConversationId,
                decisionKey: `${waitingItem.queueItemId}\0${activeRunId}\0${predecessor.status.status}\0${predecessor.status.waitReason ?? ""}`,
                payload: {
                  status: predecessor.status.status,
                  stale: predecessor.status.stale,
                  blockingRunId: activeRunId,
                  ...waitingItemTraceFields,
                  blockingClientMessageId,
                  ...blockingLifecycleTraceFields,
                },
              });
              scheduleLifecycleReconcile({
                workspace,
                conversationId: normalizedConversationId,
                runId: activeRunId,
                reason: "queue-drain-active-stale",
                delayMs: 0,
              });
              return;
            }
            recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-active-deferred", {
              workspaceId,
              conversationId: normalizedConversationId,
              decisionKey: `${waitingItem.queueItemId}\0${predecessor.status.runId ?? "latest"}\0${predecessor.status.status}\0${predecessor.status.waitReason ?? ""}`,
              payload: {
                status: predecessor.status.status,
                stale: false,
                blockingRunId: predecessor.status.runId ?? null,
                ...waitingItemTraceFields,
                queuedClientMessageId: waitingItem.clientMessageId,
                blockingClientMessageId,
                ...blockingLifecycleTraceFields,
              },
            });
            scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
            return;
          }
        } catch (error) {
          recordQueueDrainBlockingDecision(runTrace, "server:conversation-run:queue-drain-status-error", {
            workspaceId,
            conversationId: normalizedConversationId,
            decisionKey: `${waitingItem.queueItemId}\0${lifecycleErrorKind(error)}\0${lifecycleErrorHttpStatus(error) ?? ""}`,
            payload: {
              queueItemId: waitingItem.queueItemId,
              runId: waitingItem.reservedRunId,
              clientMessageId: waitingItem.clientMessageId,
              errorKind: lifecycleErrorKind(error),
              lifecycleHttpStatus: lifecycleErrorHttpStatus(error),
              nextRetryInMs: queueDrainPollMs,
            },
          });
          scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
          return;
        }
      }

      item = options.queueStore.nextPending(workspaceId, normalizedConversationId);
      if (!item) {
        clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        clearQueueDrainReservationConflicts(workspaceId, normalizedConversationId);
        return;
      }
      let claim: ReturnType<ConversationRunQueueStore["claimStartingWithReservation"]>;
      try {
        claim = await withWorkspaceExecutionGate(workspaceId, async () => {
          if (activeWorkspaceRuntimeOperation(workspaceId)) return null;
          return options.queueStore?.claimStartingWithReservation(item?.queueItemId ?? "") ?? null;
        });
      } catch (error) {
        if (error instanceof ConversationRunReservationConflictError) {
          const activeRunId = error.activeRunId.trim();
          const conflictKey = `${workspaceId}\0${normalizedConversationId}\0${item.queueItemId}\0${activeRunId}`;
          const conflictAttempts = (queueDrainReservationConflicts.get(conflictKey) ?? 0) + 1;
          queueDrainReservationConflicts.set(conflictKey, conflictAttempts);
          if (conflictAttempts >= QUEUE_DRAIN_RESERVATION_CONFLICT_MAX_ATTEMPTS) {
            if (activeRunId) {
              const conflictStatus = predecessorStatus?.runId.trim() === activeRunId
                ? predecessorStatus
                : null;
              const fingerprint = conflictStatus
                ? terminalHandoffFingerprint(workspaceId, activeRunId, conflictStatus)
                : `${normalizeWorkspaceExecutionKey(workspaceId)}\0${activeRunId}\0reservation_conflict_unresolved`;
              const observedBarrier = terminalHandoffBarrier(workspaceId, normalizedConversationId, activeRunId) ??
                options.queueStore.observeTerminalHandoffBarrier({
                  workspaceId,
                  conversationId: normalizedConversationId,
                  runId: activeRunId,
                  fingerprint,
                  reason: "reservation_conflict_unresolved",
                });
              if (observedBarrier.state === "observed") {
                options.queueStore.requestTerminalHandoffBarrierEvidence({
                  workspaceId,
                  conversationId: normalizedConversationId,
                  runId: activeRunId,
                  fingerprint,
                  reason: "reservation_conflict_unresolved",
                });
              }
              markTerminalHandoffBarrierUnresolved({
                workspaceId,
                conversationId: normalizedConversationId,
                runId: activeRunId,
                reason: "reservation_conflict_unresolved",
              });
            }
            recordQueueDrainBlockingDecision(
              runTrace,
              "server:conversation-run:queue-drain-reservation-conflict-unresolved",
              {
                workspaceId,
                conversationId: normalizedConversationId,
                decisionKey: `${item.queueItemId}\0${activeRunId}`,
                payload: {
                  ...waitingItemTraceFields,
                  blockingRunId: activeRunId || null,
                  reason: "reservation_conflict_unresolved",
                  reservationConflictAttempts: conflictAttempts,
                },
              },
            );
            return;
          }
          recordTrace("server:conversation-run:queue-drain-reservation-conflict", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            activeRunId,
            reservationConflictAttempts: conflictAttempts,
          });
          if (activeRunId) {
            // A terminal predecessor can retain its durable reservation after
            // an unclean restart even though lifecycle admission is ready.
            // Only this exact run, proven terminal with a lost engine owner,
            // may skip the provider-start abort deferral during that release.
            const conflictStatus = predecessorStatus?.runId.trim() === activeRunId ? predecessorStatus : null;
            scheduleLifecycleReconcile({
              workspace,
              conversationId: normalizedConversationId,
              runId: activeRunId,
              reason: "queue-drain-reservation-conflict",
              delayMs: 0,
              predecessorReleaseProven: Boolean(
                conflictStatus &&
                !isActiveLifecycleStatus(conflictStatus.status) &&
                conflictStatus.engineOwnerState === "lost" &&
                conflictStatus.runtimeReadyForSuccessor === true,
              ),
            });
          }
          scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
          return;
        }
        throw error;
      }
      if (!claim || claim.item.state !== "starting") {
        const runtimeOperation = activeWorkspaceRuntimeOperation(workspaceId);
        const event = runtimeOperation
          ? "server:conversation-run:queue-drain-runtime-operation-deferred"
          : "server:conversation-run:queue-drain-claim-lost";
        recordQueueDrainBlockingDecision(runTrace, event, {
          workspaceId,
          conversationId: normalizedConversationId,
          decisionKey: runtimeOperation
            ? `${runtimeOperation.operationId}\0${runtimeOperation.state}`
            : `${item.queueItemId}\0${claim?.item.state ?? "none"}`,
          payload: {
            queueItemId: item.queueItemId,
            ...(runtimeOperation
              ? {
                operationId: runtimeOperation.operationId,
                operationKind: runtimeOperation.kind,
                operationState: runtimeOperation.state,
              }
              : {}),
            state: claim?.item.state ?? null,
          },
        });
        if (runtimeOperation && runtimeOperation.state !== "outcome_unknown") {
          scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
        } else {
          clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        }
        return;
      }
      item = claim.item;
      clearQueueDrainReservationConflicts(workspaceId, normalizedConversationId);
      reservationsForWorkspace(workspaceId).set(claim.reservation.runId, claim.reservation);
      clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
      runTrace.record("server:conversation-run:queue-drain-claimed", {
        workspaceId,
        conversationId: normalizedConversationId,
        queueItemId: item.queueItemId,
        runId: item.reservedRunId,
        attempts: item.attempts,
        queueWaitMs: Math.max(0, Date.now() - item.createdAt),
      });

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(item.bodyJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("queued run body must be an object");
        }
        body = parsed as Record<string, unknown>;
      } catch (error) {
        const failed = options.queueStore.markFailed(
          item.queueItemId,
          error instanceof Error ? error.message : String(error),
        );
        if (failed) {
          runTrace.record("server:conversation-run:queue-drain-invalid-body-failed", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            runId: item.reservedRunId,
            queueWaitMs: Math.max(0, Date.now() - item.createdAt),
          });
        }
        clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        if (!failed) {
          runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            transition: "failed",
          });
        }
        return;
      }

      const kind = parseQueuedRunKind(item.kind);
      const expectAiGatewayStart = optionalBodyBoolean(body, "expectAiGatewayStart") === true;
      const runtimeAuthorizationActorTokenHash =
        optionalBodyString(body, "runtimeAuthorizationActorTokenHash") || null;
      const runtimeAuthorizationOrgId = optionalBodyString(body, "runtimeAuthorizationOrgId") || null;
      const target: ConversationRunLifecycleTarget = {
        directory: item.directory,
        binding: null,
        opencodeSessionId: item.opencodeSessionId,
        conversationId: item.conversationId,
      };
      const queuedItem = item;
      const queuedRunTrace = runTrace;
      if (!queuedItem || !queuedRunTrace) {
        throw new Error("queue drain lost its claimed item or trace");
      }
      // OpenCode orders turns lexicographically by message ID. `createdAt` is
      // the time the user queued this draft, which can predate the assistant
      // turn that finishes while it waits. The queue store therefore derives
      // and persists the id at the atomic first claim. Reusing that durable id
      // prevents an uncertain transport retry from becoming a second OpenCode
      // user message after a controller restart.
      const queuedSubmitInput = withOpenCodeAdmissionMessageId({
        runTrace: queuedRunTrace,
        workspace,
        target,
        runId: queuedItem.reservedRunId,
        kind,
        body,
        clientMessageId: queuedItem.clientMessageId,
        queueItemId: queuedItem.queueItemId,
        opencodeMessageId: queuedItem.opencodeMessageId,
        origin: queuedItem.origin,
        expectAiGatewayStart,
        runtimeAuthorizationActorTokenHash,
        runtimeAuthorizationOrgId,
      }, queuedItem.startedAt ?? Date.now());

      try {
        persistPromptIdentity(queuedSubmitInput);
      } catch (error) {
        releaseRun(workspaceId, queuedItem.reservedRunId, "prompt-identity-persistence-failed");
        throw error;
      }

      if (lifecycleOwner) {
        let lifecycleRegistered = false;
        try {
          await withWorkspaceExecutionGate(workspace.id, async () => {
            await queuedRunTrace.step(
              "server:conversation-run:queue-lifecycle-register",
              () => lifecycleOwner.register({
                workspaceId: workspace.id,
                conversationId: queuedItem.conversationId,
                runId: queuedItem.reservedRunId,
                opencodeSessionId: queuedItem.opencodeSessionId,
                clientMessageId: queuedItem.clientMessageId,
            opencodeMessageId: queuedSubmitInput.opencodeMessageId ?? null,
            origin: queuedItem.origin,
            expectsAiGatewayStart: queuedSubmitInput.expectAiGatewayStart,
            runtimeAuthorizationActorTokenHash: queuedSubmitInput.runtimeAuthorizationActorTokenHash ?? null,
            runtimeAuthorizationOrgId: queuedSubmitInput.runtimeAuthorizationOrgId ?? null,
            directory: queuedItem.directory,
                kind: lifecycleRunKind(kind),
              }),
              {
                workspaceId: workspace.id,
                conversationId: queuedItem.conversationId,
                runId: queuedItem.reservedRunId,
                opencodeSessionId: queuedItem.opencodeSessionId,
                queueItemId: queuedItem.queueItemId,
              },
            );
            lifecycleRegistered = true;
            await submitAcceptedRun(queuedSubmitInput, lifecycleOwner);
          });
        } catch (error) {
          if (lifecycleRegistered) throw error;
          if (error instanceof RunAlreadyActiveError || error instanceof ConversationRunReservationConflictError) {
            releaseRun(workspaceId, queuedItem.reservedRunId, "queue-lifecycle-register-conflict");
            const pending = options.queueStore.markPending(item.queueItemId, error.activeRunId);
            if (!pending) {
              runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
                workspaceId,
                conversationId: normalizedConversationId,
                queueItemId: item.queueItemId,
                transition: "pending",
              });
              return;
            }
            queuedRunTrace.record("server:conversation-run:queue-drain-register-conflict-requeued", {
              workspaceId,
              conversationId: normalizedConversationId,
              queueItemId: item.queueItemId,
              runId: item.reservedRunId,
              activeRunId: error.activeRunId,
              attempts: pending.attempts,
            });
            scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
            return;
          }
          scheduleUnconfirmedRegistrationRecovery(queuedSubmitInput, "queue-lifecycle-register-unconfirmed");
          return;
        }
      } else {
        await withWorkspaceExecutionGate(workspace.id, async () => {
          await submitAcceptedRun(queuedSubmitInput, lifecycleOwner);
        });
      }

      const submitted = options.queueStore.markSubmitted(item.queueItemId);
      if (!submitted) {
        runTrace.record("server:conversation-run:queue-drain-terminal-transition-stale", {
          workspaceId,
          conversationId: normalizedConversationId,
          queueItemId: item.queueItemId,
          transition: "submitted",
        });
      } else {
        runTrace.record("server:conversation-run:queue-drain-submitted", {
          workspaceId,
          conversationId: normalizedConversationId,
          queueItemId: item.queueItemId,
          runId: item.reservedRunId,
          attempts: submitted.attempts,
          queueWaitMs: Math.max(0, (submitted.submittedAt ?? Date.now()) - item.createdAt),
        });
      }
      scheduleQueueDrain(workspaceId, normalizedConversationId, queueDrainPollMs);
    } catch (error) {
      if (item) {
        const failed = options.queueStore.markFailed(
          item.queueItemId,
          error instanceof Error ? error.message : String(error),
        );
        if (failed) {
          (runTrace ?? createNoopRunTrace()).record("server:conversation-run:queue-drain-submit-failed", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            runId: item.reservedRunId,
            attempts: failed.attempts,
            queueWaitMs: Math.max(0, Date.now() - item.createdAt),
            message: error instanceof Error ? error.message : String(error),
          });
        }
        clearQueueDrainBlockingDecision(workspaceId, normalizedConversationId);
        if (!failed) {
          (runTrace ?? createNoopRunTrace()).record("server:conversation-run:queue-drain-terminal-transition-stale", {
            workspaceId,
            conversationId: normalizedConversationId,
            queueItemId: item.queueItemId,
            transition: "failed",
          });
        }
      }
    } finally {
      queueDrainInFlight.delete(key);
    }
  }

  async function abortRun(input: ConversationRunLifecycleAbortInput): Promise<ConversationRunLifecycleAbortResult> {
    if (!options.abortOpenCode) {
      throw new Error("OpenCode abort port is required for conversation aborts");
    }
    const runTrace = options.createBackgroundRunTrace?.() ?? createNoopRunTrace();
    const abortedGatewayRequests = options.abortActiveGatewayProxyRequests?.({
      workspaceId: input.workspace.id,
      runId: input.runId,
      sessionId: input.target.opencodeSessionId,
      reason: "conversation-abort",
    }) ?? [];

    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
    if (lifecycleOwner) {
      await lifecycleOwner.markAbortRequested(input.workspace.id, input.runId).catch((error) => {
        recordTrace("server:conversation-run:lifecycle-abort-requested-error", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      scheduleLifecycleReconcile({
        workspace: input.workspace,
        conversationId: input.target.conversationId,
        runId: input.runId,
        directory: input.target.directory,
        opencodeSessionId: input.target.opencodeSessionId,
        reason: "abort-requested",
        abortRequested: true,
        terminalFailureReason: input.terminalFailureReason,
        delayMs: 0,
      });
    }

    let upstream: unknown;
    try {
      upstream = await options.abortOpenCode({
        runTrace,
        workspace: input.workspace,
        target: input.target,
        runId: input.runId,
      });
      if (lifecycleOwner && !input.terminalFailureReason) {
        const markedAborted = await (input.terminalFailureReason
          ? lifecycleOwner.markFailed(input.workspace.id, input.runId, input.terminalFailureReason)
          : lifecycleOwner.markAborted(
              input.workspace.id,
              input.runId,
              "user abort reconciled after OpenCode abort",
            )
        ).then(() => true).catch((error) => {
          recordTrace(input.terminalFailureReason
            ? "server:conversation-run:lifecycle-mark-failed-error"
            : "server:conversation-run:lifecycle-mark-aborted-error", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            reason: "abort-requested",
            message: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        if (markedAborted) {
          scheduleLifecycleReconcile({
            workspace: input.workspace,
            conversationId: input.target.conversationId,
            runId: input.runId,
            directory: input.target.directory,
            opencodeSessionId: input.target.opencodeSessionId,
            reason: "abort-marked-terminal",
            delayMs: 0,
          });
        }
      }
    } catch (error) {
      if (!lifecycleOwner) throw error;
      const message = error instanceof Error ? error.message : String(error);
      recordTrace("server:conversation-run:opencode-abort-error", {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        runId: input.runId,
        message,
      });
      upstream = {
        ok: false,
        error: "opencode_abort_failed",
        message,
      };
    }

    return {
      upstream,
      abortedGatewayRequestCount: abortedGatewayRequests.length,
    };
  }

  const restoreStartingReservation = (workspace: WorkspaceInfo, item: ConversationRunQueueItem) => {
    const workspaceId = normalizeWorkspaceExecutionKey(workspace.id);
    const reservation = options.queueStore?.reserveWorkspaceRun({
      workspaceId,
      conversationId: item.conversationId,
      runId: item.reservedRunId,
      directory: item.directory,
      opencodeSessionId: item.opencodeSessionId,
      state: "starting",
    });
    if (reservation) reservationsForWorkspace(workspaceId).set(reservation.runId, reservation);
    return reservation;
  };

  async function recoverStartingQueueItem(item: ConversationRunQueueItem): Promise<void> {
    const workspace = options.resolveWorkspace?.(item.workspaceId) ?? null;
    if (!workspace) return;
    const lifecycleOwner = workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
    const recoveryKey = `${item.workspaceId}\0${item.queueItemId}`;
    try {
      if (!lifecycleOwner) {
        options.queueStore?.markPending(item.queueItemId);
        scheduleQueueDrain(item.workspaceId, item.conversationId, queueDrainPollMs);
        return;
      }
      const status = await lifecycleOwner.status(item.workspaceId, item.conversationId, item.reservedRunId);
      if (!status) {
        releaseRun(item.workspaceId, item.reservedRunId, "queue-starting-exact-run-absent");
        options.queueStore?.markPending(item.queueItemId);
        recordTrace("server:conversation-run:queue-starting-recovered-absent", {
          workspaceId: item.workspaceId,
          conversationId: item.conversationId,
          queueItemId: item.queueItemId,
          runId: item.reservedRunId,
        });
        scheduleQueueDrain(item.workspaceId, item.conversationId, queueDrainPollMs);
        return;
      }
      if (isActiveLifecycleStatus(status.status)) {
        restoreStartingReservation(workspace, item);
        recordTrace("server:conversation-run:queue-starting-recovered-active", {
          workspaceId: item.workspaceId,
          conversationId: item.conversationId,
          queueItemId: item.queueItemId,
          runId: item.reservedRunId,
          status: status.status,
          stale: status.stale,
          ...lifecycleStatusTraceFields(status),
        });
        scheduleLifecycleReconcile({
          workspace,
          conversationId: item.conversationId,
          runId: item.reservedRunId,
          directory: item.directory,
          opencodeSessionId: item.opencodeSessionId,
          reason: "startup-queue-starting-active",
          delayMs: 0,
        });
        return;
      }
      if (status.runtimeReadyForSuccessor !== true) {
        restoreStartingReservation(workspace, item);
        recordTrace("server:conversation-run:queue-starting-terminal-handoff-pending", {
          workspaceId: item.workspaceId,
          conversationId: item.conversationId,
          queueItemId: item.queueItemId,
          runId: item.reservedRunId,
          status: status.status,
          ...lifecycleStatusTraceFields(status),
        });
        scheduleLifecycleReconcile({
          workspace,
          conversationId: item.conversationId,
          runId: item.reservedRunId,
          directory: item.directory,
          opencodeSessionId: item.opencodeSessionId,
          reason: "startup-queue-starting-terminal-handoff",
          delayMs: queueDrainPollMs,
        });
        return;
      }
      options.queueStore?.markSubmitted(item.queueItemId);
      releaseRun(item.workspaceId, item.reservedRunId, "queue-starting-recovered-terminal");
      recordTrace("server:conversation-run:queue-starting-recovered-terminal", {
        workspaceId: item.workspaceId,
        conversationId: item.conversationId,
        queueItemId: item.queueItemId,
        runId: item.reservedRunId,
        status: status.status,
        ...lifecycleStatusTraceFields(status),
      });
      scheduleQueueDrain(item.workspaceId, item.conversationId, queueDrainPollMs);
    } catch (error) {
      recordTrace("server:conversation-run:queue-starting-recovery-error", {
        workspaceId: item.workspaceId,
        conversationId: item.conversationId,
        queueItemId: item.queueItemId,
        runId: item.reservedRunId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!startingRecoveryTimers.has(recoveryKey)) {
        const scheduled = keyedScheduler.schedule({
          namespace: "starting-recovery",
          key: recoveryKey,
          delayMs: queueDrainPollMs,
          reason: "starting-row-recovery",
          replaceExisting: false,
          run: () => {
            startingRecoveryTimers.delete(recoveryKey);
            return recoverStartingQueueItem(item);
          },
        });
        if (scheduled.kind === "scheduled") startingRecoveryTimers.set(recoveryKey, scheduled.handle);
      }
    }
  }

  function schedulePendingQueueDrains(): void {
    for (const starting of options.queueStore?.listStarting?.() ?? []) {
      void recoverStartingQueueItem(starting);
    }
    const pendingConversationKeys = options.queueStore?.pendingConversationKeys;
    if (typeof pendingConversationKeys !== "function") return;
    for (const pending of pendingConversationKeys.call(options.queueStore)) {
      scheduleQueueDrain(pending.workspaceId, pending.conversationId, queueDrainPollMs);
    }
  }

  const scheduleDiagnosticsTimer = () => {
    if (!started || diagnosticsIntervalMs === null) return;
    const handle = scheduleTimeout(() => {
      activeTimers.delete(handle);
      if (!started) return;
      diagnosticsRuns += 1;
      recordTrace("conversation-run-lifecycle:diagnostics", { runs: diagnosticsRuns });
      scheduleDiagnosticsTimer();
    }, diagnosticsIntervalMs);
    activeTimers.add(handle);
    unrefTimer(handle);
  };

  return {
    notifyEngineLoss,
    async submitRun(input) {
      return withWorkspaceExecutionGate(input.workspace.id, async () => {
      let admittedInput = input;
      const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : options.lifecycleClient ?? null;
      input.runTrace.record("server:conversation-run:lifecycle-owner", {
        workspaceId: input.workspace.id,
        runId: input.runId,
        clientMessageId: input.clientMessageId,
        queueItemId: input.queueItemId,
        origin: input.origin,
        enabled: Boolean(lifecycleOwner),
        workspaceType: input.workspace.workspaceType,
      });
      const runtimeOperation = activeWorkspaceRuntimeOperation(input.workspace.id);
      if (runtimeOperation) {
        input.runTrace.record("server:conversation-run:admission-deferred-runtime-operation", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          operationId: runtimeOperation.operationId,
          operationKind: runtimeOperation.kind,
          operationState: runtimeOperation.state,
        });
        return queueRun(input, null);
      }
      if (input.submitQueuePolicy === "server-queue-only") {
        // A queued local intent has no safe terminal/release path without the
        // lifecycle owner. Do not persist an item that the legacy standalone
        // runtime can never dispatch; callers must restore the draft and retry
        // once the daemon-backed runtime is available.
        if (input.workspace.workspaceType !== "remote" && !lifecycleOwner) {
          input.runTrace.record("server:conversation-run:queue-policy-lifecycle-unavailable", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            clientMessageId: input.clientMessageId,
            origin: input.origin,
          });
          throw new ApiError(503, "lifecycle_unavailable", "Run lifecycle owner is not configured");
        }
        input.runTrace.record("server:conversation-run:queue-policy-server-only", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          clientMessageId: input.clientMessageId,
          origin: input.origin,
        });
        return queueRun(input, null);
      }
      if (lifecycleOwner) {
        try {
          const predecessor = await classifyPredecessor({
            workspace: input.workspace,
            conversationId: input.target.conversationId,
            lifecycleOwner,
            runTrace: input.runTrace,
            source: "direct-admission",
          });
          if (predecessor.kind === "active_exact_owner") {
            if (activeRunMatchesClientMessage(predecessor.status, input)) {
              input.runTrace.record("server:conversation-run:lifecycle-active-reused", {
                workspaceId: input.workspace.id,
                conversationId: input.target.conversationId,
                runId: predecessor.status.runId,
                clientMessageId: input.clientMessageId,
                origin: input.origin,
              });
              return existingActiveRunPayload(input, predecessor.status);
            }
            return queueRun(input, predecessor.status.runId);
          }
          if (predecessor.kind === "terminal_handoff_pending") {
            return queueRun(input, predecessor.status.runId);
          }
          if (predecessor.kind === "terminal_handoff_unresolved") {
            input.runTrace.record("server:conversation-run:admission-decision", {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: input.runId,
              clientMessageId: input.clientMessageId,
              blockingRunId: predecessor.status.runId,
              decision: "blocked_terminal_handoff_unresolved",
              reason: predecessor.reason,
            });
            persistBlockedTerminalHandoffBarrier(
              input.workspace.id,
              input.target.conversationId,
              predecessor,
            );
            throw terminalHandoffRecoveryRequired(input, predecessor);
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          input.runTrace.record("server:conversation-run:lifecycle-active-peek-skipped", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof OrchestratorLifecycleRequestError) {
            throw lifecycleRequestApiError(error);
          }
          throw error;
        }
        const registerLifecycle = (event: string) => input.runTrace.step(
          event,
          () => lifecycleOwner.register({
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            opencodeSessionId: input.target.opencodeSessionId,
            clientMessageId: input.clientMessageId,
            opencodeMessageId: admittedInput.opencodeMessageId ?? null,
            origin: input.origin,
            expectsAiGatewayStart: input.expectAiGatewayStart,
            runtimeAuthorizationActorTokenHash: input.runtimeAuthorizationActorTokenHash ?? null,
            runtimeAuthorizationOrgId: input.runtimeAuthorizationOrgId ?? null,
            directory: input.target.directory,
            kind: lifecycleRunKind(input.kind),
          }),
          {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            opencodeSessionId: input.target.opencodeSessionId,
            kind: lifecycleRunKind(input.kind),
          },
        );
        try {
          admittedInput = withOpenCodeAdmissionMessageId(input);
          reserveStarting(admittedInput);
          persistPromptIdentity(admittedInput);
          const registered = await registerLifecycle("server:conversation-run:lifecycle-register");
          if (registered && registered.runId !== input.runId && activeRunMatchesClientMessage(registered, input)) {
            releaseRun(input.workspace.id, input.runId, "lifecycle-register-reused");
            input.runTrace.record("server:conversation-run:lifecycle-register-reused", {
              workspaceId: input.workspace.id,
              conversationId: input.target.conversationId,
              runId: registered.runId,
              clientMessageId: input.clientMessageId,
              origin: input.origin,
            });
            return existingActiveRunPayload(input, registered);
          }
          input.runTrace.record("server:conversation-run:admission-decision", {
            workspaceId: input.workspace.id,
            conversationId: input.target.conversationId,
            runId: input.runId,
            clientMessageId: input.clientMessageId,
            decision: "registered",
          });
        } catch (error) {
          if (error instanceof ConversationRunPromptIdentityPersistenceError) {
            releaseRun(input.workspace.id, input.runId, "prompt-identity-persistence-failed");
            throw error;
          }
          if (error instanceof RunAlreadyActiveError || error instanceof ConversationRunReservationConflictError) {
            releaseRun(input.workspace.id, input.runId, "lifecycle-register-conflict");
            let retriedAfterProvenHandoffRecovery = false;
            let retryRegistrationUnconfirmed = false;
            try {
              const predecessor = await classifyPredecessor({
                workspace: input.workspace,
                conversationId: input.target.conversationId,
                lifecycleOwner,
                runTrace: input.runTrace,
                source: "register-conflict",
              });
              if (predecessor.kind === "active_exact_owner" && activeRunMatchesClientMessage(predecessor.status, input)) {
                input.runTrace.record("server:conversation-run:lifecycle-register-conflict-reused", {
                  workspaceId: input.workspace.id,
                  conversationId: input.target.conversationId,
                  runId: predecessor.status.runId,
                  clientMessageId: input.clientMessageId,
                  origin: input.origin,
                });
                return existingActiveRunPayload(input, predecessor.status);
              }
              if (predecessor.kind === "active_exact_owner" || predecessor.kind === "terminal_handoff_pending") {
                return queueRun(input, predecessor.status.runId);
              }
              if (predecessor.kind === "terminal_handoff_unresolved") {
                input.runTrace.record("server:conversation-run:admission-decision", {
                  workspaceId: input.workspace.id,
                  conversationId: input.target.conversationId,
                  runId: input.runId,
                  clientMessageId: input.clientMessageId,
                  blockingRunId: predecessor.status.runId,
                  decision: "blocked_terminal_handoff_unresolved",
                  reason: predecessor.reason,
                });
                persistBlockedTerminalHandoffBarrier(
                  input.workspace.id,
                  input.target.conversationId,
                  predecessor,
                );
                throw terminalHandoffRecoveryRequired(input, predecessor);
              }
              if (!predecessor.recoveredTerminalHandoff) {
                return queueRun(input, error.activeRunId || null);
              }

              // The first register raced a terminal owner whose guarded
              // generation recovery has now proven it lost. One fresh read
              // made the lifecycle idle, so retry exactly once under the same
              // workspace gate and the same OpenCode idempotency key.
              reserveStarting(admittedInput);
              try {
                const retried = await registerLifecycle("server:conversation-run:lifecycle-register-after-proven-handoff-recovery");
                if (retried && retried.runId !== input.runId && activeRunMatchesClientMessage(retried, input)) {
                  releaseRun(input.workspace.id, input.runId, "lifecycle-register-retry-reused");
                  return existingActiveRunPayload(input, retried);
                }
                input.runTrace.record("server:conversation-run:admission-decision", {
                  workspaceId: input.workspace.id,
                  conversationId: input.target.conversationId,
                  runId: input.runId,
                  decision: "registered-after-proven-handoff-recovery",
                });
                // Registration succeeded; fall through to the one upstream
                // dispatch below. A second conflict is never retried.
                retriedAfterProvenHandoffRecovery = true;
              } catch (retryError) {
                if (retryError instanceof RunAlreadyActiveError || retryError instanceof ConversationRunReservationConflictError) {
                  releaseRun(input.workspace.id, input.runId, "lifecycle-register-retry-conflict");
                  return queueRun(input, retryError.activeRunId || null);
                }
                // A transport failure after the guarded retry is outcome-
                // unknown: the orchestrator may have persisted the run while
                // its response was lost. Preserve its reservation and use the
                // same reconciler as the initial registration path instead of
                // queueing a successor behind this very run.
                retryRegistrationUnconfirmed = true;
                scheduleUnconfirmedRegistrationRecovery(
                  admittedInput,
                  "lifecycle-register-after-proven-handoff-recovery-unconfirmed",
                );
                if (retryError instanceof OrchestratorLifecycleRequestError) {
                  throw lifecycleRequestApiError(retryError);
                }
                throw retryError;
              }
            } catch (activeError) {
              if (activeError instanceof ApiError) throw activeError;
              if (retryRegistrationUnconfirmed) throw activeError;
              input.runTrace.record("server:conversation-run:lifecycle-register-conflict-active-skipped", {
                workspaceId: input.workspace.id,
                conversationId: input.target.conversationId,
                activeRunId: error.activeRunId || null,
                message: activeError instanceof Error ? activeError.message : String(activeError),
              });
            }
            if (!retriedAfterProvenHandoffRecovery) {
              return queueRun(input, error.activeRunId || null);
            }
          } else {
            scheduleUnconfirmedRegistrationRecovery(admittedInput, "lifecycle-register-unconfirmed");
            if (error instanceof OrchestratorLifecycleRequestError) {
              throw lifecycleRequestApiError(error);
            }
            throw error;
          }
        }
      }
      if (!options.submitOpenCode) {
        throw new Error("OpenCode submit port is required for admitted conversation runs");
      }
      admittedInput = withOpenCodeAdmissionMessageId(admittedInput);
      if (!lifecycleOwner) persistPromptIdentity(admittedInput);
      const upstream = await submitAcceptedRun(admittedInput, lifecycleOwner);
      input.runTrace.record("server:conversation-run:submitted", {
        workspaceId: input.workspace.id,
        conversationId: input.target.conversationId,
        opencodeSessionId: input.target.opencodeSessionId,
        runId: input.runId,
        kind: input.kind,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
      });
      return {
        httpStatus: 200,
        payload: {
          ok: true,
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          opencodeSessionId: input.target.opencodeSessionId,
          runId: input.runId,
          clientMessageId: input.clientMessageId,
          origin: input.origin,
          status: "submitted",
          kind: input.kind,
          upstream,
          debugTrace: input.runTrace.entries,
        },
      };
      });
    },
    submitAcceptedRun,
    scheduleQueueDrain,
    drainConversationQueue,
    scheduleLifecycleReconcile,
    reconcileConversationRunLifecycle,
    async retryTerminalRuntimeHandoff(input) {
      return withWorkspaceExecutionGate(input.workspace.id, async () => {
        const workspaceId = normalizeWorkspaceExecutionKey(input.workspace.id);
        const runId = input.runId.trim();
        if (!workspaceId || !runId) return false;
        const reopenedReservation = options.queueStore?.reopenWorkspaceRunTerminalHandoff(workspaceId, runId) ?? null;
        const reopenedBarrier = reopenedReservation
          ? null
          : options.queueStore?.reopenTerminalHandoffBarrier(workspaceId, input.conversationId, runId) ?? null;
        if (!reopenedReservation && !reopenedBarrier) return false;
        if (reopenedReservation) reservationsForWorkspace(workspaceId).set(runId, reopenedReservation);
        staleTerminalHandoffRecoveryAttempts.delete(providerStartAbortRecoveryKey(
          workspaceId,
          input.conversationId,
          runId,
        ));
        recordTrace("server:conversation-run:terminal-runtime-handoff-recovery:explicit-retry", {
          workspaceId,
          conversationId: input.conversationId,
          runId,
          previousReason: reopenedReservation?.terminalHandoffReason ?? reopenedBarrier?.reason,
          previousAttempts: reopenedReservation?.terminalHandoffAttempts ?? reopenedBarrier?.attempts ?? 0,
        });
        await reconcileConversationRunLifecycle({
          ...input,
          workspace: { ...input.workspace, id: workspaceId },
          reason: "terminal-runtime-handoff-explicit-retry",
          attempt: 0,
          delayMs: 0,
        });
        return true;
      });
    },
    abortRun,
    async requestWorkspaceRuntimeOperation(input) {
      return withWorkspaceExecutionGate(input.workspaceId, async () => {
        const workspaceId = normalizeWorkspaceExecutionKey(input.workspaceId);
        options.queueStore?.expireWorkspaceRuntimeOperations();
        const rejectRuntimeOperation = (
          reason: "active-runs" | "reconciliation-pending" | "runtime-operation",
          operation?: ConversationWorkspaceRuntimeOperation,
        ) => {
          recordTrace("server:runtime-operation:blocked", {
            workspaceId,
            operationKind: input.kind,
            sourceClass: input.sourceClass,
            reasonCode: input.reasonCode,
            reason,
            reservationCount: workspaceRunReservations.get(workspaceId)?.size ?? 0,
            existingOperationId: operation?.operationId ?? null,
            existingOperationKind: operation?.kind ?? null,
            existingOperationState: operation?.state ?? null,
          });
          return { kind: "blocked" as const, reason, ...(operation ? { operation } : {}) };
        };
        const existing = activeWorkspaceRuntimeOperation(workspaceId);
        if (existing && existing.state !== "outcome_unknown") {
          return rejectRuntimeOperation("runtime-operation", existing);
        }
        // A control-plane rebind replaces only the local Veslo server process.
        // It neither stops the engine nor changes its run reservations, whose
        // durable store is reloaded by the replacement server. It must remain
        // available to repair the credentials of an already-active workspace.
        // Engine reloads, on the other hand, still require an idle workspace.
        if (input.kind !== "rebind_control_plane") {
          if (workspaceReconciliationPending.has(workspaceId)) {
            return rejectRuntimeOperation("reconciliation-pending");
          }
          if ((workspaceRunReservations.get(workspaceId)?.size ?? 0) > 0) {
            return rejectRuntimeOperation("active-runs");
          }
        }
        if (!options.queueStore) {
          throw new Error("workspace runtime operations require a queue store");
        }
        const acquired = options.queueStore.acquireWorkspaceRuntimeOperation({
          workspaceId,
          operationId: input.operationId,
          kind: input.kind,
          sourceClass: input.sourceClass,
          reasonCode: input.reasonCode,
          expiresAt: input.expiresAt,
        });
        if (!acquired.acquired) {
          return {
            kind: "blocked" as const,
            reason: "runtime-operation" as const,
            operation: acquired.operation,
          };
        }
        recordTrace("server:runtime-operation:granted", {
          workspaceId,
          operationId: acquired.operation.operationId,
          operationKind: acquired.operation.kind,
          sourceClass: acquired.operation.sourceClass,
          reasonCode: acquired.operation.reasonCode,
        });
        return { kind: "granted" as const, operation: acquired.operation };
      });
    },
    async beginWorkspaceRuntimeOperation(workspaceId, operationId) {
      return withWorkspaceExecutionGate(workspaceId, async () => {
        const operation = options.queueStore?.beginWorkspaceRuntimeOperation(workspaceId, operationId) ?? null;
        if (operation) {
          recordTrace("server:runtime-operation:begun", {
            workspaceId: operation.workspaceId,
            operationId: operation.operationId,
            operationKind: operation.kind,
          });
        }
        return operation;
      });
    },
    async completeWorkspaceRuntimeOperation(input) {
      return withWorkspaceExecutionGate(input.workspaceId, async () => {
        const operation = options.queueStore?.completeWorkspaceRuntimeOperation(input) ?? null;
        if (!operation) return null;
        recordTrace("server:runtime-operation:completed", {
          workspaceId: operation.workspaceId,
          operationId: operation.operationId,
          operationKind: operation.kind,
          state: operation.state,
          terminalCode: operation.terminalCode,
        });
        for (const pending of options.queueStore?.pendingConversationKeys?.() ?? []) {
          if (normalizeWorkspaceExecutionKey(pending.workspaceId) !== operation.workspaceId) continue;
          scheduleQueueDrain(pending.workspaceId, pending.conversationId, 0);
        }
        return operation;
      });
    },
    async reloadWorkspaceEngineIfIdle(input) {
      return withWorkspaceExecutionGate(input.workspaceId, async () => {
        const workspaceId = normalizeWorkspaceExecutionKey(input.workspaceId);
        if (workspaceReconciliationPending.has(workspaceId)) {
          return { kind: "blocked" as const, reason: "reconciliation-pending" as const };
        }
        if ((workspaceRunReservations.get(workspaceId)?.size ?? 0) > 0) {
          return { kind: "blocked" as const, reason: "active-runs" as const };
        }
        await input.reload();
        return { kind: "reloaded" as const };
      });
    },
    subscribeWorkspaceIdle(listener) {
      workspaceIdleListeners.add(listener);
      return () => workspaceIdleListeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      recordTrace("conversation-run-lifecycle:start");
      for (const [workspaceId, reservations] of workspaceRunReservations) {
        const workspace = options.resolveWorkspace?.(workspaceId) ?? null;
        if (!workspace || workspace.workspaceType === "remote" || !options.lifecycleClient) continue;
        for (const reservation of reservations.values()) {
          if (reservation.state === "terminalization_pending") {
            scheduleTerminalizationRetry({
              workspace,
              conversationId: reservation.conversationId,
              runId: reservation.runId,
              reasonCode: normalizeTerminalizationReasonCode(reservation.terminalizationReason),
              attempts: Math.max(1, reservation.terminalizationAttempts),
              lastError: reservation.terminalizationLastError ?? undefined,
              deadlineAt: reservation.terminalizationDeadlineAt ?? Date.now() + 300_000,
              nextAttemptAt: reservation.terminalizationNextAttemptAt,
            });
            continue;
          }
          if (reservation.state === "terminal_handoff_unresolved") {
            recordTrace("server:conversation-run:terminal-runtime-handoff-unresolved", {
              workspaceId,
              conversationId: reservation.conversationId,
              runId: reservation.runId,
              reason: reservation.terminalHandoffReason,
              attempts: reservation.terminalHandoffAttempts,
              startup: true,
            });
            continue;
          }
          if (
            reservation.providerStartAbortPending === true &&
            reservation.providerStartAbortDirectory &&
            reservation.providerStartAbortOpenCodeSessionId
          ) {
            const runTrace = options.createBackgroundRunTrace?.() ?? createNoopRunTrace();
            scheduleProviderStartTimeoutAbortRetry({
              runTrace,
              workspace,
              target: {
                directory: reservation.providerStartAbortDirectory,
                opencodeSessionId: reservation.providerStartAbortOpenCodeSessionId,
                conversationId: reservation.conversationId,
              },
              runId: reservation.runId,
              kind: "prompt_async",
              body: {},
              clientMessageId: null,
              origin: null,
              expectAiGatewayStart: true,
            }, options.lifecycleClient, PROVIDER_START_ABORT_RECOVERY_TIMEOUT_MS, {
              attempts: reservation.providerStartAbortAttempts ?? 0,
              deadlineAt: reservation.providerStartAbortDeadlineAt ?? Date.now() + PROVIDER_START_ABORT_RECOVERY_WINDOW_MS,
              lastError: reservation.providerStartAbortLastError ?? null,
              nextAttemptAt: reservation.providerStartAbortNextAttemptAt,
            });
            continue;
          }
          scheduleLifecycleReconcile({
            workspace,
            conversationId: reservation.conversationId,
            runId: reservation.runId,
            reason: "startup-workspace-reservation-reconcile",
            delayMs: 0,
          });
        }
      }
      // A recovery request without a completed answer must not be replayed
      // after restart.  Preserve the fence, surface it as unresolved, and
      // require one explicit retry with the original run identity.
      const storedTerminalHandoffBarriers = options.queueStore &&
        typeof options.queueStore.listTerminalHandoffBarriers === "function"
        ? options.queueStore.listTerminalHandoffBarriers()
        : [];
      for (const barrier of storedTerminalHandoffBarriers) {
        if (barrier.state !== "evidence_requested" && barrier.state !== "unresolved") continue;
        const workspace = options.resolveWorkspace?.(barrier.workspaceId) ?? null;
        if (!workspace || workspace.workspaceType === "remote" || !options.lifecycleClient) continue;
        const unresolved = barrier.state === "evidence_requested"
          ? options.queueStore?.markTerminalHandoffBarrierUnresolved({
            workspaceId: barrier.workspaceId,
            conversationId: barrier.conversationId,
            runId: barrier.runId,
            reason: "recovery_interrupted_by_restart",
          }) ?? barrier
          : barrier;
        recordTrace("server:conversation-run:terminal-runtime-handoff-unresolved", {
          workspaceId: unresolved.workspaceId,
          conversationId: unresolved.conversationId,
          runId: unresolved.runId,
          reason: unresolved.reason,
          attempts: unresolved.attempts,
          startup: true,
          reservationPresent: false,
        });
      }
      schedulePendingQueueDrains();
      scheduleDiagnosticsTimer();
    },
    stop() {
      if (!started && activeTimers.size === 0) return;
      started = false;
      clearAllTimers();
      pendingEngineLossTimers.clear();
      pendingEngineLosses.clear();
      recordTrace("conversation-run-lifecycle:stop");
    },
    snapshotForTests() {
      return {
        started,
        activeTimerCount: activeTimers.size,
        diagnostics: {
          enabled: diagnosticsIntervalMs !== null,
          intervalMs: diagnosticsIntervalMs,
          runs: diagnosticsRuns,
        },
        lifecycle: {
          pendingQueueDrains: queueDiagnosticsFromKeys(queueDrainTimers.keys()),
          pendingLifecycleReconciles: reconcileDiagnosticsFromKeys(lifecycleReconcileTimers.keys()),
          inFlightQueueDrains: queueDiagnosticsFromKeys(queueDrainInFlight.keys()),
          inFlightLifecycleReconciles: reconcileDiagnosticsFromKeys(lifecycleReconcileInFlight.keys()),
        },
        ports: {
          lifecycleClient: Boolean(options.lifecycleClient),
          queueStore: Boolean(options.queueStore),
          submitOpenCode: Boolean(options.submitOpenCode),
          aiGatewayProviderWatch: Boolean(options.aiGatewayProviderWatch),
        },
      };
    },
  };
}
