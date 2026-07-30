import { createHash } from "node:crypto";

import {
  normalizeTranscriptIngestIdentity,
  transcriptIngestMutexKey,
  type TranscriptIngestIdentity,
  type TranscriptIngestRequest,
} from "./conversation-transcript-ingest.js";

export type CanonicalTranscriptSnapshot = {
  complete: boolean;
  conversationId?: string;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
};

export type TranscriptIngestOutcome =
  | { kind: "persisted"; generation: number }
  | { kind: "unchanged"; generation: number }
  | { kind: "incomplete"; generation: number }
  | { kind: "exhausted"; generation: number };

export type TranscriptIngestCoordinatorOptions = {
  readCanonicalTranscript: (identity: TranscriptIngestIdentity) => Promise<CanonicalTranscriptSnapshot>;
  persistCanonicalTranscript: (
    identity: TranscriptIngestIdentity,
    snapshot: CanonicalTranscriptSnapshot,
  ) => Promise<void>;
  invalidateTranscriptCaches: (identity: TranscriptIngestIdentity, snapshot: CanonicalTranscriptSnapshot) => void;
  retryDelaysMs?: readonly number[];
  readTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  trace?: (event: string, payload: {
    phase: string;
    attempt?: number;
    generation?: number;
    outcome?: string;
    delayMs?: number;
    durationMs?: number;
    trigger?: string;
    runId?: string;
  }) => void;
  now?: () => number;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
};

export const canonicalTranscriptWatermark = (snapshot: CanonicalTranscriptSnapshot): string =>
  createHash("sha256")
    .update(stableStringify({
      messages: snapshot.messages,
      partsByMessageId: snapshot.partsByMessageId,
    }))
    .digest("hex");

export function createTranscriptIngestCoordinator(options: TranscriptIngestCoordinatorOptions) {
  const retryDelaysMs = options.retryDelaysMs ?? [0, 2_000, 8_000];
  const readTimeoutMs = options.readTimeoutMs ?? 8_000;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;

  const readWithTimeout = async (identity: TranscriptIngestIdentity): Promise<CanonicalTranscriptSnapshot> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        options.readCanonicalTranscript(identity),
        new Promise<CanonicalTranscriptSnapshot>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("canonical transcript read timed out")), readTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  };

  type Task = {
    identity: TranscriptIngestIdentity;
    generation: number;
    promise: Promise<TranscriptIngestOutcome>;
  };

  const taskByKey = new Map<string, Task>();
  const watermarkByKey = new Map<string, string>();

  const request = (input: TranscriptIngestRequest): Promise<TranscriptIngestOutcome> => {
    const identity = normalizeTranscriptIngestIdentity({
      workspaceId: input.workspaceId,
      directory: input.directory,
      opencodeSessionId: input.opencodeSessionId,
    });
    if (!identity) {
      return Promise.reject(new Error("A workspace, directory, and OpenCode session are required for transcript ingest"));
    }
    const key = transcriptIngestMutexKey(identity);
    const trace = (event: string, payload: {
      phase: string;
      attempt?: number;
      generation?: number;
      outcome?: string;
      delayMs?: number;
      durationMs?: number;
    }) => options.trace?.(event, {
      ...payload,
      trigger: input.trigger,
      ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
    });
    const existing = taskByKey.get(key);
    if (existing) {
      existing.generation += 1;
      trace("transcript-ingest:flight", { phase: "join", generation: existing.generation });
      return existing.promise;
    }

    const task = { identity, generation: 1, promise: Promise.resolve({ kind: "incomplete", generation: 0 } as TranscriptIngestOutcome) };
    trace("transcript-ingest:flight", { phase: "new", generation: task.generation });
    task.promise = (async () => {
      let outcome: TranscriptIngestOutcome = { kind: "exhausted", generation: task.generation };
      do {
        const observedGeneration = task.generation;
        let cycleCompleted = false;
        for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
          if (attempt > 0) {
            const delayMs = retryDelaysMs[attempt] ?? 0;
            trace("transcript-ingest:retry-delay", { phase: "retry-delay", attempt: attempt + 1, delayMs });
            const delayStartedAt = now();
            await sleep(delayMs);
            trace("transcript-ingest:retry-delay", {
              phase: "retry-delay-settled",
              attempt: attempt + 1,
              delayMs,
              durationMs: Math.max(0, now() - delayStartedAt),
            });
          }
          let readStartedAt: number | null = null;
          try {
            readStartedAt = now();
            const snapshot = await readWithTimeout(task.identity);
            const readDurationMs = Math.max(0, now() - readStartedAt);
            if (!snapshot.complete) {
              trace("transcript-ingest:read", {
                phase: "incomplete",
                attempt: attempt + 1,
                durationMs: readDurationMs,
              });
              continue;
            }
            const watermark = canonicalTranscriptWatermark(snapshot);
            if (watermarkByKey.get(key) === watermark) {
              outcome = { kind: "unchanged", generation: observedGeneration };
              trace("transcript-ingest:cache", {
                phase: "unchanged",
                attempt: attempt + 1,
                durationMs: readDurationMs,
              });
            } else {
              const persistStartedAt = now();
              await options.persistCanonicalTranscript(task.identity, snapshot);
              watermarkByKey.set(key, watermark);
              options.invalidateTranscriptCaches(task.identity, snapshot);
              outcome = { kind: "persisted", generation: observedGeneration };
              trace("transcript-ingest:persistence", {
                phase: "persisted",
                attempt: attempt + 1,
                durationMs: Math.max(0, now() - persistStartedAt),
              });
            }
            cycleCompleted = true;
            break;
          } catch {
            trace("transcript-ingest:read", {
              phase: "error",
              attempt: attempt + 1,
              durationMs: readStartedAt === null ? undefined : Math.max(0, now() - readStartedAt),
            });
            // A canonical read is a bounded recovery concern. Never turn its
            // failure into a lifecycle or queue transition.
          }
        }
        if (!cycleCompleted) {
          outcome = { kind: "exhausted", generation: observedGeneration };
        }
      } while (task.generation > outcome.generation);
      trace("transcript-ingest:settle", { phase: "settle", generation: task.generation, outcome: outcome.kind });
      return { ...outcome, generation: task.generation };
    })().finally(() => {
      if (taskByKey.get(key) === task) taskByKey.delete(key);
    });
    taskByKey.set(key, task);
    return task.promise;
  };

  return { request };
}
