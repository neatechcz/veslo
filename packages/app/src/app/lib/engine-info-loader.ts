import { createKeyedSingleFlight } from "./keyed-single-flight";

type EngineInfoInvoke<Value> = (input: {
  workspaceId: string | null;
  workspacePath: string | null;
}) => Promise<Value>;

/**
 * Native engine status is a live read. This loader joins concurrent callers
 * for one normalized workspace target, then immediately forgets the result so
 * a later call cannot observe a stale orchestrator generation.
 */
export function createEngineInfoLoader<Value>(invoke: EngineInfoInvoke<Value>) {
  const singleFlight = createKeyedSingleFlight<string, Value>();

  return (workspaceId?: string, workspacePath?: string): Promise<Value> => {
    const normalizedWorkspaceId = workspaceId?.trim() || null;
    const normalizedWorkspacePath = workspacePath?.trim() || null;
    const key = `${normalizedWorkspaceId ?? ""}\u0000${normalizedWorkspacePath ?? ""}`;
    return singleFlight.run(key, () =>
      invoke({
        workspaceId: normalizedWorkspaceId,
        workspacePath: normalizedWorkspacePath,
      }),
    );
  };
}
