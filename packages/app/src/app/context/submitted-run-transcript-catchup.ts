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

const DEFAULT_CATCHUP_DELAYS_MS = [3_000, 10_000, 25_000] as const;

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

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
  let disposed = false;

  const trace = (event: string, payload?: Record<string, unknown>) => {
    options.trace?.(event, payload);
  };

  const scheduleAttempt = (
    target: NormalizedSubmittedRunTranscriptCatchupTarget,
    baseline: { assistantCount: number; observationVersion: number },
    attemptIndex: number,
  ) => {
    if (disposed) return;
    const delayMs = delaysMs[attemptIndex];
    if (delayMs == null) {
      trace("submitted-run-transcript-catchup:exhausted", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        traceId: target.traceId ?? null,
        reason: target.reason,
      });
      return;
    }

    const timer = setTimer(() => {
      timers.delete(timer);
      if (disposed) return;
      void runAttempt(target, baseline, attemptIndex);
    }, Math.max(0, delayMs));
    timers.add(timer);
  };

  const runAttempt = async (
    target: NormalizedSubmittedRunTranscriptCatchupTarget,
    baseline: { assistantCount: number; observationVersion: number },
    attemptIndex: number,
  ) => {
    if (disposed) return;
    const selectedSessionId = normalize(options.selectedSessionId());
    if (selectedSessionId !== target.sessionId) {
      trace("submitted-run-transcript-catchup:defer-not-selected", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        selectedSessionId: selectedSessionId || null,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      scheduleAttempt(target, baseline, attemptIndex + 1);
      return;
    }

    const selectedWorkspaceId = normalize(options.resolveSelectedSessionWorkspaceId?.(target.sessionId));
    if (selectedWorkspaceId && selectedWorkspaceId !== target.workspaceId) {
      trace("submitted-run-transcript-catchup:defer-workspace-mismatch", {
        workspaceId: target.workspaceId,
        selectedWorkspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      scheduleAttempt(target, baseline, attemptIndex + 1);
      return;
    }

    if (options.assistantObservationVersion(target.sessionId) > baseline.observationVersion) {
      trace("submitted-run-transcript-catchup:skip-assistant-observed", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      return;
    }

    if (options.assistantMessageCount(target.sessionId) > baseline.assistantCount) {
      trace("submitted-run-transcript-catchup:skip-assistant-cached", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
      });
      return;
    }

    try {
      const snapshot = await options.loadTranscript(target);
      if (disposed) return;
      if (!snapshot || snapshot.source === "unavailable") {
        trace("submitted-run-transcript-catchup:transcript-unavailable", {
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          runId: target.runId ?? null,
          attempt: attemptIndex + 1,
        });
        scheduleAttempt(target, baseline, attemptIndex + 1);
        return;
      }

      const hydrationSnapshot = retargetSnapshotForCatchupTarget(snapshot, target);
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
        scheduleAttempt(target, baseline, attemptIndex + 1);
      }
    } catch (error) {
      trace("submitted-run-transcript-catchup:error", {
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        runId: target.runId ?? null,
        attempt: attemptIndex + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      scheduleAttempt(target, baseline, attemptIndex + 1);
    }
  };

  return {
    schedule(input: SubmittedRunTranscriptCatchupTarget) {
      if (disposed) {
        trace("submitted-run-transcript-catchup:skip-disposed", {
          workspaceId: input.workspaceId?.trim() || null,
          sessionId: input.sessionId?.trim() || null,
          runId: input.runId?.trim() || null,
          traceId: input.traceId?.trim() || null,
          reason: input.reason,
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
      trace("submitted-run-transcript-catchup:scheduled", {
        workspaceId,
        sessionId,
        directory: target.directory,
        runId: target.runId,
        traceId: target.traceId,
        reason: target.reason,
      });
      scheduleAttempt(target, {
        assistantCount: options.assistantMessageCount(sessionId),
        observationVersion: options.assistantObservationVersion(sessionId),
      }, 0);
    },
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
    },
  };
}
