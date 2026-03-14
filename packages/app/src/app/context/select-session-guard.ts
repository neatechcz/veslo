/**
 * Guard against stale session-select dedup.
 *
 * When the user clicks A→B→A rapidly, the in-flight load for session A from
 * the first click is stale (it will abort via the version check).  Without
 * this guard the third click joins the stale promise and session A never
 * loads its data — the app appears frozen.
 *
 * The guard tracks which `selectVersion` started each in-flight load.  A
 * dedup join is only allowed when the in-flight was started in the
 * immediately preceding version cycle (same session, no intervening
 * selection change, e.g. a route re-fire or double-click).
 */

export type SelectSessionGuard = {
  /** Increment the global version counter — call once per selectSession invocation. */
  nextVersion(): number;

  /** Read the current (latest) version without incrementing. */
  currentVersion(): number;

  /**
   * Returns the existing in-flight promise if it is safe to join (same
   * session, no intervening selection change). Otherwise returns `null` and
   * the caller should start a fresh load.
   */
  tryDedup(sessionID: string): Promise<void> | null;

  /** Register a newly started load for `sessionID`. */
  register(sessionID: string, version: number, promise: Promise<void>): void;

  /** Remove the entry for `sessionID` if it matches `promise`. */
  cleanup(sessionID: string, promise: Promise<void>): void;
};

export function createSelectSessionGuard(): SelectSessionGuard {
  let selectVersion = 0;
  const inFlightBySession = new Map<string, Promise<void>>();
  const versionBySession = new Map<string, number>();

  return {
    nextVersion() {
      return ++selectVersion;
    },

    currentVersion() {
      return selectVersion;
    },

    tryDedup(sessionID: string): Promise<void> | null {
      const existing = inFlightBySession.get(sessionID);
      if (!existing) return null;
      const existingVersion = versionBySession.get(sessionID);
      if (existingVersion === undefined) return null;
      // Only join when the in-flight was started in the immediately preceding
      // version (i.e. same session, no other session selected in between).
      if (selectVersion - existingVersion === 1) {
        return existing;
      }
      return null;
    },

    register(sessionID: string, version: number, promise: Promise<void>) {
      inFlightBySession.set(sessionID, promise);
      versionBySession.set(sessionID, version);
    },

    cleanup(sessionID: string, promise: Promise<void>) {
      if (inFlightBySession.get(sessionID) === promise) {
        inFlightBySession.delete(sessionID);
        versionBySession.delete(sessionID);
      }
    },
  };
}
