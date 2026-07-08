import { withTimeoutOrThrow } from "./promise-timeout";

export type WorkspaceSwitchTimeouts = {
  engineStopMs: number;
  engineStartMs: number;
  vesloHostWorkspaceActivateMs: number;
};

const DEFAULT_WORKSPACE_SWITCH_TIMEOUTS: WorkspaceSwitchTimeouts = {
  engineStopMs: 20_000,
  engineStartMs: 75_000,
  // VSLO-86 — widened from 12s to 30s. The inner client.listWorkspaces +
  // client.activateWorkspace round-trip nominally takes <30ms when measured
  // directly against the server, but it runs through Tauri's HTTP plugin
  // alongside the orchestrator SSE stream, the engine status polls and the
  // workspace-config patch effect — boot-time contention occasionally pushes
  // these past 12s and the user sees the "Opening conversation…" spinner.
  // The outer activate flow still falls back to startHost on failure, so the
  // worst case is just a longer wait, not a stuck spinner.
  vesloHostWorkspaceActivateMs: 30_000,
};

export async function runWorkspaceEngineRestartWithTimeouts<TStop, TStart>(
  operations: {
    stop: () => Promise<TStop>;
    start: () => Promise<TStart>;
  },
  timeouts: WorkspaceSwitchTimeouts = DEFAULT_WORKSPACE_SWITCH_TIMEOUTS,
) {
  const stopResult = await withTimeoutOrThrow(
    operations.stop(),
    { timeoutMs: timeouts.engineStopMs, label: "engine_stop" },
  );
  const startResult = await withTimeoutOrThrow(
    operations.start(),
    { timeoutMs: timeouts.engineStartMs, label: "engine_start" },
  );
  return { stopResult, startResult };
}

export async function activateVesloHostWorkspaceWithTimeout<T>(
  operation: () => Promise<T>,
  timeouts: WorkspaceSwitchTimeouts = DEFAULT_WORKSPACE_SWITCH_TIMEOUTS,
) {
  return await withTimeoutOrThrow(
    operation(),
    {
      timeoutMs: timeouts.vesloHostWorkspaceActivateMs,
      label: "veslo host workspace activation",
    },
  );
}
