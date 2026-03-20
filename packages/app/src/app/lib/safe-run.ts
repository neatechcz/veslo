/**
 * Safe execution utilities for error handling.
 *
 * Wraps operations with structured error handling that delegates
 * to reportError for consistent logging across dev and prod.
 */

import { reportError } from "./error-reporter";

/**
 * Run an async function, returning the result or a fallback on error.
 *
 * @example
 * const sessions = await safeAsync(() => loadSessions(), []);
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  label?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, `safeAsync:${label ?? "unknown"}`, "warning");
    return fallback;
  }
}

/**
 * Run a synchronous function, returning the result or a fallback on error.
 *
 * @example
 * const parsed = safeSync(() => JSON.parse(raw), null);
 */
export function safeSync<T>(
  fn: () => T,
  fallback: T,
  label?: string,
): T {
  try {
    return fn();
  } catch (error) {
    reportError(error, `safeSync:${label ?? "unknown"}`, "warning");
    return fallback;
  }
}

/**
 * Fire-and-forget an async operation. Logs errors via reportError.
 * Use for cleanup, best-effort writes, etc.
 *
 * @example
 * fireAndForget(() => saveDraft(content), "save draft");
 */
export function fireAndForget(
  fn: () => Promise<unknown>,
  label?: string,
): void {
  fn().catch((error) => {
    reportError(error, `fireAndForget:${label ?? "unknown"}`, "warning");
  });
}
