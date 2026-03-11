export type OpenSessionWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  workspaceId: string;
  sessionId: string;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  openSession: (sessionId: string) => void;
};

// Keep cross-worker session navigation single-flight to avoid overlapping
// activateWorkspace calls when users click between workers rapidly.
let openSessionNavigationQueue: Promise<void> = Promise.resolve();
let openSessionNavigationToken = 0;

export async function openSessionWithWorkspaceActivation(
  input: OpenSessionWithWorkspaceActivationInput,
): Promise<boolean> {
  const sessionId = input.sessionId.trim();
  const workspaceId = input.workspaceId.trim();
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  const getActiveWorkspaceId = () => input.getActiveWorkspaceId?.().trim() || activeWorkspaceId;
  if (!sessionId || !workspaceId) return false;

  const token = ++openSessionNavigationToken;

  const run = async () => {
    if (token !== openSessionNavigationToken) return false;

    if (workspaceId !== getActiveWorkspaceId()) {
      const activated = await Promise.resolve(input.activateWorkspace(workspaceId));
      if (!activated) return false;
    }

    if (token !== openSessionNavigationToken) return false;
    input.openSession(sessionId);
    return true;
  };

  const task = openSessionNavigationQueue.then(run, run);
  openSessionNavigationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
}
