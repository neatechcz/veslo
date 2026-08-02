import type { ConversationWorkspaceRunReservation } from "./conversation-run-queue-store.js";
import {
  trustedRuntimeOwnerMatches,
  type TrustedRuntimeOwnerTuple,
} from "./runtime-evidence.js";

export type ConversationRunEngineLossEvidence = Required<Pick<
  TrustedRuntimeOwnerTuple,
  "engineSlotId" | "engineOwnerId" | "enginePid" | "engineStartedAt" | "engineBaseUrl"
>>;

export type EngineLossAdmissionDecision =
  | { kind: "buffer-pre-attachment" }
  | { kind: "release-matching-owner" }
  | { kind: "ignore-stale-or-incomplete-owner" };

/**
 * Classifies process-loss evidence without performing any durable effect. The
 * lifecycle facade remains responsible for persistence, release, and queue
 * wake-up ordering.
 */
export function decideEngineLossAdmission(
  reservation: ConversationWorkspaceRunReservation,
  evidence: ConversationRunEngineLossEvidence,
): EngineLossAdmissionDecision {
  if (!reservation.engineOwnerId?.trim()) {
    return { kind: "buffer-pre-attachment" };
  }
  return trustedRuntimeOwnerMatches(reservation, evidence)
    ? { kind: "release-matching-owner" }
    : { kind: "ignore-stale-or-incomplete-owner" };
}
