import type { LifecycleRunStatus, LifecycleRunStatusResult } from "./orchestrator-lifecycle-client.js";

const ACTIVE_LIFECYCLE_STATUSES = new Set<LifecycleRunStatus>(["submitted", "running", "blocked"]);

export type TerminalizationReasonCode =
  | "upstream_submit_failed"
  | "reconcile_exhausted"
  | "startup_orphaned_assistant_message"
  | "engine_unreachable_without_progress";

export type ReconciliationEvidenceClassification =
  | { kind: "authoritative-absence" }
  | { kind: "active" }
  | { kind: "unavailable" }
  | { kind: "terminal" }
  | { kind: "terminalization-required"; reasonCode: TerminalizationReasonCode };

export type ExhaustedReconciliationClassification =
  | { kind: "terminalization-required"; reasonCode: "reconcile_exhausted" }
  | { kind: "background-observe-no-output" }
  | { kind: "retain" };

export function terminalizationMessageForReason(reasonCode: TerminalizationReasonCode): string {
  switch (reasonCode) {
    case "upstream_submit_failed":
      return "OpenCode submit failed before the run could be accepted";
    case "reconcile_exhausted":
      return "Run lifecycle reconcile exhausted while active status remained unresolved";
    case "startup_orphaned_assistant_message":
      return "Startup lifecycle reservation had no useful progress while its assistant message remained open";
    case "engine_unreachable_without_progress":
      return "Engine remained unreachable after useful run progress stopped";
  }
}

export function normalizeTerminalizationReasonCode(value: string | null | undefined): TerminalizationReasonCode {
  switch (value) {
    case "upstream_submit_failed":
    case "reconcile_exhausted":
    case "startup_orphaned_assistant_message":
    case "engine_unreachable_without_progress":
      return value;
    default:
      return "reconcile_exhausted";
  }
}

export function terminalizationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "terminal lifecycle write unavailable";
}

export function isActiveLifecycleStatus(status: LifecycleRunStatus | string | null | undefined): boolean {
  return Boolean(status && ACTIVE_LIFECYCLE_STATUSES.has(status as LifecycleRunStatus));
}

export function classifyReconciliationEvidence(input: {
  status: LifecycleRunStatusResult | null | undefined;
  reason: string;
  now: number;
  startupOrphanedAssistantMessageGraceMs: number;
  engineUnreachableWithoutProgressGraceMs: number;
}): ReconciliationEvidenceClassification {
  const status = input.status;
  if (!status) return { kind: "authoritative-absence" };
  if (!isActiveLifecycleStatus(status.status)) {
    // A stale response never becomes release authority merely because its
    // recorded status was terminal. The exact current run must be read again.
    return status.stale === true ? { kind: "unavailable" } : { kind: "terminal" };
  }

  const lastUsefulProgressAt = status.lastUsefulProgressAt ?? null;
  const hasExpiredProgress = typeof lastUsefulProgressAt === "number" &&
    Number.isFinite(lastUsefulProgressAt) &&
    input.now - lastUsefulProgressAt >= input.startupOrphanedAssistantMessageGraceMs;
  if (
    input.reason === "startup-workspace-reservation-reconcile" &&
    status.activityKind === "unknown" &&
    status.waitReason === "assistant_message_open" &&
    hasExpiredProgress
  ) {
    return { kind: "terminalization-required", reasonCode: "startup_orphaned_assistant_message" };
  }
  if (
    status.stale === true &&
    status.waitReason === "engine_unreachable" &&
    typeof lastUsefulProgressAt === "number" &&
    Number.isFinite(lastUsefulProgressAt) &&
    input.now - lastUsefulProgressAt >= input.engineUnreachableWithoutProgressGraceMs
  ) {
    return { kind: "terminalization-required", reasonCode: "engine_unreachable_without_progress" };
  }
  return status.stale === true ? { kind: "unavailable" } : { kind: "active" };
}

export function classifyExhaustedReconciliation(
  status: LifecycleRunStatusResult | null | undefined,
): ExhaustedReconciliationClassification {
  if (!status || !isActiveLifecycleStatus(status.status)) return { kind: "retain" };
  return status.waitReason === "model_retry_no_output"
    ? { kind: "background-observe-no-output" }
    : { kind: "terminalization-required", reasonCode: "reconcile_exhausted" };
}
