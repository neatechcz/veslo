import type { ConversationWorkspaceResolution } from "./conversation-service";
import type { SendRuntimePreflightContext } from "./send-runtime-readiness";
import type { SendTargetWorkspaceScope } from "./workspace-send-target";
import { perfNow } from "../lib/perf-log";
import type { EffectiveRuntimeSandboxState } from "../lib/runtime-sandbox-state";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { logUiEvent } from "../lib/tauri";
import type { VesloServerClient } from "../lib/veslo-server";

type AppSendTraceRoot = typeof window & {
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
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

const roundSendTraceMs = (value: number) => Math.round(value * 100) / 100;

const sendTraceErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const makeSendTraceId = () => {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `send_${suffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}`;
};

export function createAppSendTrace() {
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
      const logs = root.__vesloSendTrace ?? [];
      const seq = (root.__vesloSendTraceSeq ?? 0) + 1;
      root.__vesloSendTraceSeq = seq;
      const payloadTraceId = typeof payload?.traceId === "string" ? payload.traceId.trim() : "";
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
        ...(payload ?? {}),
      };
      logs.push(entry);
      if (logs.length > SEND_TRACE_LIMIT) logs.splice(0, logs.length - SEND_TRACE_LIMIT);
      root.__vesloSendTrace = logs;
      recordSendWorkflowTrace("app", event, payload);
      console.log(`[SENDTRACE] app:${event}`, entry);
      logUiEvent("send-trace", event, entry);
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
