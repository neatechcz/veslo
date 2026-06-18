import assert from "node:assert/strict";
import test from "node:test";

import {
  createStartupRequestAudit,
  installStartupRequestAudit,
  normalizeStartupRequestAuditUrl,
  recordStartupRequestAudit,
  wrapStartupRequestAuditFetch,
} from "../../lib/startup-request-audit.js";

test("startup request audit groups distinct method and normalized url", () => {
  let now = 1_000;
  const audit = createStartupRequestAudit({ now: () => now, windowMs: 30_000 });

  assert.equal(audit.record("http://127.0.0.1:4096/session?id=abc&token=secret"), true);
  now += 20;
  assert.equal(audit.record("http://127.0.0.1:4096/session?token=changed&id=def"), true);
  now += 20;
  assert.equal(audit.record("http://127.0.0.1:4096/session?id=abc", { method: "POST" }), true);

  const summary = audit.summarize("test");
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.distinctCount, 2);
  assert.deepEqual(
    summary.requests.map((request) => [request.key, request.count]),
    [
      ["GET http://127.0.0.1:4096/session?id&token", 2],
      ["POST http://127.0.0.1:4096/session?id", 1],
    ],
  );
});

test("startup request audit ignores requests after the startup window", () => {
  let now = 0;
  const audit = createStartupRequestAudit({ now: () => now, windowMs: 30_000 });

  assert.equal(audit.record("http://127.0.0.1:4096/health"), true);
  now = 30_001;
  assert.equal(audit.record("http://127.0.0.1:4096/session"), false);

  const summary = audit.stop("test");
  assert.equal(summary.totalCount, 1);
  assert.equal(summary.distinctCount, 1);
});

test("startup request audit honors init method overrides for Request inputs", () => {
  const audit = createStartupRequestAudit();
  const request = new Request("http://127.0.0.1:4096/session", { method: "GET" });

  assert.equal(audit.record(request, { method: "DELETE" }), true);

  const summary = audit.summarize("test");
  assert.equal(summary.requests[0]?.key, "DELETE http://127.0.0.1:4096/session");
});

test("startup request audit skips Tauri http plugin and logging IPC noise", () => {
  const audit = createStartupRequestAudit();

  assert.equal(audit.record("http://ipc.localhost/plugin%3Ahttp%7Cfetch"), false);
  assert.equal(audit.record("http://ipc.localhost/plugin%3Ahttp%7Cfetch_read_body"), false);
  assert.equal(audit.record("http://ipc.localhost/log_ui_event"), false);
  assert.equal(audit.record("http://ipc.localhost/workspace_bootstrap", { method: "POST" }), true);

  const summary = audit.summarize("test");
  assert.equal(summary.totalCount, 1);
  assert.equal(summary.requests[0]?.key, "POST http://ipc.localhost/workspace_bootstrap");
});

test("startup request audit normalizes high-cardinality path segments and data urls", () => {
  assert.equal(
    normalizeStartupRequestAuditUrl("http://127.0.0.1:4096/session/ses_1234567890abcdef/status"),
    "http://127.0.0.1:4096/session/ses_:id/status",
  );
  assert.equal(
    normalizeStartupRequestAuditUrl("http://127.0.0.1:4096/workspaces/550e8400-e29b-41d4-a716-446655440000"),
    "http://127.0.0.1:4096/workspaces/:uuid",
  );
  assert.equal(normalizeStartupRequestAuditUrl("data:text/plain;base64,SGVsbG8="), "data:text/plain");
});

test("startup request audit keeps Tauri IPC command names readable", () => {
  assert.equal(
    normalizeStartupRequestAuditUrl("http://ipc.localhost/read_pending_session_drafts"),
    "http://ipc.localhost/read_pending_session_drafts",
  );
});

test("fetch wrapper records into the active startup audit without changing fetch result", async () => {
  let timeoutHandler: (() => void) | null = null;
  let now = 0;
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;

  const cleanup = installStartupRequestAudit({
    windowMs: 30_000,
    now: () => now,
    setTimeout: (handler) => {
      timeoutHandler = handler;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
    log: (event, payload) => logs.push({ event, payload }),
  });

  try {
    const fetchImpl = wrapStartupRequestAuditFetch(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
      "tauri.test",
    );
    now = 10;
    const response = await fetchImpl("http://127.0.0.1:4096/health?nonce=123");
    assert.equal(await response.text(), "ok");

    assert.ok(timeoutHandler);
    (timeoutHandler as () => void)();
    assert.equal(globalThis.fetch, originalFetch);

    const summary = logs.find((entry) => entry.event === "startup-summary")?.payload;
    assert.ok(summary);
    assert.equal(summary.totalCount, 1);
    assert.equal(summary.distinctCount, 1);
    assert.deepEqual(summary.requests, [
      {
        key: "GET http://127.0.0.1:4096/health?nonce",
        method: "GET",
        url: "http://127.0.0.1:4096/health?nonce",
        count: 1,
        firstAtMs: 10,
        lastAtMs: 10,
        sources: ["tauri.test"],
      },
    ]);
  } finally {
    cleanup();
  }
});

test("manual record uses the installed global startup audit", () => {
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const cleanup = installStartupRequestAudit({
    windowMs: 30_000,
    setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
    log: (event, payload) => logs.push({ event, payload }),
  });

  try {
    assert.equal(recordStartupRequestAudit({ method: "PATCH", url: "/api/workspaces?id=abc" }, undefined, "manual"), true);
    cleanup("manual");

    const summary = logs.find((entry) => entry.event === "startup-summary")?.payload;
    assert.equal(summary?.totalCount, 1);
    assert.equal(summary?.distinctCount, 1);
  } finally {
    cleanup();
  }
});
