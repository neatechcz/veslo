import type { EngineState } from "./engine-pool.js";

type RuntimeSnapshot = {
  state: EngineState;
  childKind?: "direct" | "wsl";
};

export type CurrentRuntimeEvidenceKind =
  | "running"
  | "starting"
  | "stopped_snapshot"
  | "absent"
  | "unsupported_wrapper_snapshot";

export type CurrentRuntimeEvidence<Engine extends RuntimeSnapshot> =
  | { kind: "running"; engine: Engine }
  | { kind: "starting" }
  | { kind: "stopped_snapshot"; engine: Engine }
  | { kind: "absent" }
  | { kind: "unsupported_wrapper_snapshot"; engine: Engine };

export function classifyCurrentRuntimeEvidence<Engine extends RuntimeSnapshot>(input: {
  snapshot: Engine | null | undefined;
  sharedPendingStart?: boolean;
}): CurrentRuntimeEvidence<Engine> {
  const snapshot = input.snapshot;
  if (snapshot?.state === "ready" || snapshot?.state === "idle") {
    return { kind: "running", engine: snapshot };
  }
  if (snapshot?.state === "spawning" || input.sharedPendingStart === true) {
    return { kind: "starting" };
  }
  if (!snapshot) return { kind: "absent" };
  // Only an explicitly direct child is a supported stopped snapshot. A wrapper
  // kind — or a snapshot that never recorded one — stays unsupported, so an
  // undeclared topology can never inherit direct-child exit evidence.
  if (snapshot.childKind !== "direct") {
    return { kind: "unsupported_wrapper_snapshot", engine: snapshot };
  }
  return { kind: "stopped_snapshot", engine: snapshot };
}

export function runningEngineFromCurrentRuntimeEvidence<Engine extends RuntimeSnapshot>(
  evidence: CurrentRuntimeEvidence<Engine>,
): Engine | null {
  return evidence.kind === "running" ? evidence.engine : null;
}
