export type DebugLogLevel = "info" | "warn" | "error";

export interface DebugLogEvent {
  id: string;
  userId: string;
  orgId: string;
  workspaceId: string;
  workerId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  source: string;
  stream: string;
  level?: DebugLogLevel | null;
  timestamp: number;
  sequenceNo: number;
  payload: Record<string, unknown>;
}

export interface DebugLogBatch {
  batchId: string;
  events: DebugLogEvent[];
}

export interface DebugLogBatchLimits {
  maxEvents: number;
  maxBytes: number;
}

export function serializeDebugLogEvent(event: DebugLogEvent): string {
  return JSON.stringify(event);
}

export function parseDebugLogEvent(raw: string): DebugLogEvent {
  return JSON.parse(raw) as DebugLogEvent;
}
