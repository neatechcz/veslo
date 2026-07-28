import type { ConversationWorkspaceResolution } from "./conversation-service";
import type { SendRuntimePreflightContext } from "./send-runtime-readiness";
import type { SendTargetWorkspaceScope } from "./workspace-send-target";
import { perfNow } from "../lib/perf-log";
import type { EffectiveRuntimeSandboxState } from "../lib/runtime-sandbox-state";
import {
  recordSendWorkflowTrace,
  sanitizeSendWorkflowTracePayload,
} from "../lib/send-workflow-trace";
import type { VesloServerClient } from "../lib/veslo-server";

type AppSendTraceRoot = typeof window & {
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
  __vesloSendFailureSnapshots?: Record<string, SendFailureSnapshot>;
};

export type AppSendPreflightContext = SendRuntimePreflightContext & {
  traceId: string;
  managedAiReady: boolean;
  runtimeHealthOk: boolean;
  enginePrepared: boolean;
  effectiveSandbox: EffectiveRuntimeSandboxState | null;
  targetWorkspace: SendTargetWorkspaceScope | null;
  conversationWorkspaceByDirectory: Map<string, Promise<ConversationWorkspaceResolution<VesloServerClient> | null>>;
};

const SEND_TRACE_LIMIT = 500;
const SEND_FAILURE_SNAPSHOT_LIMIT = 16;
/**
 * Snapshots survive a restart on purpose: a crash is exactly when the causal
 * trace matters. They must not survive indefinitely, though — a week-old
 * failure presented beside today's session is worse than no snapshot at all.
 */
const SEND_FAILURE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SEND_FAILURE_SNAPSHOT_STORAGE_KEY = "veslo.sendFailureSnapshots/v1";

type SendFailureSnapshotEvent = {
  at: string;
  traceId: string | null;
  event: string;
  phase: string | null;
  code: string | null;
  status: number | null;
  httpAttempted: boolean | null;
};

type SendFailureSnapshot = {
  workspaceId: string;
  firstFailure: SendFailureSnapshotEvent;
  finalFailure: SendFailureSnapshotEvent | null;
  updatedAt: string;
};

const roundSendTraceMs = (value: number) => Math.round(value * 100) / 100;

const sendTraceErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const boundedString = (value: unknown, limit = 160) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

const snapshotEventFromTrace = (
  entry: Record<string, unknown>,
): SendFailureSnapshotEvent => ({
  at: boundedString(entry.at, 64) || new Date().toISOString(),
  traceId: boundedString(entry.traceId, 128) || null,
  event: boundedString(entry.event) || "unknown",
  phase: boundedString(entry.phase, 80) || null,
  code: boundedString(entry.code, 120) || null,
  status: typeof entry.status === "number" ? entry.status : null,
  httpAttempted:
    typeof entry.httpAttempted === "boolean" ? entry.httpAttempted : null,
});

const isTerminalFailureTrace = (entry: Record<string, unknown>) => {
  const event = boundedString(entry.event).toLowerCase();
  if (
    /(?:preflight-error|server-response-error|outcome-unknown|submit-unavailable|result-validation|-(?:blocked|failed))$/.test(
      event,
    )
  )
    return true;
  return entry.status === "blocked" || entry.status === "failed";
};

const isFailureTrace = (entry: Record<string, unknown>) =>
  entry.outcome === "error" || isTerminalFailureTrace(entry);

/**
 * A send that reaches `submitted` supersedes whatever failed before it. Keeping
 * the old snapshot after that would leave a resolved error at the top of the
 * debug tail, where the next reader reasonably assumes it is current.
 */
const isTerminalSuccessTrace = (entry: Record<string, unknown>) => {
  if (entry.outcome === "error") return false;
  if (entry.status === "submitted") return true;
  const event = boundedString(entry.event).toLowerCase();
  return /(?::submitted|-submitted|:sent|:done)$/.test(event);
};

function readStoredFailureSnapshots(): Record<string, SendFailureSnapshot> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage?.getItem(SEND_FAILURE_SNAPSHOT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const snapshots: Record<string, SendFailureSnapshot> = {};
    for (const [workspaceKey, candidate] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        continue;
      const record = candidate as Record<string, unknown>;
      const workspaceId =
        boundedString(record.workspaceId, 128) ||
        boundedString(workspaceKey, 128);
      if (!workspaceId) continue;
      const firstCandidate = record.firstFailure;
      if (
        !firstCandidate ||
        typeof firstCandidate !== "object" ||
        Array.isArray(firstCandidate)
      )
        continue;
      const finalCandidate = record.finalFailure;
      snapshots[workspaceId] = {
        workspaceId,
        firstFailure: snapshotEventFromTrace(
          firstCandidate as Record<string, unknown>,
        ),
        finalFailure:
          finalCandidate &&
          typeof finalCandidate === "object" &&
          !Array.isArray(finalCandidate)
            ? snapshotEventFromTrace(finalCandidate as Record<string, unknown>)
            : null,
        updatedAt:
          boundedString(record.updatedAt, 64) ||
          snapshotEventFromTrace(firstCandidate as Record<string, unknown>).at,
      };
    }
    const freshEnough = Date.now() - SEND_FAILURE_SNAPSHOT_TTL_MS;
    return Object.fromEntries(
      Object.entries(snapshots)
        .filter(([, snapshot]) => {
          const updatedAt = Date.parse(snapshot.updatedAt);
          // An unparsable timestamp cannot be aged out, so drop it rather than
          // let it become permanent.
          return Number.isFinite(updatedAt) && updatedAt >= freshEnough;
        })
        .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, SEND_FAILURE_SNAPSHOT_LIMIT),
    );
  } catch {
    return {};
  }
}

function persistFailureSnapshots(snapshots: Record<string, SendFailureSnapshot>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(
      SEND_FAILURE_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshots),
    );
  } catch {
    // Diagnostics persistence must never affect sending.
  }
}

function failureSnapshotsFor(root: AppSendTraceRoot) {
  if (!root.__vesloSendFailureSnapshots) {
    root.__vesloSendFailureSnapshots = readStoredFailureSnapshots();
  }
  return root.__vesloSendFailureSnapshots;
}

function forgetFailureTrace(root: AppSendTraceRoot, workspaceId: string) {
  const snapshots = failureSnapshotsFor(root);
  if (!snapshots[workspaceId]) return;
  const { [workspaceId]: _cleared, ...rest } = snapshots;
  root.__vesloSendFailureSnapshots = rest;
  persistFailureSnapshots(rest);
}

function rememberFailureTrace(root: AppSendTraceRoot, entry: Record<string, unknown>) {
  const workspaceId = boundedString(entry.workspaceId, 128);
  if (workspaceId && isTerminalSuccessTrace(entry)) {
    forgetFailureTrace(root, workspaceId);
    return;
  }
  if (!isFailureTrace(entry)) return;
  if (!workspaceId) return;

  const snapshots = failureSnapshotsFor(root);
  const failure = snapshotEventFromTrace(entry);
  const current = snapshots[workspaceId];
  const next: SendFailureSnapshot = {
    workspaceId,
    firstFailure: current?.firstFailure ?? failure,
    finalFailure: isTerminalFailureTrace(entry)
      ? failure
      : (current?.finalFailure ?? null),
    updatedAt: failure.at,
  };
  const bounded = Object.fromEntries(
    [...Object.entries({ ...snapshots, [workspaceId]: next })]
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, SEND_FAILURE_SNAPSHOT_LIMIT),
  );
  root.__vesloSendFailureSnapshots = bounded;
  persistFailureSnapshots(bounded);
}

const makeSendTraceId = () => {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `send_${suffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}`;
};

export function createAppSendTrace() {
  if (typeof window !== "undefined") {
    failureSnapshotsFor(window as AppSendTraceRoot);
  }

  const createSendPreflightContext = (traceId?: string | null): AppSendPreflightContext => ({
    traceId: traceId?.trim() || makeSendTraceId(),
    managedAiReady: false,
    runtimeHealthOk: false,
    enginePrepared: false,
    effectiveSandbox: null,
    targetWorkspace: null,
    conversationWorkspaceByDirectory: new Map(),
  });

  const activeSendTraceId = () => {
    if (typeof window === "undefined") return null;
    return (window as AppSendTraceRoot).__vesloActiveSendTraceId ?? null;
  };

  function recordSendTrace(event: string, payload?: Record<string, unknown>) {
    if (typeof window === "undefined") return;
    try {
      const root = window as AppSendTraceRoot;
      const safePayload = sanitizeSendWorkflowTracePayload(payload) as Record<string, unknown> | undefined;
      const logs = root.__vesloSendTrace ?? [];
      const seq = (root.__vesloSendTraceSeq ?? 0) + 1;
      root.__vesloSendTraceSeq = seq;
      const payloadTraceId = typeof safePayload?.traceId === "string" ? safePayload.traceId.trim() : "";
      const traceId = payloadTraceId || root.__vesloActiveSendTraceId || undefined;
      const perfMs = roundSendTraceMs(perfNow());
      const startPerfMsById = root.__vesloSendTraceStartPerfMsById ?? (root.__vesloSendTraceStartPerfMsById = {});
      const relativeMs =
        traceId
          ? roundSendTraceMs(perfMs - (startPerfMsById[traceId] ?? (startPerfMsById[traceId] = perfMs)))
          : undefined;
      const entry = {
        id: seq,
        at: new Date().toISOString(),
        ts: Date.now(),
        perfMs,
        ...(relativeMs !== undefined ? { relativeMs } : {}),
        source: "app",
        ...(traceId ? { traceId } : {}),
        event,
        ...(safePayload ?? {}),
      };
      logs.push(entry);
      if (logs.length > SEND_TRACE_LIMIT) logs.splice(0, logs.length - SEND_TRACE_LIMIT);
      root.__vesloSendTrace = logs;
      rememberFailureTrace(root, entry);
      recordSendWorkflowTrace("app", event, safePayload);
    } catch {
      // Diagnostics must never affect the send path.
    }
  }

  const sendTraceStep = async <T,>(
    event: string,
    fn: () => Promise<T>,
    payload?: Record<string, unknown>,
  ): Promise<T> => {
    const startedAt = perfNow();
    recordSendTrace(`${event}:start`, payload);
    try {
      const result = await fn();
      recordSendTrace(`${event}:end`, {
        ...(payload ?? {}),
        durationMs: roundSendTraceMs(perfNow() - startedAt),
        outcome: "ok",
      });
      return result;
    } catch (error) {
      recordSendTrace(`${event}:error`, {
        ...(payload ?? {}),
        durationMs: roundSendTraceMs(perfNow() - startedAt),
        outcome: "error",
        message: sendTraceErrorMessage(error),
      });
      throw error;
    }
  };

  const recordExternalSendTraceEntries = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const event = typeof record.event === "string" ? record.event.trim() : "";
      if (!event) continue;
      const { event: _event, ...payload } = record;
      recordSendTrace(event, payload);
    }
  };

  return {
    activeSendTraceId,
    createSendPreflightContext,
    recordExternalSendTraceEntries,
    recordSendTrace,
    sendTraceStep,
  };
}
