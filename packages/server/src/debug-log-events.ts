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

export interface DebugLogUploadRequest extends DebugLogBatch {}

export interface DebugLogUploadResponse {
  ok?: boolean;
  acceptedBatchIds: string[];
}

export interface DebugLogUploadRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

export function serializeDebugLogEvent(event: DebugLogEvent): string {
  return JSON.stringify(event);
}

export function parseDebugLogEvent(raw: string): DebugLogEvent {
  return JSON.parse(raw) as DebugLogEvent;
}

export interface DebugLogValidationIssue {
  path: string;
  message: string;
}

const VALID_LEVELS: ReadonlySet<string> = new Set(["info", "warn", "error"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalString(value: unknown, max = 1024): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.length <= max);
}

export function validateDebugLogEvent(value: unknown, path = "event"): DebugLogValidationIssue[] {
  const issues: DebugLogValidationIssue[] = [];
  if (!isPlainObject(value)) {
    issues.push({ path, message: "must be an object" });
    return issues;
  }
  const e = value;
  if (!isNonEmptyString(e.id, 128)) issues.push({ path: `${path}.id`, message: "must be non-empty string ≤ 128 chars" });
  if (typeof e.userId !== "string") issues.push({ path: `${path}.userId`, message: "must be string" });
  if (typeof e.orgId !== "string") issues.push({ path: `${path}.orgId`, message: "must be string" });
  if (typeof e.workspaceId !== "string") issues.push({ path: `${path}.workspaceId`, message: "must be string" });
  if (!isOptionalString(e.workerId)) issues.push({ path: `${path}.workerId`, message: "must be string|null|undefined" });
  if (!isOptionalString(e.sessionId)) issues.push({ path: `${path}.sessionId`, message: "must be string|null|undefined" });
  if (!isOptionalString(e.runId)) issues.push({ path: `${path}.runId`, message: "must be string|null|undefined" });
  if (!isNonEmptyString(e.source, 64)) issues.push({ path: `${path}.source`, message: "must be non-empty string ≤ 64 chars" });
  if (!isNonEmptyString(e.stream, 32)) issues.push({ path: `${path}.stream`, message: "must be non-empty string ≤ 32 chars" });
  if (e.level !== undefined && e.level !== null && (typeof e.level !== "string" || !VALID_LEVELS.has(e.level))) {
    issues.push({ path: `${path}.level`, message: "must be 'info' | 'warn' | 'error' | null | undefined" });
  }
  if (!isFiniteNumber(e.timestamp)) issues.push({ path: `${path}.timestamp`, message: "must be finite number" });
  if (typeof e.sequenceNo !== "number" || !Number.isInteger(e.sequenceNo) || e.sequenceNo < 0) {
    issues.push({ path: `${path}.sequenceNo`, message: "must be non-negative integer" });
  }
  if (!isPlainObject(e.payload)) issues.push({ path: `${path}.payload`, message: "must be plain object" });
  return issues;
}

export function validateDebugLogBatch(value: unknown): DebugLogValidationIssue[] {
  const issues: DebugLogValidationIssue[] = [];
  if (!isPlainObject(value)) {
    issues.push({ path: "batch", message: "must be an object" });
    return issues;
  }
  const b = value;
  if (!isNonEmptyString(b.batchId, 128)) {
    issues.push({ path: "batch.batchId", message: "must be non-empty string ≤ 128 chars" });
  }
  if (!Array.isArray(b.events)) {
    issues.push({ path: "batch.events", message: "must be array" });
    return issues;
  }
  if (b.events.length === 0) issues.push({ path: "batch.events", message: "must contain at least 1 event" });
  if (b.events.length > 1000) issues.push({ path: "batch.events", message: "must contain at most 1000 events" });
  b.events.forEach((event, index) => {
    issues.push(...validateDebugLogEvent(event, `batch.events[${index}]`));
  });
  return issues;
}
