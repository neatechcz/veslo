import { createHash } from "node:crypto";

import type { ConversationWorkspaceRunReservation } from "./conversation-run-queue-store.js";

export type TrustedRuntimeOwnerTuple = Pick<
  ConversationWorkspaceRunReservation,
  | "engineSlotId"
  | "engineOwnerId"
  | "directoryInstanceEpoch"
  | "enginePid"
  | "engineStartedAt"
  | "engineBaseUrl"
  | "skillViewRevision"
  | "authorizationRevision"
  | "openCodeConfigDigest"
>;

type ExactEngineLossOwnerTuple = Pick<
  TrustedRuntimeOwnerTuple,
  "engineSlotId" | "engineOwnerId" | "enginePid" | "engineStartedAt" | "engineBaseUrl"
>;

export type RuntimeEvidenceProjection = {
  workspaceId: string;
  generationFingerprint: string | null;
  readiness: "attached" | "missing";
  observedAt: string;
  source: "orchestrator" | "server" | "desktop";
  reasonCode: string | null;
};

export type RuntimeEvidenceProjectionInput = {
  workspaceId: string;
  owner: TrustedRuntimeOwnerTuple;
  observedAt: string;
  source: RuntimeEvidenceProjection["source"];
  reasonCode?: string | null;
};

export function trustedRuntimeOwnerMatches(
  reservation: ExactEngineLossOwnerTuple,
  evidence: Required<ExactEngineLossOwnerTuple>,
): boolean {
  return reservation.engineOwnerId === evidence.engineOwnerId &&
    reservation.enginePid === evidence.enginePid &&
    reservation.engineStartedAt === evidence.engineStartedAt &&
    reservation.engineBaseUrl === evidence.engineBaseUrl &&
    reservation.engineSlotId === evidence.engineSlotId;
}

/**
 * A safe, stable identifier for diagnostics and UI projections. It deliberately
 * excludes the raw local endpoint and owner identifier from the projection.
 */
export function runtimeEvidenceGenerationFingerprint(owner: TrustedRuntimeOwnerTuple): string | null {
  const engineSlotId = owner.engineSlotId?.trim() ?? "";
  const engineOwnerId = owner.engineOwnerId?.trim() ?? "";
  const engineBaseUrl = owner.engineBaseUrl?.trim() ?? "";
  const enginePid = owner.enginePid;
  const engineStartedAt = owner.engineStartedAt;
  if (
    !engineSlotId ||
    !engineOwnerId ||
    !engineBaseUrl ||
    typeof enginePid !== "number" || !Number.isSafeInteger(enginePid) || enginePid <= 0 ||
    typeof engineStartedAt !== "number" || !Number.isSafeInteger(engineStartedAt) || engineStartedAt <= 0
  ) return null;

  return createHash("sha256").update(JSON.stringify({
    engineSlotId,
    engineOwnerId,
    enginePid,
    engineStartedAt,
    engineBaseUrl,
    directoryInstanceEpoch: owner.directoryInstanceEpoch ?? null,
    skillViewRevision: owner.skillViewRevision ?? null,
    authorizationRevision: owner.authorizationRevision ?? null,
    openCodeConfigDigest: owner.openCodeConfigDigest ?? null,
  })).digest("hex");
}

export function projectRuntimeEvidence(
  input: RuntimeEvidenceProjectionInput,
): RuntimeEvidenceProjection {
  return {
    workspaceId: input.workspaceId,
    generationFingerprint: runtimeEvidenceGenerationFingerprint(input.owner),
    readiness: input.owner.engineOwnerId?.trim() ? "attached" : "missing",
    observedAt: input.observedAt,
    source: input.source,
    reasonCode: input.reasonCode?.trim() || null,
  };
}
