import { withTimeoutOrThrow } from "./promise-timeout";

export type WorkspaceSwitchTimeouts = {
  engineStopMs: number;
  engineStartMs: number;
  vesloHostWorkspaceActivateMs: number;
};

export const DEFAULT_WORKSPACE_SWITCH_TIMEOUTS: WorkspaceSwitchTimeouts = {
  engineStopMs: 20_000,
  engineStartMs: 75_000,
  vesloHostWorkspaceActivateMs: 12_000,
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
