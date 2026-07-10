import type { MessageInfo } from "../types";

type SubmittedRunTranscriptCatchupSnapshot = {
  source?: string | null;
  sessionId?: string | null;
  opencodeSessionId?: string | null;
  messages: MessageInfo[];
};

export type SubmittedRunTranscriptCatchupTarget = {
  workspaceId?: string | null;
  sessionId?: string | null;
  directory?: string | null;
  runId?: string | null;
  traceId?: string | null;
  reason: string;
};

export type SubmittedRunTranscriptCatchupExhaustedReason =
  | "not-selected"
  | "workspace-mismatch"
  | "transcript-unavailable"
  | "load-error";

export type SubmittedRunTranscriptCatchupSettlement = {
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  attemptCount: number;
  successfulReadCount: number;
} & (
  | { kind: "assistant-observed" }
  | { kind: "exhausted"; reason: SubmittedRunTranscriptCatchupExhaustedReason }
  | { kind: "cancelled"; reason: "disposed" | "invalid-target" | "superseded" }
);

export type SubmittedRunTranscriptCatchupObserver = {
  onSettled?: (settlement: SubmittedRunTranscriptCatchupSettlement) => void;
};

type NormalizedSubmittedRunTranscriptCatchupTarget =
  Omit<SubmittedRunTranscriptCatchupTarget, "workspaceId" | "sessionId"> & {
    workspaceId: string;
    sessionId: string;
  };

export type SubmittedRunTranscriptCatchupOptions<
  Snapshot extends SubmittedRunTranscriptCatchupSnapshot = SubmittedRunTranscriptCatchupSnapshot,
> = {
  selectedSessionId: () => string | null | undefined;
  resolveSelectedSessionWorkspaceId?: (sessionId: string) => string | null | undefined;
  assistantObservationVersion: (sessionId: string) => number;
  assistantMessageCount: (sessionId: string) => number;
  loadTranscript: (target: NormalizedSubmittedRunTranscriptCatchupTarget) =>
    Promise<Snapshot | null>;
  hydrateTranscriptSnapshot: (snapshot: Snapshot) => void;
  trace?: (event: string, payload?: Record<string, unknown>) => void;
  delaysMs?: readonly number[];
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

// This is an SSE-loss fallback, not the normal completion path. Keep it bounded:
// the live transcript event updates the selected session immediately.
const DEFAULT_CATCHUP_DELAYS_MS = [3_000, 12_000] as const;

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const sessionKey = (workspaceId: string, sessionId: string) => `${workspaceId}\0${sessionId}`;

const countAssistantMessages = (messages: MessageInfo[]) =>
  messages.filter((message) => message.role === "assistant").length;

const retargetSnapshotForCatchupTarget = <
  Snapshot extends SubmittedRunTranscriptCatchupSnapshot,
>(
  snapshot: Snapshot,
  target: Pick<NormalizedSubmittedRunTranscriptCatchupTarget, "sessionId">,
): Snapshot => {
  const snapshotSessionId = normalize(snapshot.sessionId);
  if (!snapshotSessionId || snapshotSessionId === target.sessionId) return snapshot;
  // Server transcript reads return OpenCode ids; hydrate under the UI target id so scoped caches stay aligned.
  return {
    ...snapshot,
    sessionId: target.sessionId,
    opencodeSessionId: snapshot.opencodeSessionId?.trim() || snapshotSessionId,
  } as Snapshot;
};

export function createSubmittedRunTranscriptCatchup<
  Snapshot extends SubmittedRunTranscriptCatchupSnapshot,
>(options: SubmittedRunTranscriptCatchupOptions<Snapshot>) {
  const delaysMs = options.delaysMs?.length ? [...options.delaysMs] : [...DEFAULT_CATCHUP_DELAYS_MS];
  const setTimer = options.scheduleTimer ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });
  const timers = new Set<unknown>();
  type CatchupTask = {
    target: NormalizedSubmittedRunTranscriptCatchupTarget;
    baseline: { assistantCount: number; observationVersion: number };
    observer?: SubmittedRunTranscriptCatchupObserver;
    attemptCount: number;
    successfulReadCount: number;
    lastExhaustedReason: SubmittedRunTranscriptCatchupExhaustedReason | null;
    settled: boolean;
    timers: Set<unknown>;
  };
  const tasks = new Set<CatchupTask>();
  const taskBySessionKey = new Map<string, CatchupTask>();
  let disposed = false;

  const trace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.(event, payload);
  };

  const settle = (
    task: CatchupTask,
    result:
      | { kind: "assistant-observed" }
      | { kind: "exhausted"; reason: SubmittedRunTranscriptCatchupExhaustedReason }
      | { kind: "cancelled"; reason: "disposed" | "invalid-target" | "superseded" },
  ) => {
    if (task.settled) return;
    task.settled = true;
    for (const timer of task.timers) {
      clearTimer(timer);
      timers.delete(timer);
    }
    task.timers.clear();
    tasks.delete(task);
    const key = sessionKey(task.target.workspaceId, task.target.sessionId);
    if (taskBySessionKey.get(key) === task) taskBySessionKey.delete(key);
    task.observer?.onSettled?.({
      ...result,
      workspaceId: task.target.workspaceId,
      sessionId: task.target.sessionId,
      runId: task.target.runId ?? null,
      attemptCount: task.attemptCount,
      successfulReadCount: task.successfulReadCount,
    });
  };

  const scheduleAttempt = (task: CatchupTask, attemptIndex: number) => {
    if (disposed || task.settled) return;
    const delayMs = delaysMs[attemptIndex];
    if (delayMs == null) {
      const target = task.target;
      const exhaustedReason: SubmittedRunTranscriptCatchupExhaustedReason =
        task.lastExhaustedReason ?? "transcript-unavailable";
      trace("submitted-run-transcript-catchup:exhausted", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        traceId: target.traceId ?? null,
        reason: target.reason,
        exhaustedReason,
        successfulReadCount: task.successfulReadCount,
      });
      settle(task, { kind: "exhausted", reason: exhaustedReason });
      return;
    }

    const timer = setTimer(() => {
      timers.delete(timer);
      task.timers.delete(timer);
      if (disposed || task.settled) return;
      void runAttempt(task, attemptIndex);
    }, Math.max(0, delayMs));
    timers.add(timer);
    task.timers.add(timer);
  };

  const runAttempt = async (
    task: CatchupTask,
    attemptIndex: number,
  ) => {
    if (disposed || task.settled) return;
    const target = task.target;
    const baseline = task.baseline;
    task.attemptCount = Math.max(task.attemptCount, attemptIndex + 1);
    const selectedSessionId = normalize(options.selectedSessionId());
    if (selectedSessionId !== target.sessionId) {
      task.lastExhaustedReason = "not-selected";
      trace("submitted-run-transcript-catchup:defer-not-selected", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        selectedSessionId: selectedSessionId || null,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      scheduleAttempt(task, attemptIndex + 1);
      return;
    }

    const selectedWorkspaceId = normalize(options.resolveSelectedSessionWorkspaceId?.(target.sessionId));
    if (selectedWorkspaceId && selectedWorkspaceId !== target.workspaceId) {
      task.lastExhaustedReason = "workspace-mismatch";
      trace("submitted-run-transcript-catchup:defer-workspace-mismatch", {
        workspaceId: target.workspaceId,
        selectedWorkspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      scheduleAttempt(task, attemptIndex + 1);
      return;
    }

    if (options.assistantObservationVersion(target.sessionId) > baseline.observationVersion) {
      trace("submitted-run-transcript-catchup:skip-assistant-observed", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      settle(task, { kind: "assistant-observed" });
      return;
    }

    if (options.assistantMessageCount(target.sessionId) > baseline.assistantCount) {
      trace("submitted-run-transcript-catchup:skip-assistant-cached", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      settle(task, { kind: "assistant-observed" });
      return;
    }

    try {
      const snapshot = await options.loadTranscript(target);
      if (disposed || task.settled) return;
      if (!snapshot || snapshot.source === "unavailable") {
        task.lastExhaustedReason = "transcript-unavailable";
        trace("submitted-run-transcript-catchup:transcript-unavailable", {
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          runId: target.runId ?? null,
          attempt: attemptIndex + 1,
        });
        scheduleAttempt(task, attemptIndex + 1);
        return;
      }

      const hydrationSnapshot = retargetSnapshotForCatchupTarget(snapshot, target);
      task.successfulReadCount += 1;
      task.lastExhaustedReason = null;
      options.hydrateTranscriptSnapshot(hydrationSnapshot);
      const snapshotAssistantCount = countAssistantMessages(hydrationSnapshot.messages);
      const currentAssistantCount = options.assistantMessageCount(target.sessionId);
      const recoveredAssistant = Math.max(snapshotAssistantCount, currentAssistantCount) > baseline.assistantCount;
      const traceEvent = recoveredAssistant
        ? "submitted-run-transcript-catchup:done"
        : "submitted-run-transcript-catchup:no-assistant-yet";
      trace(traceEvent, {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
        messageCount: snapshot.messages.length,
        assistantCount: snapshotAssistantCount,
        baselineAssistantCount: baseline.assistantCount,
      });
      if (!recoveredAssistant) {
        scheduleAttempt(task, attemptIndex + 1);
      } else {
        settle(task, { kind: "assistant-observed" });
      }
    } catch (error) {
      task.lastExhaustedReason = "load-error";
      trace("submitted-run-transcript-catchup:error", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      scheduleAttempt(task, attemptIndex + 1);
    }
  };

  return {
    schedule(
      input: SubmittedRunTranscriptCatchupTarget,
      observer?: SubmittedRunTranscriptCatchupObserver,
    ) {
      if (disposed) {
        trace("submitted-run-transcript-catchup:skip-disposed", {
          workspaceId: input.workspaceId?.trim() || null,
          sessionId: input.sessionId?.trim() || null,
          runId: input.runId?.trim() || null,
          traceId: input.traceId?.trim() || null,
          reason: input.reason,
        });
        observer?.onSettled?.({
          kind: "cancelled",
          reason: "disposed",
          workspaceId: input.workspaceId?.trim() || "",
          sessionId: input.sessionId?.trim() || "",
          runId: input.runId?.trim() || null,
          attemptCount: 0,
          successfulReadCount: 0,
        });
        return;
      }
      const workspaceId = normalize(input.workspaceId);
      const sessionId = normalize(input.sessionId);
      if (!workspaceId || !sessionId) {
        trace("submitted-run-transcript-catchup:skip-missing-target", {
          workspaceId: workspaceId || null,
          sessionId: sessionId || null,
          runId: input.runId?.trim() || null,
          traceId: input.traceId?.trim() || null,
          reason: input.reason,
        });
        observer?.onSettled?.({
          kind: "cancelled",
          reason: "invalid-target",
          workspaceId,
          sessionId,
          runId: input.runId?.trim() || null,
          attemptCount: 0,
          successfulReadCount: 0,
        });
        return;
      }
      const target = {
        ...input,
        workspaceId,
        sessionId,
        directory: input.directory?.trim() || null,
        runId: input.runId?.trim() || null,
        traceId: input.traceId?.trim() || null,
      };
      const key = sessionKey(workspaceId, sessionId);
      const previousTask = taskBySessionKey.get(key);
      if (previousTask) {
        trace("submitted-run-transcript-catchup:superseded", {
          workspaceId,
          sessionId,
          previousRunId: previousTask.target.runId ?? null,
          runId: target.runId,
          reason: target.reason,
        });
        settle(previousTask, { kind: "cancelled", reason: "superseded" });
      }
      trace("submitted-run-transcript-catchup:scheduled", {
        workspaceId,
        sessionId,
        directory: target.directory,
        runId: target.runId,
        traceId: target.traceId,
        reason: target.reason,
      });
      const task: CatchupTask = {
        target,
        baseline: {
          assistantCount: options.assistantMessageCount(sessionId),
          observationVersion: options.assistantObservationVersion(sessionId),
        },
        observer,
        attemptCount: 0,
        successfulReadCount: 0,
        lastExhaustedReason: null,
        settled: false,
        timers: new Set(),
      };
      tasks.add(task);
      taskBySessionKey.set(key, task);
      scheduleAttempt(task, 0);
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      for (const task of [...tasks]) settle(task, { kind: "cancelled", reason: "disposed" });
    },
  };
}
