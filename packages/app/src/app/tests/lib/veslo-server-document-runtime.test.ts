import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentRuntimeStatusPayload } from "../../lib/document-runtime.js";
import { createVesloServerClient } from "../../lib/veslo-server.js";

const readyPayload: DocumentRuntimeStatusPayload = {
  runtimeId: "veslo-document-runtime",
  status: "ready",
  ready: true,
  updatedAt: "2026-07-02T12:00:00.000Z",
  source: "server",
  skills: [
    { id: "veslo-docx", format: "docx", ready: true, reason: "ready" },
    { id: "veslo-xlsx", format: "xlsx", ready: true, reason: "ready" },
    { id: "veslo-pdf", format: "pdf", ready: true, reason: "ready" },
    { id: "veslo-pptx", format: "pptx", ready: true, reason: "ready" },
  ],
  package: {
    installedVersion: "2026.7.0",
    activePackage: "veslo-document-runtime-macos-arm64-2026.7.0.veslopkg",
    updateAvailable: false,
    installing: false,
    rollback: false,
    remoteOnly: false,
    progress: null,
  },
  repair: {
    available: true,
    inProgress: false,
    blockedReason: null,
    lastAttemptAt: null,
    lastError: null,
  },
  policy: {
    windowsWslRuntime: "not_applicable",
  },
};

test("Veslo server client reads and repairs document runtime status endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return new Response(JSON.stringify(readyPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787/",
      token: "client-token",
    });

    assert.deepEqual(await client.getDocumentRuntimeStatus(), readyPayload);
    assert.deepEqual(await client.repairDocumentRuntime(), readyPayload);

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/document-runtime/status",
        method: "GET",
        authorization: "Bearer client-token",
      },
      {
        url: "http://127.0.0.1:8787/document-runtime/repair",
        method: "POST",
        authorization: "Bearer client-token",
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
