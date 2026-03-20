/**
 * Centralized error reporting utility.
 *
 * Replaces silent `.catch(() => undefined)` patterns with observable
 * error reporting. In dev, logs full error with context. In prod,
 * logs a structured warning.
 *
 * Always returns `undefined` so it can be used inline:
 *   somePromise.catch(e => reportError(e, "sidebar.refresh"))
 */

export type ErrorSeverity = "warning" | "error";

const isDev =
  typeof import.meta !== "undefined" && import.meta.env?.DEV;

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function reportError(
  error: unknown,
  context: string,
  severity: ErrorSeverity = "warning",
): undefined {
  if (isDev) {
    const method = severity === "error" ? console.error : console.warn;
    method(`[${context}]`, error);
  } else {
    console.warn(`[${context}]`, safeMessage(error));
  }
  return undefined;
}
