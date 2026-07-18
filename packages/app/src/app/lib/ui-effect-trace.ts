import { logUiEvent } from "./tauri";

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
  persist?: (payload: Record<string, unknown>) => void;
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
  const persist = options.persist ?? ((payload) => logUiEvent("send-workflow-trace", "ui-effect-trace:incident-window", payload));
  const entries: UiEffectTraceEntry[] = [];

  const record = (event: string, payload: Record<string, unknown> = {}) => {
    if (!options.enabled()) return;
    entries.push({ at: now(), event, payload });
    if (entries.length > TRACE_LIMIT) entries.splice(0, entries.length - TRACE_LIMIT);
  };

  const reportIncident = (kind: string, payload: Record<string, unknown> = {}) => {
    if (!options.enabled()) return;
    const incidentAt = now();
    record("ui-incident", { kind, ...payload });
    schedule(() => {
      const settledAt = now();
      const windowStart = incidentAt - INCIDENT_WINDOW_MS;
      const windowEntries = entries.filter((entry) => entry.at >= windowStart && entry.at <= settledAt);
      persist({
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

  return { record, reportIncident };
}

export const uiEffectTrace = createUiEffectTrace({ enabled: envUiEffectTraceEnabled });
