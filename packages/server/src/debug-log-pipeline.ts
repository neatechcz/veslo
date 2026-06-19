import type { DebugLogConfig } from "./types.js";
import type { DebugLogEvent } from "./debug-log-events.js";
import { createDebugLogSpool } from "./debug-log-spool.js";
import { createDebugLogUploader } from "./debug-log-uploader.js";

export interface DebugLogPipeline {
  append(event: DebugLogEvent | DebugLogEvent[]): Promise<void>;
  flushNow(): Promise<void>;
  shutdown(): Promise<void>;
  isEnabled(): boolean;
}

interface PipelineLogger {
  log(level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>): void;
}

const SPOOL_RETENTION_HIGH_RATIO = 0.9;
const SPOOL_RETENTION_LOW_RATIO = 0.7;

export function createDebugLogPipeline(input: {
  config: DebugLogConfig;
  spoolDir: string;
  logger?: PipelineLogger;
  fetchImpl?: typeof fetch;
}): DebugLogPipeline {
  const { config, spoolDir, logger, fetchImpl } = input;

  const spool = createDebugLogSpool({ dir: spoolDir, maxBytes: config.spoolMaxBytes });
  const uploader = config.enabled && config.ingestUrl && config.ingestToken
    ? createDebugLogUploader({
        ingestUrl: config.ingestUrl,
        ingestToken: config.ingestToken,
        fetchImpl,
      })
    : null;

  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let flushInFlight: Promise<void> | null = null;
  let retentionInFlight: Promise<void> | null = null;
  let stopped = false;

  async function enforceRetention(): Promise<void> {
    if (retentionInFlight) {
      await retentionInFlight;
      return;
    }
    retentionInFlight = (async () => {
      const high = config.spoolMaxBytes * SPOOL_RETENTION_HIGH_RATIO;
      const low = config.spoolMaxBytes * SPOOL_RETENTION_LOW_RATIO;
      let bytes = await spool.currentBytes();
      if (bytes < high) return;
      const result = await spool.dropOldestUntilBelow(low);
      const droppedTotal = result.dropped;
      bytes = result.bytes;
      if (droppedTotal > 0 && logger) {
        logger.log("warn", "debug log spool retention dropped events", {
          droppedCount: droppedTotal,
          spoolBytes: bytes,
        });
      }
    })();
    try {
      await retentionInFlight;
    } finally {
      retentionInFlight = null;
    }
  }

  async function appendInternal(events: DebugLogEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await spool.append(events);
      void enforceRetention().catch((error) => {
        if (logger) {
          logger.log("error", "debug log pipeline retention error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async function flushOnce(): Promise<void> {
    if (!uploader) return;
    while (!stopped) {
      const batch = await spool.nextBatch({
        maxEvents: config.batchMaxEvents,
        maxBytes: config.batchMaxBytes,
      });
      if (!batch) return;
      try {
        await uploader.upload(batch);
        await spool.ackBatch(batch.batchId);
      } catch (error) {
        if (logger) {
          logger.log("warn", "debug log upload failed", {
            batchId: batch.batchId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Leave batch leased; next tick (after lease TTL) will retry.
        return;
      }
    }
  }

  async function flushNow(): Promise<void> {
    if (flushInFlight) {
      await flushInFlight;
      return;
    }
    flushInFlight = flushOnce().catch((error) => {
      if (logger) {
        logger.log("error", "debug log pipeline flush error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    try {
      await flushInFlight;
    } finally {
      flushInFlight = null;
    }
  }

  function triggerRetention(): void {
    void enforceRetention().catch((error) => {
      if (logger) {
        logger.log("error", "debug log pipeline retention error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function startMaintenanceLoop(): void {
    if (flushTimer || stopped) return;
    flushTimer = setInterval(() => {
      triggerRetention();
      if (uploader) {
        void flushNow();
      }
    }, config.flushIntervalMs);
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as { unref?: () => void }).unref?.();
    }
    triggerRetention();
  }

  startMaintenanceLoop();

  return {
    async append(eventOrEvents) {
      // Drop events silently when no uploader is configured (typical dev mode
      // without VESLO_DEBUG_LOG_INGEST_URL/_TOKEN). Otherwise the spool grows
      // indefinitely — Tauri's debug-logs-forwarder posts events every 5s,
      // the server writes one file per event, and nothing ever drains them.
      // Saw 138 000 spool files and veslo-server pinned at 550 % CPU in
      // local dev because of this.
      if (!uploader) return;
      const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
      await appendInternal(events);
    },
    flushNow,
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (flushInFlight) {
        await flushInFlight.catch(() => undefined);
      }
      if (retentionInFlight) {
        await retentionInFlight.catch(() => undefined);
      }
      // Final best-effort flush.
      if (uploader) {
        await flushOnce().catch((error) => {
          if (logger) {
            logger.log("warn", "debug log pipeline shutdown flush error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    },
    isEnabled() {
      return Boolean(uploader);
    },
  };
}
