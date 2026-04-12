import type {
  DebugLogBatch,
  DebugLogUploadRequest,
  DebugLogUploadResponse,
  DebugLogUploadRetryPolicy,
} from "./debug-log-events.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUploadResponse(value: unknown): DebugLogUploadResponse {
  if (!value || typeof value !== "object") {
    throw new Error("debug_log_upload_invalid_response");
  }

  const response = value as Partial<DebugLogUploadResponse>;
  if (!Array.isArray(response.acceptedBatchIds) || response.acceptedBatchIds.some((batchId) => typeof batchId !== "string")) {
    throw new Error("debug_log_upload_invalid_response");
  }

  return {
    ok: response.ok,
    acceptedBatchIds: response.acceptedBatchIds,
  };
}

function getRetryDelay(policy: DebugLogUploadRetryPolicy, attempt: number): number {
  const rawDelay = policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(rawDelay)));
}

export function createDebugLogUploader(input: {
  ingestUrl: string;
  ingestToken: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  retryPolicy?: Partial<DebugLogUploadRetryPolicy>;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? sleep;
  const retryPolicy: DebugLogUploadRetryPolicy = {
    maxAttempts: input.retryPolicy?.maxAttempts ?? 3,
    initialDelayMs: input.retryPolicy?.initialDelayMs ?? 250,
    maxDelayMs: input.retryPolicy?.maxDelayMs ?? 2_000,
    multiplier: input.retryPolicy?.multiplier ?? 2,
  };

  return {
    retryPolicy,
    async upload(batch: DebugLogBatch) {
      const request: DebugLogUploadRequest = batch;
      let lastError: unknown;

      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(input.ingestUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${input.ingestToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
          });

          if (!response.ok) {
            throw new Error(`debug_log_upload_failed:${response.status}`);
          }

          const parsed = parseUploadResponse(await response.json().catch(() => null));
          if (!parsed.acceptedBatchIds.includes(batch.batchId)) {
            throw new Error("debug_log_upload_unconfirmed");
          }

          return;
        } catch (error) {
          lastError = error;
          if (attempt >= retryPolicy.maxAttempts) break;
          await sleepImpl(getRetryDelay(retryPolicy, attempt));
        }
      }

      throw lastError instanceof Error ? lastError : new Error("debug_log_upload_failed");
    },
  };
}
