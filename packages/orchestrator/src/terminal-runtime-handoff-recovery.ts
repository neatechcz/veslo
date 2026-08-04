import type {
  EngineGenerationAuthority,
  EngineOwnerEvidence,
} from "./engine-generation-authority.js";
import type { CurrentRuntimeEvidenceKind } from "./current-runtime-evidence.js";
import type { RunEngineOwner } from "./run-store.js";

export type TerminalRuntimeHandoffEvidence =
  | { kind: "runtime_active" }
  | EngineOwnerEvidence;

export async function resolveTerminalRuntimeHandoffEvidence(input: {
  owner: RunEngineOwner;
  currentRuntimeEvidence: CurrentRuntimeEvidenceKind;
  generationAuthority: Pick<EngineGenerationAuthority, "resolveOwnerEvidence">;
}): Promise<TerminalRuntimeHandoffEvidence> {
  if (
    input.currentRuntimeEvidence === "running" ||
    input.currentRuntimeEvidence === "starting"
  ) {
    return { kind: "runtime_active" };
  }
  return input.generationAuthority.resolveOwnerEvidence({
    owner: input.owner,
    currentRuntimeEvidence: input.currentRuntimeEvidence,
  });
}
