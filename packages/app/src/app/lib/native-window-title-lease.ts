import { reportError } from "./error-reporter";
import { setWindowTitle } from "./tauri";

const DEFAULT_ACTIVE_TITLE = "";
const DEFAULT_FALLBACK_TITLE = "Veslo by Neatech";

type ApplyTitle = (title: string) => Promise<void>;

type NativeWindowTitleLeaseManagerOptions = {
  activeTitle?: string;
  fallbackTitle?: string;
  applyTitle?: ApplyTitle;
  onError?: (error: unknown) => void;
};

export type NativeWindowTitleLeaseManager = {
  acquire: () => () => void;
  whenIdle: () => Promise<void>;
};

export function createNativeWindowTitleLeaseManager(
  options: NativeWindowTitleLeaseManagerOptions = {},
): NativeWindowTitleLeaseManager {
  const activeTitle = options.activeTitle ?? DEFAULT_ACTIVE_TITLE;
  const fallbackTitle = options.fallbackTitle ?? DEFAULT_FALLBACK_TITLE;
  const applyTitle = options.applyTitle ?? setWindowTitle;
  const onError = options.onError ?? (() => {});

  let activeLeaseCount = 0;
  let desiredTitle = fallbackTitle;
  let appliedTitle: string | null = null;
  let flushPromise: Promise<void> | null = null;

  const ensureFlush = () => {
    if (flushPromise) return;
    flushPromise = (async () => {
      let didError = false;
      try {
        while (appliedTitle !== desiredTitle) {
          const nextTitle = desiredTitle;
          try {
            await applyTitle(nextTitle);
            appliedTitle = nextTitle;
          } catch (error) {
            didError = true;
            onError(error);
            break;
          }
        }
      } finally {
        flushPromise = null;
        if (!didError && appliedTitle !== desiredTitle) {
          ensureFlush();
        }
      }
    })();
  };

  const syncDesiredTitle = () => {
    desiredTitle = activeLeaseCount > 0 ? activeTitle : fallbackTitle;
    ensureFlush();
  };

  return {
    acquire() {
      activeLeaseCount += 1;
      syncDesiredTitle();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeLeaseCount = Math.max(0, activeLeaseCount - 1);
        syncDesiredTitle();
      };
    },
    whenIdle() {
      return flushPromise ?? Promise.resolve();
    },
  };
}

const blankNativeWindowTitleLeaseManager = createNativeWindowTitleLeaseManager({
  onError: (error) => reportError(error, "titlebar.syncNativeWindowTitle"),
});

export function acquireBlankNativeWindowTitleLease(): () => void {
  return blankNativeWindowTitleLeaseManager.acquire();
}
