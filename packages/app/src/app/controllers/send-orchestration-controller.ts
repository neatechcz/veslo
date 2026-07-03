export function resolveSendPromptBusyOwnership(input: {
  sessionId: string | null | undefined;
}): { ownsBusy: boolean } {
  return { ownsBusy: Boolean(input.sessionId?.trim()) };
}

export type CreateSessionPreflightDecision =
  | { type: "skip"; reason: "send-preflight-already-ready" | "send-preflight-already-healthy" }
  | { type: "run" };

export function resolveCreateSessionManagedAiPreflightDecision(input: {
  preflightManagedAiReady: boolean;
}): CreateSessionPreflightDecision {
  if (input.preflightManagedAiReady) {
    return { type: "skip", reason: "send-preflight-already-ready" };
  }
  return { type: "run" };
}

export function resolveCreateSessionRuntimeHealthPreflightDecision(input: {
  preflightEnginePrepared: boolean;
  preflightRuntimeHealthOk: boolean;
}): CreateSessionPreflightDecision {
  if (input.preflightEnginePrepared) {
    return { type: "skip", reason: "send-preflight-already-ready" };
  }
  if (input.preflightRuntimeHealthOk) {
    return { type: "skip", reason: "send-preflight-already-healthy" };
  }
  return { type: "run" };
}
