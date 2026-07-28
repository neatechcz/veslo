import { recordSendWorkflowTrace } from "./send-workflow-trace";

const TRACE_LIMIT = 240;
const INCIDENT_WINDOW_MS = 5_000;

export type UiEffectTraceEntry = {
  at: number;
  event: string;
  payload: Record<string, unknown>;
};

type UiEffectTraceOptions = {
  enabled: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  persist?: (event: string, payload: Record<string, unknown>) => void;
};

const envUiEffectTraceEnabled = () => {
  try {
    if (!import.meta.env?.DEV) return false;
    const value = import.meta.env?.VITE_VESLO_UI_EFFECT_TRACE;
    return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  } catch {
    return false;
  }
};

export function createUiEffectTrace(options: UiEffectTraceOptions) {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const persist = options.persist ?? ((event, payload) =>
    recordSendWorkflowTrace("ui-effect-trace", event, payload, {
      force: true,
    }));
  const entries: UiEffectTraceEntry[] = [];
  const pendingIncidentKinds = new Set<string>();

  const record = (event: string, payload: Record<string, unknown> = {}) => {
    if (!options.enabled()) return;
    entries.push({ at: now(), event, payload });
    if (entries.length > TRACE_LIMIT) entries.splice(0, entries.length - TRACE_LIMIT);
  };

  const reportIncident = (kind: string, payload: Record<string, unknown> = {}) => {
    if (!options.enabled()) return;
    if (pendingIncidentKinds.has(kind)) return;
    pendingIncidentKinds.add(kind);
    const incidentAt = now();
    record("ui-incident", { kind, ...payload });
    schedule(() => {
      pendingIncidentKinds.delete(kind);
      const settledAt = now();
      const windowStart = incidentAt - INCIDENT_WINDOW_MS;
      const windowEntries = entries.filter((entry) => entry.at >= windowStart && entry.at <= settledAt);
      persist("ui-effect-trace:incident-window", {
        schema: "ui-effect-trace/v1",
        source: "ui-effect-trace",
        event: "ui-effect-trace:incident-window",
        kind,
        incidentAt,
        settledAt,
        windowMs: INCIDENT_WINDOW_MS,
        entries: windowEntries,
      });
    }, INCIDENT_WINDOW_MS);
  };

  const publishBenchmark = (kind: string, payload: Record<string, unknown> = {}) => {
    if (!options.enabled()) return;
    const at = now();
    persist("ui-effect-trace:benchmark", {
      schema: "ui-effect-trace/v1",
      source: "ui-effect-trace",
      event: "ui-effect-trace:benchmark",
      kind,
      at,
      payload,
    });
  };

  return { isEnabled: options.enabled, record, reportIncident, publishBenchmark };
}

export const uiEffectTrace = createUiEffectTrace({ enabled: envUiEffectTraceEnabled });
