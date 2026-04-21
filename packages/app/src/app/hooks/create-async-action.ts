import { createSignal } from "solid-js";

/**
 * Manages busy + error state for an async operation.
 * Prevents concurrent execution by default.
 */
export function createAsyncAction() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const execute = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy()) return undefined;
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, execute, setError, setBusy } as const;
}
