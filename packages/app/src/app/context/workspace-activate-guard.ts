/**
 * Guard that prevents the workspace-switch overlay from getting stuck
 * when activateWorkspace is called concurrently from multiple code paths
 * (navigation queue, boot flow, dashboard, soul, recovery, etc.).
 *
 * Problem: activateWorkspace sets `connectingWorkspaceId` at the start and
 * clears it in the `finally` block — but only if the current value still
 * matches. When two activations overlap:
 *
 *   1. Call A sets connectingWorkspaceId = "A"
 *   2. Call B sets connectingWorkspaceId = "B"   (overwrites)
 *   3. Call A finishes: current("B") !== "A"  →  does NOT clear
 *   4. If B then fails or bails, connectingWorkspaceId stays "B" forever
 *      → overlay stays open
 *
 * Solution: track a monotonically increasing version. Each activation
 * records its version at the start. The cleanup unconditionally clears
 * connectingWorkspaceId unless a NEWER activation has started since.
 */

export type WorkspaceActivateGuard = {
  /** Call at the start of each activateWorkspace. Returns the version. */
  enter(workspaceId: string): number;

  /**
   * Returns true if a newer activation has started since `version`.
   * Use this for early-exit checks inside activateWorkspace.
   */
  isSuperseded(version: number): boolean;

  /**
   * Call in the finally block. Clears the connecting state UNLESS a newer
   * activation has started. This replaces the fragile
   * `current === id ? null : current` conditional.
   */
  exit(
    version: number,
    clearConnecting: (updater: (current: string | null) => string | null) => void,
  ): void;
};

export function createWorkspaceActivateGuard(): WorkspaceActivateGuard {
  let currentVersion = 0;

  return {
    enter(_workspaceId: string): number {
      return ++currentVersion;
    },

    isSuperseded(version: number): boolean {
      return version !== currentVersion;
    },

    exit(
      version: number,
      clearConnecting: (updater: (current: string | null) => string | null) => void,
    ): void {
      // Only clear if no newer activation has started since ours.
      // If a newer one started, it owns the connectingWorkspaceId signal.
      if (version === currentVersion) {
        clearConnecting(() => null);
      }
    },
  };
}
