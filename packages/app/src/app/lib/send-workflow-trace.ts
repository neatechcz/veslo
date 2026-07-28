import { logUiEvent } from "./tauri";

const SEND_WORKFLOW_TRACE_LIMIT = 2_000;
const NATIVE_TRACE_BATCH_MAX_ENTRIES = 24;
const NATIVE_TRACE_BATCH_DELAY_MS = 75;
const SUPPORT_DIAGNOSTICS_STORAGE_KEY = "veslo.supportDiagnostics";
const REDACTED_TRACE_VALUE = "[redacted]";
const TRACE_SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "baseurl",
  "configdir",
  "content",
  "dataurl",
  "directory",
  "enginedirectory",
  "manifestpath",
  "password",
  "path",
  "prompt",
  "resolvedtext",
  "rootdir",
  "secret",
  "basesessionkey",
  "currentsessionqueuekey",
  "pendingsessionbasekeybeforehandoff",
  "pendingsessionkeybeforehandoff",
  "rowkey",
  "sessionkey",
  "text",
  "token",
  "workspacepath",
  "workspaceroot",
  "workdir",
]);

type SendWorkflowTraceRoot = typeof window & {
  __PILOT__?: unknown;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendWorkflowTrace?: Array<Record<string, unknown>>;
  __vesloSendWorkflowTraceSeq?: number;
  __vesloSendWorkflowTraceStartPerfMsById?: Record<string, number>;
  __vesloSendWorkflowTraceEnabled?: boolean | string | number | null;
  __vesloSendWorkflowTraceConsole?: boolean | string | number | null;
  __vesloDumpSendWorkflowTrace?: (
    traceId?: string | null,
  ) => Array<Record<string, unknown>>;
};

type NativeTraceBatchEntry = {
  entry: Record<string, unknown>;
};

let pendingNativeTraceEntries: NativeTraceBatchEntry[] = [];
let nativeTraceFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushNativeTraceBatch() {
  if (nativeTraceFlushTimer !== null) {
    clearTimeout(nativeTraceFlushTimer);
    nativeTraceFlushTimer = null;
  }
  if (pendingNativeTraceEntries.length === 0) return;
  const entries = pendingNativeTraceEntries;
  pendingNativeTraceEntries = [];
  logUiEvent(
    "send-workflow-trace-batch",
    "batch",
    entries.map(({ entry }) => entry),
  );
}

function queueNativeTraceEntry(entry: Record<string, unknown>) {
  pendingNativeTraceEntries.push({ entry });
  if (pendingNativeTraceEntries.length >= NATIVE_TRACE_BATCH_MAX_ENTRIES) {
    flushNativeTraceBatch();
    return;
  }
  if (nativeTraceFlushTimer === null) {
    nativeTraceFlushTimer = setTimeout(flushNativeTraceBatch, NATIVE_TRACE_BATCH_DELAY_MS);
  }
}

/**
 * Batching is what keeps diagnostics from issuing one native IPC command per
 * renderer event, but it also means the newest entries are the ones still in
 * memory. A renderer that dies takes them with it — exactly the batch most
 * likely to contain the cause. Flush on the last events the platform still
 * delivers.
 *
 * `pagehide` covers renderer teardown; `visibilitychange` to hidden covers the
 * cases where the process is frozen or killed without a pagehide.
 */
let nativeTraceFlushHandlersInstalled = false;

function installNativeTraceFlushHandlers() {
  if (nativeTraceFlushHandlersInstalled) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  nativeTraceFlushHandlersInstalled = true;
  window.addEventListener("pagehide", flushNativeTraceBatch);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNativeTraceBatch();
  });
}

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

const sanitizeTraceString = (value: string) =>
  value
    .replace(
      // The scheme prefix must be consumed with the value. Without it,
      // `authorization: Bearer <secret>` redacts only `Bearer` and leaves the
      // secret itself in the log.
      /\b(bearer|authorization|token|api[_-]?key|password)\b\s*(?:=|:)?\s*(?:bearer\s+|basic\s+)?\S+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/\S+/gi, REDACTED_TRACE_VALUE)
    .replace(
      /(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"']+[\\/])+[^\s"']*/g,
      REDACTED_TRACE_VALUE,
    );

export function sanitizeSendWorkflowTracePayload(
  value: unknown,
  key?: string,
): unknown {
  if (key && TRACE_SENSITIVE_KEYS.has(key.toLowerCase()))
    return REDACTED_TRACE_VALUE;
  if (typeof value === "string") return sanitizeTraceString(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSendWorkflowTracePayload(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeSendWorkflowTracePayload(childValue, childKey),
    ]),
  );
}

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
    const stored = window.localStorage?.getItem(
      SUPPORT_DIAGNOSTICS_STORAGE_KEY,
    );
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
    return (
      typeof window !== "undefined" &&
      Boolean((window as SendWorkflowTraceRoot).__PILOT__)
    );
  } catch {
    return false;
  }
};

function sendWorkflowTraceEnabled(options?: {
  developerMode?: boolean;
  force?: boolean;
}): boolean {
  if (runtimeDiagnosticsDisabled()) return false;
  if (options?.force === true) return true;
  if (
    options?.developerMode === false &&
    supportDiagnosticsOverride() !== true &&
    !pilotTraceEnabled()
  )
    return false;
  if (typeof window === "undefined") return envTraceEnabled();
  try {
    const root = window as SendWorkflowTraceRoot;
    if (truthy(root.__vesloSendWorkflowTraceEnabled)) return true;
    if (Boolean(root.__PILOT__)) return true;
    if (truthy(window.localStorage?.getItem("veslo.sendWorkflowTrace")))
      return true;
    return envTraceEnabled();
  } catch {
    return envTraceEnabled();
  }
}

export function recordSendWorkflowTrace(
  source: string,
  event: string,
  payload?: Record<string, unknown>,
  options?: { developerMode?: boolean; force?: boolean },
) {
  if (!sendWorkflowTraceEnabled(options)) return;
  if (typeof window === "undefined") return;
  try {
    const safePayload = sanitizeSendWorkflowTracePayload(payload) as
      | Record<string, unknown>
      | undefined;
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
    const traceId =
      payloadTraceId || root.__vesloActiveSendTraceId || undefined;
    const perfMs = roundMs(perfNow());
    const startPerfMsById =
      root.__vesloSendWorkflowTraceStartPerfMsById ??
      (root.__vesloSendWorkflowTraceStartPerfMsById = {});
    const relativeMs = traceId
      ? roundMs(
          perfMs -
            (startPerfMsById[traceId] ?? (startPerfMsById[traceId] = perfMs)),
        )
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
      ...(safePayload ?? {}),
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
    // Diagnostics must never queue one native IPC command per renderer event.
    // Keep NDJSON entries intact, but send them to the desktop bridge in short batches.
    installNativeTraceFlushHandlers();
    queueNativeTraceEntry(entry);
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
    const source =
      typeof record.source === "string" ? record.source.trim() : "external";
    if (!event) continue;
    const { event: _event, source: _source, ...payload } = record;
    recordSendWorkflowTrace(source, event, payload);
  }
}
