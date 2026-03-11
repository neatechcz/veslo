export type OpenSessionWithWorkspaceActivationInput = {
  activeWorkspaceId: string;
  workspaceId: string;
  sessionId: string;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  openSession: (sessionId: string) => void;
};

export async function openSessionWithWorkspaceActivation(
  input: OpenSessionWithWorkspaceActivationInput,
): Promise<boolean> {
  const sessionId = input.sessionId.trim();
  const workspaceId = input.workspaceId.trim();
  const activeWorkspaceId = input.activeWorkspaceId.trim();
  if (!sessionId || !workspaceId) return false;

  if (workspaceId === activeWorkspaceId) {
    input.openSession(sessionId);
    return true;
  }

  const activated = await Promise.resolve(input.activateWorkspace(workspaceId));
  if (!activated) return false;

  input.openSession(sessionId);
  return true;
}
