export type StartupGuard = {
  complete: () => boolean;
  dispose: () => void;
  timedOut: () => boolean;
};

export function createStartupGuard(input: {
  timeoutMs: number;
  onTimeout: () => void;
}): StartupGuard {
  const timeoutMs = Math.max(0, Number.isFinite(input.timeoutMs) ? input.timeoutMs : 0);

  let done = false;
  let didTimeout = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    didTimeout = true;
    input.onTimeout();
  }, timeoutMs);

  const complete = () => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    return true;
  };

  const dispose = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
  };

  return {
    complete,
    dispose,
    timedOut: () => didTimeout,
  };
}
