export type OrchestratorWorkspaceRegistrationFlight = {
  id: string;
  promise: Promise<void>;
};

export type OrchestratorWorkspaceRegistrationScope = {
  readonly kind: "conversation-submit";
  readonly id: string;
  readonly registrations: Map<string, OrchestratorWorkspaceRegistrationFlight>;
  nextFlightId(): string;
};

let scopeSequence = 0;

export function createOrchestratorWorkspaceRegistrationScope(): OrchestratorWorkspaceRegistrationScope {
  const id = "submit-" + String(++scopeSequence);
  let flightSequence = 0;
  return {
    kind: "conversation-submit",
    id,
    registrations: new Map(),
    nextFlightId: () => id + ":registration-" + String(++flightSequence),
  };
}
