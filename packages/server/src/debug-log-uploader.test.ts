import { expect, test } from "bun:test";

import { createDebugLogUploader } from "./debug-log-uploader.js";

test("uploader posts idempotent batches with bearer auth", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];

  const uploader = createDebugLogUploader({
    ingestUrl: "https://den.example/v1/internal/debug-logs",
    ingestToken: "token-123",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ ok: true, acceptedBatchIds: ["batch-1"] }), { status: 200 });
    },
  });

  await uploader.upload({
    batchId: "batch-1",
    events: [
      { id: "evt-1", source: "engine", stream: "stdout", timestamp: 1, sequenceNo: 1, payload: { text: "hello" } },
    ],
  });

  expect(requests[0]?.url).toBe("https://den.example/v1/internal/debug-logs");
  expect(requests[0]?.headers.authorization).toBe("Bearer token-123");
  expect((requests[0]?.body as { batchId: string }).batchId).toBe("batch-1");
});
