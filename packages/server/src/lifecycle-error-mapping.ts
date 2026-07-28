import { ApiError } from "./errors.js";
import { OrchestratorLifecycleRequestError } from "./orchestrator-lifecycle-client.js";

/**
 * One mapper for every owner that turns an orchestrator lifecycle failure into
 * an API error.
 *
 * The classification below is carried over unchanged from the copies this
 * replaces. It is deliberately not being refined here: `/runs/:runId` evidence
 * is still being classified separately, and adding or splitting a lifecycle
 * code before that evidence exists would invent a distinction nobody has
 * demonstrated.
 *
 * What this file does change is what leaves the process. The orchestrator
 * request path and the complete upstream body are internal topology; the
 * server's `formatError()` copies `details` straight into the client response,
 * and the server is not guaranteed to be loopback-only because a bridge host
 * can be bound with the same auth. Those fields therefore stay on the
 * diagnostic side, and the response carries only the upstream status.
 */

export type LifecycleRequestDiagnostic = {
  upstreamStatus: number;
  upstreamPath: string;
  upstreamBody: {
    kind: "array" | "object" | "primitive" | "string";
    fieldNames?: string[];
    length?: number;
  } | null;
};

function upstreamBodySummary(
  body: unknown,
): LifecycleRequestDiagnostic["upstreamBody"] {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return { kind: "string", length: body.length };
  if (Array.isArray(body)) return { kind: "array", length: body.length };
  if (typeof body !== "object") return { kind: "primitive" };
  return {
    kind: "object",
    fieldNames: Object.keys(body).sort().slice(0, 16),
  };
}

/**
 * Safe-by-default payload for the sanitized trace at each call site. Callers
 * own their own trace facility, so this returns the fields rather than
 * emitting them.
 */
export function lifecycleRequestDiagnostic(
  error: OrchestratorLifecycleRequestError,
): LifecycleRequestDiagnostic {
  return {
    upstreamStatus: error.status,
    upstreamPath: error.path,
    upstreamBody: upstreamBodySummary(error.body),
  };
}

export function lifecycleRequestApiError(
  error: OrchestratorLifecycleRequestError,
): ApiError {
  const status =
    error.status === 401 || error.status === 403
      ? 503
      : error.status === 404
        ? 404
        : error.status === 501
          ? 501
          : 503;
  const code =
    status === 404
      ? "lifecycle_not_found"
      : status === 501
        ? "lifecycle_unsupported"
        : "lifecycle_unavailable";
  return new ApiError(status, code, "Run lifecycle owner is unavailable", {
    upstreamStatus: error.status,
  });
}
