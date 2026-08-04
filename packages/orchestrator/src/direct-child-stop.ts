import type { ChildProcess } from "node:child_process";

export type DirectChildStopResult =
  | { outcome: "exit_observed" }
  | { outcome: "exit_unconfirmed" };

export type DirectChildStopSchedule = {
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultSchedule: DirectChildStopSchedule = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function stopDirectChild(
  child: ChildProcess,
  timeoutMs = 2_500,
  schedule: DirectChildStopSchedule = defaultSchedule,
): Promise<DirectChildStopResult> {
  if (hasExited(child)) return Promise.resolve({ outcome: "exit_observed" });

  return new Promise((resolve) => {
    let timeout: unknown = null;
    let settled = false;

    const finish = (result: DirectChildStopResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) schedule.clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onExit = (): void => finish({ outcome: "exit_observed" });
    const observeOrWait = (onTimeout: () => void): void => {
      if (hasExited(child)) {
        finish({ outcome: "exit_observed" });
        return;
      }
      timeout = schedule.setTimeout(() => {
        timeout = null;
        if (hasExited(child)) {
          finish({ outcome: "exit_observed" });
          return;
        }
        onTimeout();
      }, timeoutMs);
    };

    child.once("exit", onExit);
    if (hasExited(child)) {
      finish({ outcome: "exit_observed" });
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      finish({ outcome: "exit_unconfirmed" });
      return;
    }

    observeOrWait(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish({ outcome: "exit_unconfirmed" });
        return;
      }
      observeOrWait(() => finish({ outcome: "exit_unconfirmed" }));
    });
  });
}
