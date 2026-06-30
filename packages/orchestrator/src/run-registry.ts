import {
  isActiveRunStatus,
  isTerminalRunStatus,
  type RunEngineOwner,
  type RunKind,
  type RunRecord,
  type RunStore,
} from "./run-store.js";

export type RunProbeResult = { active: boolean } | { unreachable: true };

export type ReconciledRun = {
  record: RunRecord;
  stale: boolean;
};

export type RunLifecycleOwner = {
  register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    engineSessionId: string;
    directory: string;
    kind: RunKind;
  } & Partial<RunEngineOwner>): Promise<RunRecord>;
  markFailed(workspaceId: string, runId: string, error: string): RunRecord | null;
  markAborted(workspaceId: string, runId: string, error?: string): RunRecord | null;
  markAbortRequested(workspaceId: string, runId: string): RunRecord | null;
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

function normalizeEngineOwner(input: Partial<RunEngineOwner>): RunEngineOwner {
  return {
    engineOwnerId: normalizeNullableText(input.engineOwnerId),
    enginePid: normalizePositiveNumber(input.enginePid),
    engineStartedAt: normalizePositiveNumber(input.engineStartedAt),
    engineBaseUrl: normalizeNullableText(input.engineBaseUrl),
  };
}

function runMatchesEngineOwner(record: RunRecord, engine: RunEngineOwner): boolean {
  if (!engine.engineOwnerId || record.engineOwnerId !== engine.engineOwnerId) return false;
  if (engine.enginePid !== null && record.enginePid !== engine.enginePid) return false;
  if (engine.engineStartedAt !== null && record.engineStartedAt !== engine.engineStartedAt) return false;
  if (engine.engineBaseUrl !== null && record.engineBaseUrl !== engine.engineBaseUrl) return false;
  return true;
}

export function createRunRegistry(deps: {
  store: RunStore;
  probeRunActivity: (record: RunRecord) => Promise<RunProbeResult>;
  now?: () => number;
}): RunLifecycleOwner {
  const now = deps.now ?? (() => Date.now());

  const reconcile = async (record: RunRecord): Promise<ReconciledRun> => {
    if (isTerminalRunStatus(record.status)) {
      return { record, stale: false };
    }

    const probe = await deps.probeRunActivity(record);
    if ("unreachable" in probe) {
      return { record, stale: true };
    }

    if (probe.active) {
      const startedAt = record.startedAt ?? now();
      const next =
        record.status === "running" && record.startedAt === startedAt
          ? record
          : deps.store.update(record.workspaceId, record.runId, {
              status: "running",
              startedAt,
            }) ?? record;
      return { record: next, stale: false };
    }

    const next =
      deps.store.update(record.workspaceId, record.runId, {
        status: "completed",
        completedAt: now(),
      }) ?? record;
    return { record: next, stale: false };
  };

  return {
    async register(input) {
      const workspaceId = normalizeText(input.workspaceId);
      const conversationId = normalizeText(input.conversationId);
      const runId = normalizeText(input.runId);
      const engineSessionId = normalizeText(input.engineSessionId);
      const directory = normalizeText(input.directory);
      if (!workspaceId || !conversationId || !runId || !engineSessionId || !directory) {
        throw new Error("workspaceId, conversationId, runId, engineSessionId and directory are required");
      }

      if (deps.store.get(workspaceId, runId)) {
        throw new Error("runId already exists");
      }

      const active = deps.store.activeForConversation(workspaceId, conversationId);
      if (active) {
        const reconciled = await reconcile(active);
        if (!isTerminalRunStatus(reconciled.record.status)) {
          throw new RunAlreadyActiveError(active.runId);
        }
      }

      const timestamp = now();
      const engineOwner = normalizeEngineOwner(input);
      const record: RunRecord = {
        workspaceId,
        conversationId,
        runId,
        engineSessionId,
        directory,
        kind: input.kind,
        status: "running",
        abortRequested: false,
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        error: null,
        ...engineOwner,
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
      });
    },

    markAborted(workspaceId, runId, error) {
      return deps.store.update(workspaceId, runId, {
        status: "aborted",
        abortRequested: true,
        error: normalizeText(error) || DEFAULT_RUN_ABORT_ERROR,
        completedAt: now(),
      });
    },

    markAbortRequested(workspaceId, runId) {
      return deps.store.update(workspaceId, runId, {
        abortRequested: true,
      });
    },

    attachEngineOwner(workspaceId, runId, owner) {
      const normalizedWorkspaceId = normalizeText(workspaceId);
      const normalizedRunId = normalizeText(runId);
      const engineOwner = normalizeEngineOwner(owner);
      if (!normalizedWorkspaceId || !normalizedRunId || !engineOwner.engineOwnerId) return null;

      const record = deps.store.get(normalizedWorkspaceId, normalizedRunId);
      if (!record || !isActiveRunStatus(record.status)) return null;

      return deps.store.update(normalizedWorkspaceId, normalizedRunId, engineOwner);
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
            }
          : {
              status: "failed",
              error,
              completedAt: now(),
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
            }
          : {
              status: "failed",
              error,
              completedAt: now(),
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
  };
}
