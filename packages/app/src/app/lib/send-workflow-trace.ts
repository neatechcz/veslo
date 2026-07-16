import { logUiEvent } from "./tauri";

const SEND_WORKFLOW_TRACE_LIMIT = 2_000;
const SUPPORT_DIAGNOSTICS_STORAGE_KEY = "veslo.supportDiagnostics";

type SendWorkflowTraceRoot = typeof window & {
  __PILOT__?: unknown;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendWorkflowTrace?: Array<Record<string, unknown>>;
  __vesloSendWorkflowTraceSeq?: number;
  __vesloSendWorkflowTraceStartPerfMsById?: Record<string, number>;
  __vesloSendWorkflowTraceEnabled?: boolean | string | number | null;
  __vesloSendWorkflowTraceConsole?: boolean | string | number | null;
  __vesloDumpSendWorkflowTrace?: (traceId?: string | null) => Array<Record<string, unknown>>;
};

const truthy = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const falsey = (value: unknown): boolean => {
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
};

const perfNow = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const roundMs = (value: number) => Math.round(value * 100) / 100;

const envTraceEnabled = () => {
  try {
    return truthy(import.meta.env?.VITE_VESLO_SEND_WORKFLOW_TRACE);
  } catch {
    return false;
  }
};

const supportDiagnosticsOverride = (): boolean | null => {
  try {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage?.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return null;
  } catch {
    return null;
  }
};

const envDiagnosticsDisabled = () => {
  try {
    return falsey(import.meta.env?.VITE_VESLO_RUNTIME_DIAGNOSTICS);
  } catch {
    return false;
  }
};

const runtimeDiagnosticsDisabled = () => {
  const override = supportDiagnosticsOverride();
  return override === false || (override == null && envDiagnosticsDisabled());
};

const pilotTraceEnabled = (): boolean => {
  try {
    return typeof window !== "undefined" && Boolean((window as SendWorkflowTraceRoot).__PILOT__);
  } catch {
    return false;
  }
};

function sendWorkflowTraceEnabled(options?: { developerMode?: boolean }): boolean {
  if (runtimeDiagnosticsDisabled()) return false;
  if (
    options?.developerMode === false &&
    supportDiagnosticsOverride() !== true &&
    !pilotTraceEnabled()
  ) return false;
  if (typeof window === "undefined") return envTraceEnabled();
  try {
    const root = window as SendWorkflowTraceRoot;
    if (truthy(root.__vesloSendWorkflowTraceEnabled)) return true;
    if (Boolean(root.__PILOT__)) return true;
    if (truthy(window.localStorage?.getItem("veslo.sendWorkflowTrace"))) return true;
    return envTraceEnabled();
  } catch {
    return envTraceEnabled();
  }
}

export function recordSendWorkflowTrace(
  source: string,
  event: string,
  payload?: Record<string, unknown>,
  options?: { developerMode?: boolean },
) {
  if (!sendWorkflowTraceEnabled(options)) return;
  if (typeof window === "undefined") return;
  try {
    const root = window as SendWorkflowTraceRoot;
    const logs = root.__vesloSendWorkflowTrace ?? [];
    const id = (root.__vesloSendWorkflowTraceSeq ?? 0) + 1;
    root.__vesloSendWorkflowTraceSeq = id;
    const payloadTraceId =
      typeof payload?.traceId === "string"
        ? payload.traceId.trim()
        : typeof payload?.sendTraceId === "string"
          ? payload.sendTraceId.trim()
          : "";
    const traceId = payloadTraceId || root.__vesloActiveSendTraceId || undefined;
    const perfMs = roundMs(perfNow());
    const startPerfMsById =
      root.__vesloSendWorkflowTraceStartPerfMsById ??
      (root.__vesloSendWorkflowTraceStartPerfMsById = {});
    const relativeMs =
      traceId
        ? roundMs(perfMs - (startPerfMsById[traceId] ?? (startPerfMsById[traceId] = perfMs)))
        : undefined;
    const entry = {
      schema: "send-workflow/v1",
      id,
      at: new Date().toISOString(),
      ts: Date.now(),
      perfMs,
      ...(relativeMs !== undefined ? { relativeMs } : {}),
      source,
      event,
      ...(traceId ? { traceId } : {}),
      ...(payload ?? {}),
    };
    logs.push(entry);
    if (logs.length > SEND_WORKFLOW_TRACE_LIMIT) {
      logs.splice(0, logs.length - SEND_WORKFLOW_TRACE_LIMIT);
    }
    root.__vesloSendWorkflowTrace = logs;
    root.__vesloDumpSendWorkflowTrace = (traceIdFilter?: string | null) => {
      const normalized = traceIdFilter?.trim() ?? "";
      const current = root.__vesloSendWorkflowTrace ?? [];
      return normalized
        ? current.filter((item) => item.traceId === normalized)
        : [...current];
    };
    logUiEvent("send-workflow-trace", event, entry);
    if (truthy(root.__vesloSendWorkflowTraceConsole)) {
      console.log(`[SEND-WORKFLOW] ${source}:${event}`, entry);
    }
  } catch {
    // Diagnostics must never affect the send path.
  }
}

export function recordExternalSendWorkflowTraceEntries(entries: unknown) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const event = typeof record.event === "string" ? record.event.trim() : "";
    const source = typeof record.source === "string" ? record.source.trim() : "external";
    if (!event) continue;
    const { event: _event, source: _source, ...payload } = record;
    recordSendWorkflowTrace(source, event, payload);
  }
}
