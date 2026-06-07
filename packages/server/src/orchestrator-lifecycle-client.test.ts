import { describe, expect, test } from "bun:test";

import {
  createOrchestratorLifecycleClient,
  ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER,
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
} from "./orchestrator-lifecycle-client.js";

const mockFetch = (
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => fn as unknown as typeof fetch;

describe("orchestrator lifecycle client", () => {
  test("register posts to the orchestrator with the lifecycle token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mockFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234/",
      token: "secret-token",
      fetchImpl,
    });

    await client.register({
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
      engineSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    });

    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/workspace/ws-a/runs/register");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)[ORCHESTRATOR_LIFECYCLE_TOKEN_HEADER]).toBe("secret-token");
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
      engineSessionId: "sess-a",
      directory: "/tmp/workspace-a",
      kind: "prompt",
    })).rejects.toThrow(RunAlreadyActiveError);
  });

  test("status returns null for 404", async () => {
    const fetchImpl = mockFetch(async () => new Response("{}", { status: 404 }));
    const client = createOrchestratorLifecycleClient({
      daemonUrl: "http://127.0.0.1:1234",
      token: "secret-token",
      fetchImpl,
    });

    await expect(client.status("ws-a", "conv-a", "latest")).resolves.toBeNull();
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
});
