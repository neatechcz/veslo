import type {
  VesloServerCapabilities,
  VesloServerStatus,
} from "./types";

export type VesloServerStatusProbeResult = {
  status: VesloServerStatus;
  capabilities: VesloServerCapabilities | null;
};

export type VesloServerStatusStabilityState = {
  lastStableStatus: Extract<VesloServerStatus, "connected" | "limited"> | null;
  lastStableCapabilities: VesloServerCapabilities | null;
  lastStableAt: number | null;
  transientFailureCount: number;
};

export type VesloServerStatusStabilityDecision = {
  state: VesloServerStatusStabilityState;
  visibleStatus: VesloServerStatus;
  visibleCapabilities: VesloServerCapabilities | null;
  transientFailure: boolean;
  nextDelayMs: number;
};

export type VesloServerStatusStabilityOptions = {
  nowMs: number;
  previousDelayMs: number;
  successDelayMs?: number;
  transientFailureGraceMs?: number;
  maxTransientFailures?: number;
  coldStartFailureMaxDelayMs?: number;
  recoveredFailureMaxDelayMs?: number;
};

const DEFAULT_SUCCESS_DELAY_MS = 10_000;
const DEFAULT_TRANSIENT_FAILURE_GRACE_MS = 30_000;
const DEFAULT_MAX_TRANSIENT_FAILURES = 2;
const DEFAULT_COLD_START_FAILURE_MAX_DELAY_MS = 5_000;
const DEFAULT_RECOVERED_FAILURE_MAX_DELAY_MS = 30_000;

export function createInitialVesloServerStatusStabilityState(): VesloServerStatusStabilityState {
  return {
    lastStableStatus: null,
    lastStableCapabilities: null,
    lastStableAt: null,
    transientFailureCount: 0,
  };
}

export function applyVesloServerStatusProbe(
  previous: VesloServerStatusStabilityState,
  result: VesloServerStatusProbeResult,
  options: VesloServerStatusStabilityOptions,
): VesloServerStatusStabilityDecision {
  const successDelayMs = options.successDelayMs ?? DEFAULT_SUCCESS_DELAY_MS;
  const transientFailureGraceMs =
    options.transientFailureGraceMs ?? DEFAULT_TRANSIENT_FAILURE_GRACE_MS;
  const maxTransientFailures =
    options.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT_FAILURES;
  const coldStartFailureMaxDelayMs =
    options.coldStartFailureMaxDelayMs ?? DEFAULT_COLD_START_FAILURE_MAX_DELAY_MS;
  const recoveredFailureMaxDelayMs =
    options.recoveredFailureMaxDelayMs ?? DEFAULT_RECOVERED_FAILURE_MAX_DELAY_MS;

  if (result.status === "connected" || result.status === "limited") {
    const state: VesloServerStatusStabilityState = {
      lastStableStatus: result.status,
      lastStableCapabilities: result.capabilities,
      lastStableAt: options.nowMs,
      transientFailureCount: 0,
    };
    return {
      state,
      visibleStatus: result.status,
      visibleCapabilities: result.capabilities,
      transientFailure: false,
      nextDelayMs: successDelayMs,
    };
  }

  if (result.status === "auth_desync") {
    return {
      state: {
        ...previous,
        transientFailureCount: 0,
      },
      visibleStatus: "auth_desync",
      visibleCapabilities: null,
      transientFailure: false,
      nextDelayMs: successDelayMs,
    };
  }

  const transientFailureCount = previous.transientFailureCount + 1;
  const stableAgeMs =
    previous.lastStableAt === null
      ? Number.POSITIVE_INFINITY
      : options.nowMs - previous.lastStableAt;
  const stableStatus = previous.lastStableStatus;
  const canKeepStableStatus =
    stableStatus !== null &&
    stableAgeMs <= transientFailureGraceMs &&
    transientFailureCount <= maxTransientFailures;
  const state: VesloServerStatusStabilityState = {
    ...previous,
    transientFailureCount,
  };

  if (canKeepStableStatus) {
    return {
      state,
      visibleStatus: stableStatus,
      visibleCapabilities: previous.lastStableCapabilities,
      transientFailure: true,
      nextDelayMs: successDelayMs,
    };
  }

  const maxFailureDelayMs =
    previous.lastStableAt === null
      ? coldStartFailureMaxDelayMs
      : recoveredFailureMaxDelayMs;
  return {
    state,
    visibleStatus: "disconnected",
    visibleCapabilities: null,
    transientFailure: false,
    nextDelayMs: Math.min(Math.max(options.previousDelayMs * 2, successDelayMs), maxFailureDelayMs),
  };
}
