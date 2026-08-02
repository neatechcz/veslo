import {
  isActiveRunStatus,
  isTerminalRunStatus,
  type RunActivityKind,
  type RunEngineOwner,
  type RunKind,
  type RunRecord,
  type RunStore,
  type RunWaitReason,
} from "./run-store.js";

export const MODEL_RETRY_NO_PROGRESS_SOFT_MS = 120_000;
export const MODEL_RETRY_NO_PROGRESS_HARD_MS = 600_000;
export const MODEL_RETRY_NO_PROGRESS_TIMEOUT = "model_retry_no_output_timeout";

export type RunProbeActivityResult = {
  active: boolean;
  terminalCandidate?: boolean;
  terminalConfirmed?: boolean;
  terminalStatus?: "completed" | "failed" | "aborted";
  terminalError?: string | null;
  activityKind?: RunActivityKind | null;
  waitReason?: RunWaitReason | null;
  progressSignature?: string | null;
  /** Safe metadata from the exact OpenCode session-status lookup. */
  sessionStatusObserved?: "busy" | "retry" | "explicit_idle" | "absent" | "unknown" | null;
};

export type RunProbeUnavailableReason =
  | "no_current_engine"
  | "session_status_http"
  | "session_messages_missing"
  | "session_messages_http"
  | "request_timeout"
  | "request_transport_error";

export type RunProbeResult = RunProbeActivityResult | {
  unreachable: true;
  /** Optional only while old external probe implementations are migrated. */
  unavailableReason?: RunProbeUnavailableReason;
  unavailableHttpStatus?: number | null;
};

export type ReconciledRun = {
  record: RunRecord;
  stale: boolean;
  noProgressSeconds: number | null;
  /**
   * Kept outside the durable transcript result. A completed assistant message
   * can be visible before OpenCode has released the session for the next
   * prompt, and that handoff fact must not overwrite the terminal run record.
   */
  runtimeReadyForSuccessor?: boolean | null;
  unavailableReason?: RunProbeUnavailableReason | null;
  unavailableHttpStatus?: number | null;
  sessionStatusObserved?: RunProbeActivityResult["sessionStatusObserved"];
};

export type RunLifecycleOwner = {
  register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    engineSessionId: string;
    clientMessageId?: string | null;
    opencodeMessageId?: string | null;
    origin?: string | null;
    directory: string;
    kind: RunKind;
  } & Partial<RunEngineOwner>): Promise<RunRecord>;
  markFailed(workspaceId: string, runId: string, error: string): RunRecord | null;
  markAborted(workspaceId: string, runId: string, error?: string): RunRecord | null;
  markAbortRequested(workspaceId: string, runId: string): RunRecord | null;
  /** Mark one already-terminal run's attached generation as definitely gone. */
  markTerminalRunEngineLost(input: RunEngineOwner & { workspaceId: string; runId: string }): RunRecord | null;
  attachEngineOwner(workspaceId: string, runId: string, owner: RunEngineOwner): RunRecord | null;
  markEngineLost(input: RunEngineOwner & { error: string }): RunRecord[];
  sweepLegacyActiveRuns(input: {
    createdBefore: number;
    error: string;
    limit?: number;
  }): RunRecord[];
  get(workspaceId: string, runId: string): Promise<ReconciledRun | null>;
  latest(workspaceId: string, conversationId: string): Promise<ReconciledRun | null>;
  active(workspaceId: string, conversationId: string): Promise<ReconciledRun | null>;
  activeForEngineSession(input: {
    workspaceId: string;
    engineSessionId: string;
    engineOwnerId: string;
    enginePid: number;
    engineStartedAt: number;
    engineBaseUrl: string;
  }): RunRecord | null;
};

export class RunAlreadyActiveError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("A run is already active for this conversation");
    this.name = "RunAlreadyActiveError";
    this.activeRunId = activeRunId;
  }
}

export const DEFAULT_RUN_FAILURE_ERROR = "engine submit failed";
export const DEFAULT_RUN_ABORT_ERROR = "run aborted";

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeNullableText = (value: string | null | undefined): string | null => {
  const normalized = normalizeText(value);
  return normalized || null;
};

const normalizePositiveNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

const normalizeTimestamp = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

const normalizeDurationMs = (value: number | null | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const normalizeActivityKind = (value: RunActivityKind | null | undefined): RunActivityKind =>
  value === "local_tool" ||
  value === "assistant_output" ||
  value === "model_retry" ||
  value === "idle" ||
  value === "unknown"
    ? value
    : "unknown";

const normalizeWaitReason = (value: RunWaitReason | null | undefined): RunWaitReason =>
  value === "running_tool" ||
  value === "model_retry_no_output" ||
  value === "assistant_message_open" ||
  value === "session_idle" ||
  value === "engine_unreachable" ||
  value === "none"
    ? value
    : "none";

const noProgressSecondsForRecord = (record: RunRecord, nowMs: number): number | null => {
  const retrySince = normalizeTimestamp(record.retrySince);
  if (!retrySince || record.waitReason !== "model_retry_no_output") return null;
  return Math.max(0, Math.floor((nowMs - retrySince) / 1_000));
};

function normalizeEngineOwner(input: Partial<RunEngineOwner>): RunEngineOwner {
  return {
    engineSlotId: normalizeNullableText(input.engineSlotId),
    engineOwnerId: normalizeNullableText(input.engineOwnerId),
    engineOwnerState: input.engineOwnerState === "lost" ? "lost" : input.engineOwnerId ? "attached" : "pending",
    enginePid: normalizePositiveNumber(input.enginePid),
    engineStartedAt: normalizePositiveNumber(input.engineStartedAt),
    engineBaseUrl: normalizeNullableText(input.engineBaseUrl),
  };
}

function runMatchesEngineOwner(record: RunRecord, engine: RunEngineOwner): boolean {
  if (record.engineOwnerState !== "attached") return false;
  if (engine.engineSlotId && record.engineSlotId !== engine.engineSlotId) return false;
  if (!engine.engineOwnerId || record.engineOwnerId !== engine.engineOwnerId) return false;
  if (engine.enginePid !== null && record.enginePid !== engine.enginePid) return false;
  if (engine.engineStartedAt !== null && record.engineStartedAt !== engine.engineStartedAt) return false;
  if (engine.engineBaseUrl !== null && record.engineBaseUrl !== engine.engineBaseUrl) return false;
  return true;
}

export function createRunRegistry(deps: {
  store: RunStore;
  probeRunActivity: (record: RunRecord) => Promise<RunProbeResult>;
  modelRetryNoProgressHardMs?: number;
  now?: () => number;
}): RunLifecycleOwner {
  const now = deps.now ?? (() => Date.now());
  const modelRetryNoProgressHardMs = normalizeDurationMs(
    deps.modelRetryNoProgressHardMs,
    MODEL_RETRY_NO_PROGRESS_HARD_MS,
  );

  const reconcile = async (record: RunRecord): Promise<ReconciledRun> => {
    const currentNoProgressSeconds = () => noProgressSecondsForRecord(record, now());

    if (isTerminalRunStatus(record.status)) {
      // A confirmed engine-loss transition is stronger than an idle probe: the
      // exact process that could still own this session no longer exists.
      // Do not wait for a replacement generation to answer about the old one.
      if (record.engineOwnerState === "lost") {
        return {
          record,
          stale: false,
          noProgressSeconds: currentNoProgressSeconds(),
          runtimeReadyForSuccessor: true,
        };
      }
      const probe = await deps.probeRunActivity(record);
      if ("unreachable" in probe) {
        return {
          record,
          stale: true,
          noProgressSeconds: currentNoProgressSeconds(),
          runtimeReadyForSuccessor: null,
          unavailableReason: probe.unavailableReason ?? null,
          unavailableHttpStatus: probe.unavailableHttpStatus ?? null,
        };
      }
      // Only an inactive exact-session observation opens the admission
      // handoff. A terminal assistant transcript with an open/busy session is
      // precisely the race that otherwise produces a successful but
      // undispatched 204.
      return {
        record,
        stale: false,
        noProgressSeconds: currentNoProgressSeconds(),
        runtimeReadyForSuccessor: probe.active === false,
        sessionStatusObserved: probe.sessionStatusObserved ?? null,
      };
    }

    const probe = await deps.probeRunActivity(record);
    if ("unreachable" in probe) {
      const next = deps.store.update(record.workspaceId, record.runId, {
        activityKind: "unknown",
        waitReason: "engine_unreachable",
      }) ?? record;
      return {
        record: next,
        stale: true,
        noProgressSeconds: noProgressSecondsForRecord(next, now()),
        unavailableReason: probe.unavailableReason ?? null,
        unavailableHttpStatus: probe.unavailableHttpStatus ?? null,
      };
    }

    if (probe.active) {
      const timestamp = now();
      const startedAt = record.startedAt ?? timestamp;
      const activityKind = normalizeActivityKind(probe.activityKind);
      const waitReason = normalizeWaitReason(
        probe.waitReason ?? (activityKind === "model_retry" ? "model_retry_no_output" : "assistant_message_open"),
      );
      const progressSignature = normalizeNullableText(probe.progressSignature);
      const previousSignature = normalizeNullableText(record.lastProgressSignature);
      const hasUsefulProgress =
        waitReason !== "model_retry_no_output" &&
        progressSignature !== null &&
        progressSignature !== previousSignature;
      const retrySince =
        waitReason === "model_retry_no_output"
          ? normalizeTimestamp(record.retrySince) ?? timestamp
          : null;
      const timedOut =
        waitReason === "model_retry_no_output" &&
        retrySince !== null &&
        timestamp - retrySince >= modelRetryNoProgressHardMs;
      const error =
        timedOut
          ? MODEL_RETRY_NO_PROGRESS_TIMEOUT
          : record.error === MODEL_RETRY_NO_PROGRESS_TIMEOUT
            ? null
            : record.error;
      const next = deps.store.update(record.workspaceId, record.runId, {
        // A no-output retry is still one exact OpenCode run. Its timeout is a
        // durable diagnostic, not permission to discard the run, admit a
        // successor, or turn a delivery/reconciliation problem into failure.
        status: "running",
        startedAt,
        completedAt: null,
        error,
        activityKind,
        waitReason,
        lastUsefulProgressAt: hasUsefulProgress
          ? timestamp
          : record.lastUsefulProgressAt ?? record.startedAt ?? record.createdAt,
        retrySince,
        lastProgressSignature: progressSignature,
      }) ?? record;
      return {
        record: next,
        stale: false,
        noProgressSeconds: noProgressSecondsForRecord(next, timestamp),
        sessionStatusObserved: probe.sessionStatusObserved ?? null,
      };
    }

    if (!probe.terminalCandidate) {
      const timestamp = now();
      const next = deps.store.update(record.workspaceId, record.runId, {
        status: isActiveRunStatus(record.status) ? record.status : "running",
        completedAt: null,
        activityKind: normalizeActivityKind(probe.activityKind ?? "idle"),
        waitReason: normalizeWaitReason(probe.waitReason ?? "session_idle"),
        retrySince: null,
        lastProgressSignature: normalizeNullableText(probe.progressSignature) ?? record.lastProgressSignature,
      }) ?? record;
      return {
        record: next,
        stale: false,
        noProgressSeconds: noProgressSecondsForRecord(next, timestamp),
        sessionStatusObserved: probe.sessionStatusObserved ?? null,
      };
    }

    const terminalize = (): ReconciledRun => {
      const timestamp = now();
      const terminalStatus = probe.terminalStatus ?? "completed";
      const next =
        deps.store.update(record.workspaceId, record.runId, {
          status: terminalStatus,
          completedAt: timestamp,
          error: terminalStatus === "completed" ? null : normalizeText(probe.terminalError) || (
            terminalStatus === "aborted" ? DEFAULT_RUN_ABORT_ERROR : DEFAULT_RUN_FAILURE_ERROR
          ),
          activityKind: "idle",
          waitReason: "none",
          retrySince: null,
        }) ?? record;
      return {
        record: next,
        stale: false,
        noProgressSeconds: null,
        runtimeReadyForSuccessor: true,
        sessionStatusObserved: probe.sessionStatusObserved ?? null,
      };
    };

    if (probe.terminalConfirmed) {
      return terminalize();
    }

    const progressSignature = normalizeNullableText(probe.progressSignature);
    const stableTerminalCandidate = Boolean(
      progressSignature &&
      record.waitReason === "session_idle" &&
      normalizeNullableText(record.lastProgressSignature) === progressSignature
    );
    if (!stableTerminalCandidate) {
      const timestamp = now();
      const next = deps.store.update(record.workspaceId, record.runId, {
        status: isActiveRunStatus(record.status) ? record.status : "running",
        completedAt: null,
        activityKind: "idle",
        waitReason: "session_idle",
        retrySince: null,
        lastProgressSignature: progressSignature,
      }) ?? record;
      return {
        record: next,
        stale: false,
        noProgressSeconds: noProgressSecondsForRecord(next, timestamp),
        sessionStatusObserved: probe.sessionStatusObserved ?? null,
      };
    }

    return terminalize();
  };

  return {
    async register(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const conversationId = normalizeText(input.conversationId);
      const runId = normalizeText(input.runId);
      const engineSessionId = normalizeText(input.engineSessionId);
      const clientMessageId = normalizeNullableText(input.clientMessageId);
      const opencodeMessageId = normalizeNullableText(input.opencodeMessageId);
      const origin = normalizeNullableText(input.origin);
      const directory = normalizeText(input.directory);
      if (!workspaceId || !conversationId || !runId || !engineSessionId || !directory) {
        throw new Error("workspaceId, conversationId, runId, engineSessionId and directory are required");
      }

      if (deps.store.get(workspaceId, runId)) {
        throw new Error("runId already exists");
      }

      // A terminal transcript does not itself reopen admission: its exact
      // OpenCode session can still be busy for a short handoff window. Inspect
      // the latest run as well as active rows so that only a confirmed idle
      // runtime can admit a successor.
      const previous = deps.store.activeForConversation(workspaceId, conversationId)
        ?? deps.store.latestForConversation(workspaceId, conversationId);
      if (previous) {
        const reconciled = await reconcile(previous);
        if (
          !isTerminalRunStatus(reconciled.record.status) ||
          reconciled.runtimeReadyForSuccessor !== true
        ) {
          if (
            clientMessageId &&
            normalizeNullableText(reconciled.record.clientMessageId) === clientMessageId
          ) {
            return reconciled.record;
          }
          throw new RunAlreadyActiveError(previous.runId);
        }
      }

      const timestamp = now();
      const record: RunRecord = {
        workspaceId,
        conversationId,
        runId,
        engineSessionId,
        clientMessageId,
        opencodeMessageId,
        origin,
        directory,
        kind: input.kind,
        status: "running",
        abortRequested: false,
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        error: null,
        engineSlotId: null,
        engineOwnerState: "pending",
        engineOwnerId: null,
        enginePid: null,
        engineStartedAt: null,
        engineBaseUrl: null,
        activityKind: null,
        waitReason: null,
        lastUsefulProgressAt: timestamp,
        retrySince: null,
        lastProgressSignature: null,
      };
      try {
        deps.store.insert(record);
      } catch (error) {
        const active = deps.store.activeForConversation(workspaceId, conversationId);
        if (active) {
          throw new RunAlreadyActiveError(active.runId);
        }
        throw error;
      }
      return deps.store.get(workspaceId, runId) ?? record;
    },

    markFailed(workspaceId, runId, error) {
      return deps.store.update(workspaceId, runId, {
        status: "failed",
        error: normalizeText(error) || DEFAULT_RUN_FAILURE_ERROR,
        completedAt: now(),
        activityKind: "idle",
        waitReason: "none",
        retrySince: null,
      });
    },

    markAborted(workspaceId, runId, error) {
      return deps.store.update(workspaceId, runId, {
        status: "aborted",
        abortRequested: true,
        error: normalizeText(error) || DEFAULT_RUN_ABORT_ERROR,
        completedAt: now(),
        activityKind: "idle",
        waitReason: "none",
        retrySince: null,
      });
    },

    markAbortRequested(workspaceId, runId) {
      return deps.store.update(workspaceId, runId, {
        abortRequested: true,
      });
    },

    markTerminalRunEngineLost(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const runId = normalizeText(input.runId);
      const owner = normalizeEngineOwner(input);
      if (!workspaceId || !runId || !owner.engineOwnerId) return null;
      const record = deps.store.get(workspaceId, runId);
      if (!record || !isTerminalRunStatus(record.status) || !runMatchesEngineOwner(record, owner)) {
        return null;
      }
      return deps.store.update(workspaceId, runId, {
        engineOwnerState: "lost",
      });
    },

    attachEngineOwner(workspaceId, runId, owner) {
      const normalizedWorkspaceId = normalizeText(workspaceId);
      const normalizedRunId = normalizeText(runId);
      const engineOwner = normalizeEngineOwner(owner);
      if (!normalizedWorkspaceId || !normalizedRunId || !engineOwner.engineOwnerId) return null;

      const record = deps.store.get(normalizedWorkspaceId, normalizedRunId);
      if (!record || !isActiveRunStatus(record.status)) return null;

      if (record.engineOwnerState === "attached") {
        return runMatchesEngineOwner(record, engineOwner) ? record : null;
      }
      if (record.engineOwnerState !== "pending" || engineOwner.engineOwnerState === "lost") return null;

      return deps.store.update(normalizedWorkspaceId, normalizedRunId, {
        engineSlotId: engineOwner.engineSlotId ?? null,
        engineOwnerState: "attached",
        engineOwnerId: engineOwner.engineOwnerId,
        enginePid: engineOwner.enginePid,
        engineStartedAt: engineOwner.engineStartedAt,
        engineBaseUrl: engineOwner.engineBaseUrl,
      });
    },

    markEngineLost(input) {
      const engineOwner = normalizeEngineOwner(input);
      if (!engineOwner.engineOwnerId) return [];
      const error = normalizeText(input.error) || "engine lost";
      const terminalized: RunRecord[] = [];
      for (const record of deps.store.activeForEngineOwner(engineOwner.engineOwnerId)) {
        if (!runMatchesEngineOwner(record, engineOwner)) continue;
        const next = deps.store.update(record.workspaceId, record.runId, record.abortRequested
          ? {
              status: "aborted",
              abortRequested: true,
              error: `user abort reconciled after engine loss: ${error}`,
              completedAt: now(),
              activityKind: "idle",
              waitReason: "none",
              retrySince: null,
              engineOwnerState: "lost",
            }
          : {
              status: "failed",
              error,
              completedAt: now(),
              activityKind: "idle",
              waitReason: "none",
              retrySince: null,
              engineOwnerState: "lost",
            });
        if (next) terminalized.push(next);
      }
      return terminalized;
    },

    sweepLegacyActiveRuns(input) {
      const createdBefore = Number.isFinite(input.createdBefore) ? Math.floor(input.createdBefore) : 0;
      if (createdBefore <= 0) return [];
      const error = normalizeText(input.error) || "legacy active run exceeded startup sweep age";
      const terminalized: RunRecord[] = [];
      for (const record of deps.store.activeCreatedBefore(createdBefore, input.limit)) {
        if (!isActiveRunStatus(record.status)) continue;
        const next = deps.store.update(record.workspaceId, record.runId, record.abortRequested
          ? {
              status: "aborted",
              abortRequested: true,
              error: `user abort reconciled during startup sweep: ${error}`,
              completedAt: now(),
              activityKind: "idle",
              waitReason: "none",
              retrySince: null,
            }
          : {
              status: "failed",
              error,
              completedAt: now(),
              activityKind: "idle",
              waitReason: "none",
              retrySince: null,
            });
        if (next) terminalized.push(next);
      }
      return terminalized;
    },

    async get(workspaceId, runId) {
      const record = deps.store.get(workspaceId, runId);
      return record ? reconcile(record) : null;
    },

    async latest(workspaceId, conversationId) {
      const record = deps.store.latestForConversation(workspaceId, conversationId);
      return record ? reconcile(record) : null;
    },

    async active(workspaceId, conversationId) {
      const record = deps.store.activeForConversation(workspaceId, conversationId);
      if (!record) return null;
      const reconciled = await reconcile(record);
      return isTerminalRunStatus(reconciled.record.status) ? null : reconciled;
    },

    activeForEngineSession(input) {
      return deps.store.activeForEngineSession(input);
    },
  };
}
