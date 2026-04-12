import { randomUUID } from "node:crypto";
import type {
  DebugLogBatch,
  DebugLogBatchLimits,
  DebugLogEvent,
  DebugLogUploadRetryPolicy,
} from "./debug-log-events.js";
import { createDebugLogSpool } from "./debug-log-spool.js";

export interface DebugLogPipelineInput {
  spoolDir: string;
  spoolMaxBytes: number;
  batchMaxEvents: number;
  batchMaxBytes: number;
  uploader?: {
    upload(batch: DebugLogBatch): Promise<void>;
    retryPolicy?: Pick<DebugLogUploadRetryPolicy, "initialDelayMs">;
  } | null;
}

export interface DebugLogPipeline {
  enqueue(events: DebugLogEvent[]): Promise<void>;
  flushOnce(): Promise<void>;
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeLevel(value: unknown): "info" | "warn" | "error" | null {
  if (value === "info" || value === "warn" || value === "error") return value;
  return null;
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

export function normalizeDebugLogEvent(input: unknown): DebugLogEvent {
  if (!isRecord(input)) {
    throw new Error("invalid_debug_log_event");
  }

  const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp) ? input.timestamp : Date.now();
  const sequenceNo = typeof input.sequenceNo === "number" && Number.isFinite(input.sequenceNo)
    ? Math.trunc(input.sequenceNo)
    : timestamp;

  return {
    id: normalizeString(input.id, randomUUID()),
    userId: normalizeString(input.userId, "unknown"),
    orgId: normalizeString(input.orgId, "unknown"),
    workspaceId: normalizeString(input.workspaceId, "unknown"),
    workerId: normalizeOptionalString(input.workerId),
    sessionId: normalizeOptionalString(input.sessionId),
    runId: normalizeOptionalString(input.runId),
    source: normalizeString(input.source, "unknown"),
    stream: normalizeString(input.stream, "event"),
    level: normalizeLevel(input.level),
    timestamp,
    sequenceNo,
    payload: normalizePayload(input.payload),
  };
}

export function normalizeDebugLogEvents(input: unknown): DebugLogEvent[] {
  if (!Array.isArray(input)) {
    throw new Error("invalid_debug_log_events");
  }
  return input.map((item) => normalizeDebugLogEvent(item));
}

export function createDebugLogPipeline(input: DebugLogPipelineInput): DebugLogPipeline {
  const spool = createDebugLogSpool({ dir: input.spoolDir, maxBytes: input.spoolMaxBytes });
  const uploader =
    input.uploader ??
    null;
  const limits: DebugLogBatchLimits = {
    maxEvents: input.batchMaxEvents,
    maxBytes: input.batchMaxBytes,
  };
  const retryDelayMs = Math.max(250, input.uploader?.retryPolicy?.initialDelayMs ?? 1_000);
  let flushInFlight: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearRetryTimer() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (!uploader || stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void startFlushLoop();
    }, retryDelayMs);
  }

  function startFlushLoop(): Promise<void> | null {
    if (!uploader || stopped) return null;
    if (!flushInFlight) {
      flushInFlight = flushLoop().finally(() => {
        flushInFlight = null;
      });
    }
    return flushInFlight;
  }

  async function flushLoop(): Promise<void> {
    if (!uploader || stopped) return;
    while (!stopped) {
      const batch = await spool.nextBatch(limits);
      if (!batch) return;
      try {
        await uploader.upload(batch);
        await spool.ackBatch(batch.batchId);
      } catch {
        scheduleRetry();
        return;
      }
    }
  }

  return {
    async enqueue(events) {
      if (events.length === 0 || stopped) return;
      await spool.append(events);
      clearRetryTimer();
      startFlushLoop();
    },
    async flushOnce() {
      if (stopped) return;
      clearRetryTimer();
      if (flushInFlight) {
        await flushInFlight;
        return;
      }
      await startFlushLoop();
    },
    stop() {
      stopped = true;
      clearRetryTimer();
    },
  };
}
