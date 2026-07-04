import type { EngineState } from "./engine-pool.js";

export const RUNTIME_ENGINE_STATES = [
  "absent",
  "starting",
  "process_ready",
  "workspace_api_waiting",
  "ready",
  "stopped",
  "failed",
] as const;

export type RuntimeEngineState = (typeof RUNTIME_ENGINE_STATES)[number];

export function runtimeEngineStateFromEngineState(
  state: EngineState | null | undefined,
): RuntimeEngineState {
  switch (state) {
    case "spawning":
      return "starting";
    case "ready":
    case "idle":
      return "ready";
    case "suspended":
      return "stopped";
    case "crashed":
      return "failed";
    case null:
    case undefined:
      return "absent";
    default:
      return "failed";
  }
}

export function isForwardableRuntimeEngineState(state: RuntimeEngineState): boolean {
  return state === "ready" || state === "process_ready";
}
