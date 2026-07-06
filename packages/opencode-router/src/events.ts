type RawEvent = {
  type?: string;
  properties?: unknown;
  payload?: { type?: string; properties?: unknown };
  syncEvent?: unknown;
};

export type NormalizedEvent = {
  type: string;
  properties?: any;
};

export function normalizeEvent(raw: RawEvent | null | undefined): NormalizedEvent | null {
  if (!raw) return null;
  if (raw.type === "sync") {
    if (!raw.syncEvent || typeof raw.syncEvent !== "object") return null;
    const syncEvent = raw.syncEvent as Record<string, unknown>;
    if (typeof syncEvent.type !== "string") return null;

    // OpenCode v2 wraps real events in sync envelopes with schema suffixes.
    return { type: stripTrailingNumericSchemaSuffix(syncEvent.type), properties: syncEvent.data };
  }
  if (typeof raw.type === "string") {
    return { type: raw.type, properties: raw.properties };
  }
  if (raw.payload && typeof raw.payload.type === "string") {
    return { type: raw.payload.type, properties: raw.payload.properties };
  }
  return null;
}

function stripTrailingNumericSchemaSuffix(type: string): string {
  return type.replace(/\.\d+$/, "");
}
