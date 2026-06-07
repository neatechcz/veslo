import {
  isTerminalRunStatus,
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
  }): Promise<RunRecord>;
  markFailed(workspaceId: string, runId: string, error: string): RunRecord | null;
  markAbortRequested(workspaceId: string, runId: string): RunRecord | null;
  get(workspaceId: string, runId: string): Promise<ReconciledRun | null>;
  latest(workspaceId: string, conversationId: string): Promise<ReconciledRun | null>;
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

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

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

    markAbortRequested(workspaceId, runId) {
      return deps.store.update(workspaceId, runId, {
        abortRequested: true,
      });
    },

    async get(workspaceId, runId) {
      const record = deps.store.get(workspaceId, runId);
      return record ? reconcile(record) : null;
    },

    async latest(workspaceId, conversationId) {
      const record = deps.store.latestForConversation(workspaceId, conversationId);
      return record ? reconcile(record) : null;
    },
  };
}
