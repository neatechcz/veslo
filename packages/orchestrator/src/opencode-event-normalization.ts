export type NormalizedOpencodeEvent = {
  type: string;
  properties?: unknown;
};

export function normalizeOpencodeEvent(raw: unknown): NormalizedOpencodeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (record.type === "sync") {
    const syncEvent = record.syncEvent;
    if (!syncEvent || typeof syncEvent !== "object") return null;
    const syncRecord = syncEvent as Record<string, unknown>;
    if (typeof syncRecord.type !== "string") return null;

    // OpenCode v2 wraps real events in sync envelopes with schema suffixes.
    return {
      type: stripTrailingNumericSchemaSuffix(syncRecord.type),
      properties: syncRecord.data,
    };
  }

  if (typeof record.type === "string") {
    return { type: record.type, properties: record.properties };
  }

  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.type === "string") {
    return { type: payload.type, properties: payload.properties };
  }

  return null;
}

function stripTrailingNumericSchemaSuffix(type: string): string {
  return type.replace(/\.\d+$/, "");
}
