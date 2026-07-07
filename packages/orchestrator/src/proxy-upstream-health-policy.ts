export type ProxyUpstreamHealthPolicyInput = {
  method?: string | null;
  requestPath?: string | null;
  targetPath?: string | null;
  errorMessage?: string | null;
  isShuttingDown?: boolean;
};

export type ProxyUpstreamHealthPolicy = {
  eventStream: boolean;
  shutdown: boolean;
  nonFatalEngineError: boolean;
  markSharedEngineUnhealthy: boolean;
};

const normalize = (value?: string | null) => value?.trim().toLowerCase() ?? "";

const isEventStreamPath = (input: ProxyUpstreamHealthPolicyInput): boolean => {
  const requestPath = normalize(input.requestPath);
  const targetPath = normalize(input.targetPath);
  return targetPath === "/event" || requestPath.endsWith("/opencode/event");
};

const isTransientSocketClose = (message: string): boolean =>
  /\b(econnreset|aborted|premature close|socket hang up|connection reset|connection closed|socket closed|stream closed|terminated)\b/i.test(
    message,
  ) || /socket connection was closed/i.test(message);

export function classifySharedProxyUpstreamError(
  input: ProxyUpstreamHealthPolicyInput,
): ProxyUpstreamHealthPolicy {
  const eventStream = normalize(input.method) === "get" && isEventStreamPath(input);
  const shutdown = input.isShuttingDown === true;
  const transientEventStreamClose = eventStream && isTransientSocketClose(input.errorMessage ?? "");
  const transientShutdownClose = shutdown && isTransientSocketClose(input.errorMessage ?? "");
  const nonFatalEngineError = transientEventStreamClose || transientShutdownClose;

  return {
    eventStream,
    shutdown,
    nonFatalEngineError,
    markSharedEngineUnhealthy: !nonFatalEngineError,
  };
}
