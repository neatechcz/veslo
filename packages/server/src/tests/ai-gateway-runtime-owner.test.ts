import { describe, expect, test } from "bun:test";

import { createAiGatewayRuntimeOwner } from "../ai-gateway-runtime-owner.js";
import { ApiError } from "../errors.js";
import type { Actor } from "../types.js";

const actor: Actor = {
  type: "remote",
  tokenHash: "actor-token",
  scope: "collaborator",
};

const activeRun = {
  traceId: "trace-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  runId: "run-1",
  opencodeSessionId: "session-1",
  clientMessageId: "client-message-1",
  origin: "composer",
};

describe("createAiGatewayRuntimeOwner", () => {
  test("resolves the only active workspace run for unresolved OpenCode placeholders", () => {
    let now = 1000;
    const owner = createAiGatewayRuntimeOwner({ now: () => now });

    owner.registerActiveRun(activeRun);

    const resolution = owner.resolveSession({
      incomingSessionId: "${OPENCODE_SESSION_ID}",
      workspaceId: "workspace-1",
    });

    expect(resolution.source).toBe("workspace-active-run-context");
    expect(resolution.sessionId).toBe("session-1");
    expect(resolution.workspaceId).toBe("workspace-1");
    expect(resolution.activeRunContext?.runId).toBe("run-1");

    now += 1;
    owner.registerActiveRun({
      ...activeRun,
      traceId: "trace-2",
      workspaceId: "workspace-2",
      conversationId: "conversation-2",
      runId: "run-2",
      opencodeSessionId: "session-2",
    });

    const ambiguous = owner.resolveSession({
      incomingSessionId: "${OPENCODE_SESSION_ID}",
      workspaceId: "workspace-1",
    });

    expect(ambiguous.source).toBe("sessionless-fallback");
    expect(ambiguous.sessionId).toBe("");
    expect(ambiguous.workspaceFallbackSuppressedReason).toBe("ambiguous-active-run-context");
    expect(ambiguous.workspaceFallbackCandidateCount).toBe(1);
    expect(ambiguous.activeContextCount).toBe(2);
  });

  test("unregisters active run state from both session and workspace indexes", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.registerActiveRun(activeRun);

    expect(owner.resolveSession({ openCodeSessionId: "session-1" }).activeRunContext?.runId).toBe("run-1");

    owner.unregisterActiveRun(activeRun);

    const bySession = owner.resolveSession({ openCodeSessionId: "session-1" });
    expect(bySession.source).toBe("opencode-session-header");
    expect(bySession.sessionId).toBe("session-1");
    expect(bySession.activeRunContext).toBeNull();

    const byWorkspace = owner.resolveSession({
      incomingSessionId: "${OPENCODE_SESSION_ID}",
      workspaceId: "workspace-1",
    });
    expect(byWorkspace.source).toBe("sessionless-fallback");
    expect(byWorkspace.activeRunContext).toBeNull();
  });

  test("prefers current runtime access bundle token and clears it when AI access is disabled", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "runtime-token",
      },
    });

    const runtime = owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost"),
      accessTokenHeader: "x-veslo-gateway-token",
    });
    expect(runtime).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
    });

    const legacy = owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost", {
        headers: { "x-veslo-gateway-token": "legacy-token" },
      }),
      accessTokenHeader: "x-veslo-gateway-token",
    });
    expect(legacy).toEqual({
      authorization: "Bearer legacy-token",
      source: "legacy-header",
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer caller-token",
      value: { aiAccess: { enabled: false } },
    });

    expect(() =>
      owner.resolveProviderAuthorization({
        actor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
      })
    ).toThrow(ApiError);
  });

  test("aborts only matching active proxy requests and records trace metadata", () => {
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const owner = createAiGatewayRuntimeOwner({
      recordTrace: (event, payload) => traces.push({ event, payload }),
    });
    const matching = new AbortController();
    const unrelated = new AbortController();

    owner.registerActiveProxyRequest({
      requestId: "request-1",
      controller: matching,
      startedAt: 1,
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      traceId: "trace-1",
      conversationId: "conversation-1",
      runId: "run-1",
      opencodeSessionId: "session-1",
      clientMessageId: "client-message-1",
      origin: "composer",
    });
    owner.registerActiveProxyRequest({
      requestId: "request-2",
      controller: unrelated,
      startedAt: 1,
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      sessionId: "session-2",
      workspaceId: "workspace-1",
      traceId: "trace-2",
      conversationId: "conversation-2",
      runId: "run-2",
      opencodeSessionId: "session-2",
      clientMessageId: "client-message-2",
      origin: "composer",
    });

    const aborted = owner.abortActiveProxyRequests({
      workspaceId: "workspace-1",
      runId: "run-1",
      reason: "client-abort",
    });

    expect(aborted.map((entry) => entry.requestId)).toEqual(["request-1"]);
    expect(matching.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    expect(aborted[0]?.abortReason).toBe("client-abort");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.event).toBe("server:ai-gateway:proxy-abort-active");
    expect(traces[0]?.payload.requestIds).toEqual(["request-1"]);
  });

  test("expires old provider hits before provider start detection", () => {
    let now = 10_000;
    const owner = createAiGatewayRuntimeOwner({
      now: () => now,
      sessionHitTtlMs: 100,
    });

    owner.recordSessionHit({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      requestId: "request-old",
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      at: now - 101,
    });

    expect(owner.hasProviderHitAfter({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      startedAt: now - 200,
    })).toBe(false);

    owner.recordSessionHit({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      requestId: "request-new",
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      at: now,
    });

    expect(owner.hasProviderHitAfter({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      startedAt: now - 1,
    })).toBe(true);
  });
});
