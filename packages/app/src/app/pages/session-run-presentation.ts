export type SessionRunPhase = "idle" | "sending" | "thinking" | "retrying" | "responding" | "error";

export type SessionRunPresentation = {
  phase: SessionRunPhase;
  showIndicator: boolean;
  abortable: boolean;
  source: "local" | "lifecycle" | "engine" | null;
  diagnosticKind: "model-retry" | "model-retry-blocked" | null;
};

export type SessionRunLifecycleEvidence = {
  runId?: string | null;
  status: string;
  stale: boolean;
  clientMessageId?: string | null;
  waitReason?: string | null;
};

export type SessionRunPresentationInput = {
  hasSessionScope: boolean;
  engineStatus: string | null | undefined;
  lifecycle: SessionRunLifecycleEvidence | null | undefined;
  local: {
    started: boolean;
    hasBegun: boolean;
    optimisticSending: boolean;
    optimisticAccepted?: boolean;
    acceptedRunId?: string | null;
    acceptedClientMessageId?: string | null;
    responseStarted: boolean;
  };
};

const ACTIVE_ENGINE_STATUSES = new Set(["submitted", "running", "retry", "blocked"]);
const ACTIVE_LIFECYCLE_STATUSES = new Set(["submitted", "running", "blocked"]);
const TERMINAL_LIFECYCLE_STATUSES = new Set(["completed", "failed", "aborted"]);

const normalized = (value: string | null | undefined) => value?.trim() ?? "";

const idlePresentation = (): SessionRunPresentation => ({
  phase: "idle",
  showIndicator: false,
  abortable: false,
  source: null,
  diagnosticKind: null,
});

export function terminalLifecycleOwnsOptimistic(input: {
  lifecycle: SessionRunLifecycleEvidence | null | undefined;
  optimisticSending: boolean;
  optimisticAccepted?: boolean;
  acceptedRunId?: string | null;
  acceptedClientMessageId?: string | null;
}): boolean {
  const lifecycle = input.lifecycle;
  if (lifecycle?.stale === true || !TERMINAL_LIFECYCLE_STATUSES.has(lifecycle?.status ?? "")) return false;
  if (!input.optimisticSending) return true;
  if (input.optimisticAccepted !== true) return false;
  return Boolean(
    (normalized(lifecycle?.runId) && normalized(lifecycle?.runId) === normalized(input.acceptedRunId)) ||
    (
      normalized(lifecycle?.clientMessageId) &&
      normalized(lifecycle?.clientMessageId) === normalized(input.acceptedClientMessageId)
    ),
  );
}

export function deriveSessionRunPresentation(input: SessionRunPresentationInput): SessionRunPresentation {
  const lifecycle = input.lifecycle;
  const engineStatus = input.engineStatus?.trim().toLowerCase() ?? "idle";
  const engineActive = input.hasSessionScope && ACTIVE_ENGINE_STATUSES.has(engineStatus);
  const terminalOwnsLocal = terminalLifecycleOwnsOptimistic({
    lifecycle,
    optimisticSending: input.local.optimisticSending,
    optimisticAccepted: input.local.optimisticAccepted,
    acceptedRunId: input.local.acceptedRunId,
    acceptedClientMessageId: input.local.acceptedClientMessageId,
  });
  if (terminalOwnsLocal && (input.local.optimisticSending || !engineActive)) {
    return idlePresentation();
  }
  const lifecycleActive = lifecycle?.stale !== true && ACTIVE_LIFECYCLE_STATUSES.has(lifecycle?.status ?? "");
  if (lifecycleActive) {
    if (lifecycle?.waitReason === "model_retry_no_output") {
      const blocked = lifecycle.status === "blocked";
      return {
        phase: blocked ? "error" : "retrying",
        showIndicator: true,
        abortable: true,
        source: "lifecycle",
        diagnosticKind: blocked ? "model-retry-blocked" : "model-retry",
      };
    }
    return {
      phase: input.local.responseStarted ? "responding" : "thinking",
      showIndicator: true,
      abortable: true,
      source: "lifecycle",
      diagnosticKind: null,
    };
  }

  if (input.local.optimisticSending) {
    return {
      phase: "responding",
      showIndicator: true,
      abortable: false,
      source: "local",
      diagnosticKind: null,
    };
  }

  if (engineActive) {
    return {
      phase: input.local.responseStarted ? "responding" : engineStatus === "retry" ? "retrying" : "thinking",
      showIndicator: true,
      abortable: true,
      source: "engine",
      diagnosticKind: null,
    };
  }

  if (input.local.started) {
    return {
      phase: input.local.responseStarted ? "responding" : "sending",
      showIndicator: true,
      abortable: false,
      source: "local",
      diagnosticKind: null,
    };
  }

  return idlePresentation();
}
