import { describe, expect, test } from "bun:test";

import {
  createOrchestratorLifecycleClient,
  ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER,
  OrchestratorLifecycleRequestError,
  OrchestratorLifecycleTimeoutError,
  RunAlreadyActiveError,
} from "../orchestrator-lifecycle-client.js";

const mockFetch = (
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => fn as unknown as typeof fetch;

describe("orchestrator lifecycle client", () => {
  test("register posts to the orchestrator with the lifecycle token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mockFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, runId: "run-a", status: "submitted" }), { status: 200 });
    });
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234/",
      token: "secret-token",
      fetchImpl,
    });

    const result = await client.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
      opencodeSessionId: "sess-a",
      opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/workspace/ws-a/runs/register");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)[ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER]).toBe("secret-token");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.opencodeSessionId).toBe("sess-a");
    expect(body.opencodeMessageId).toBe("msg_f946e8a160003a693ab36fcd8e");
    expect(body.engineSessionId).toBeUndefined();
    expect(result).toMatchObject({ runId: "run-a", status: "submitted" });
  });

  test("register maps orchestrator 409 to RunAlreadyActiveError", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ activeRunId: "run-active" }), { status: 409 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-b",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    })).rejects.toThrow(RunAlreadyActiveError);
  });

  test("markAborted posts terminal abort state to the orchestrator", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mockFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await client.markAborted("ws-a", "run-a", "user abort reconciled");

    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/workspace/ws-a/runs/run-a/aborted");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ error: "user abort reconciled" });
  });

  test("register aborts stalled lifecycle requests with a local timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = mockFetch(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => {
          reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        });
      }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(client.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
      opencodeSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    })).rejects.toThrow(OrchestratorLifecycleTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  test("status returns null only for an exact missing run", async () => {
    const fetchImpl = mockFetch(async () => new Response(JSON.stringify({ error: "run not found" }), { status: 404 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "latest")).resolves.toBeNull();
  });

  test("status retains a workspace 404 as a recoverable lifecycle error", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ error: "workspace not found" }), { status: 404 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-a"))
      .rejects
      .toThrow(OrchestratorLifecycleRequestError);
  });

  test("active reads the orchestrator active run endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mockFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: true,
        runId: "run-active",
        status: "running",
        stale: false,
      }), { status: 200 });
    });
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.active("ws-a", "conv-a")).resolves.toEqual({
      runId: "run-active",
      status: "running",
      stale: false,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/workspace/ws-a/conversations/conv-a/runs/active");
  });

  test("status preserves no-progress model retry diagnostics", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({
        ok: true,
        runId: "run-a",
        status: "running",
        stale: false,
        activityKind: "model_retry",
        waitReason: "model_retry_no_output",
        lastUsefulProgressAt: 1_234,
        retrySince: 2_000,
        noProgressSeconds: 42,
      }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-a")).resolves.toEqual({
      runId: "run-a",
      status: "running",
      stale: false,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      lastUsefulProgressAt: 1_234,
      retrySince: 2_000,
      noProgressSeconds: 42,
    });
  });

  test("status preserves durable terminal error and correlation fields", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({
        ok: true,
        runId: "run-failed",
        status: "failed",
        stale: false,
        clientMessageId: "msg-failed",
        opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
        origin: "session:send",
        error: "upstream request failed",
      }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-failed")).resolves.toEqual({
      runId: "run-failed",
      status: "failed",
      stale: false,
      clientMessageId: "msg-failed",
      opencodeMessageId: "msg_f946e8a160003a693ab36fcd8e",
      origin: "session:send",
      error: "upstream request failed",
    });
  });

  test("status normalizes malformed optional durable errors to null", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({
        ok: true,
        runId: "run-a",
        status: "completed",
        stale: false,
        error: { detail: "not a displayable error" },
      }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-a")).resolves.toEqual({
      runId: "run-a",
      status: "completed",
      stale: false,
      error: null,
    });
  });

  test("status rejects malformed successful payloads", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "latest"))
      .rejects
      .toThrow(OrchestratorLifecycleRequestError);
  });

  test("status rejects an unknown lifecycle status instead of treating it as terminal", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ runId: "run-a", status: "unknown", stale: false }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-a"))
      .rejects
      .toThrow(OrchestratorLifecycleRequestError);
  });

  test("exact status rejects a response for another run", async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ runId: "run-other", status: "running", stale: false }), { status: 200 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "run-a"))
      .rejects
      .toThrow(OrchestratorLifecycleRequestError);
  });
});
