import { describe, expect, test } from "bun:test";

import { createAiGatewayRuntimeOwner } from "../ai-gateway-runtime-owner.js";
import { ApiError } from "../errors.js";
import type { Actor } from "../types.js";

const actor: Actor = {
  type: "remote",
  tokenHash: "actor-token",
  scope: "collaborator",
};

const opencodeActor: Actor = {
  type: "remote",
  tokenHash: "opencode-server-client-token",
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
  runtimeAuthorizationActorTokenHash: null,
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

    const runtimeWithLegacyHeader = owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost", {
        headers: { "x-veslo-gateway-token": "legacy-token" },
      }),
      accessTokenHeader: "x-veslo-gateway-token",
    });
    expect(runtimeWithLegacyHeader).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
    });

    const redactedLegacy = owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost", {
        headers: { "x-veslo-gateway-token": "[REDACTED]" },
      }),
      accessTokenHeader: "x-veslo-gateway-token",
    });
    expect(redactedLegacy).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
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

    expect(() =>
      owner.resolveProviderAuthorization({
        actor,
        request: new Request("http://localhost", {
          headers: { "x-veslo-gateway-token": "[REDACTED]" },
        }),
        accessTokenHeader: "x-veslo-gateway-token",
      })
    ).toThrow(ApiError);
  });

  test("uses run-scoped managed runtime authorization for local OpenCode server-client requests", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer den-caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "runtime-token",
      },
    });

    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
      })
    ).toThrow(ApiError);

    const runtime = owner.resolveProviderAuthorization({
      actor: opencodeActor,
      request: new Request("http://localhost"),
      accessTokenHeader: "x-veslo-gateway-token",
      runtimeAuthorizationActorTokenHash: actor.tokenHash,
    });
    expect(runtime).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
    });

    const scopedRuntimeWithLegacyHeader = owner.resolveProviderAuthorization({
      actor: opencodeActor,
      request: new Request("http://localhost", {
        headers: { "x-veslo-gateway-token": "legacy-token" },
      }),
      accessTokenHeader: "x-veslo-gateway-token",
      runtimeAuthorizationActorTokenHash: actor.tokenHash,
      activeRunContextPresent: true,
    });
    expect(scopedRuntimeWithLegacyHeader).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
    });

    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost", {
          headers: { "x-veslo-gateway-token": "legacy-token" },
        }),
        accessTokenHeader: "x-veslo-gateway-token",
      })
    ).toThrow(ApiError);

    const redactedLegacy = owner.resolveProviderAuthorization({
      actor: opencodeActor,
      request: new Request("http://localhost", {
        headers: { "x-veslo-gateway-token": "Bearer [redacted]" },
      }),
      accessTokenHeader: "x-veslo-gateway-token",
      runtimeAuthorizationActorTokenHash: actor.tokenHash,
    });
    expect(redactedLegacy).toEqual({
      authorization: "Bearer runtime-token",
      source: "ai-access-token",
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer den-caller-token",
      value: { aiAccess: { enabled: false } },
    });

    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
        runtimeAuthorizationActorTokenHash: actor.tokenHash,
        activeRunContextPresent: true,
      })
    ).toThrow(ApiError);

    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost", {
          headers: { "x-veslo-gateway-token": "legacy-token" },
        }),
        accessTokenHeader: "x-veslo-gateway-token",
        runtimeAuthorizationActorTokenHash: actor.tokenHash,
        activeRunContextPresent: true,
      })
    ).toThrow(ApiError);
  });

  test("expires runtime authorization by age and accepts a fresh access prime", () => {
    let now = 1_000;
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const owner = createAiGatewayRuntimeOwner({
      now: () => now,
      runtimeAuthorizationMaxAgeMs: 1_000,
      recordTrace: (event, payload) => traces.push({ event, payload }),
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer den-caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "runtime-token-1",
      },
    });

    now = 1_500;
    expect(owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost"),
      accessTokenHeader: "x-veslo-gateway-token",
    })).toEqual({
      authorization: "Bearer runtime-token-1",
      source: "ai-access-token",
    });

    now = 2_001;
    expect(() =>
      owner.resolveProviderAuthorization({
        actor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
      })
    ).toThrow(ApiError);

    expect(traces).toEqual([
      {
        event: "server:ai-gateway-runtime-authorization:expired",
        payload: {
          ageMs: 1001,
          maxAgeMs: 1000,
          source: "ai-access-token",
          runtimeAuthorizationActorTokenHashPresent: false,
        },
      },
    ]);

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer den-caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "runtime-token-2",
      },
    });

    expect(owner.resolveProviderAuthorization({
      actor,
      request: new Request("http://localhost"),
      accessTokenHeader: "x-veslo-gateway-token",
    })).toEqual({
      authorization: "Bearer runtime-token-2",
      source: "ai-access-token",
    });
  });

  test("falls back to fresh actor runtime authorization when scoped run authorization expired", () => {
    let now = 1_000;
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const owner = createAiGatewayRuntimeOwner({
      now: () => now,
      runtimeAuthorizationMaxAgeMs: 1_000,
      recordTrace: (event, payload) => traces.push({ event, payload }),
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      callerAuthorization: "Bearer stale-den-caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "stale-scoped-runtime-token",
      },
    });

    now = 2_500;
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor: opencodeActor,
      callerAuthorization: "Bearer fresh-den-caller-token",
      value: {
        aiAccess: { enabled: true },
        accessToken: "fresh-actor-runtime-token",
      },
    });

    expect(owner.resolveProviderAuthorization({
      actor: opencodeActor,
      request: new Request("http://localhost"),
      accessTokenHeader: "x-veslo-gateway-token",
      runtimeAuthorizationActorTokenHash: actor.tokenHash,
      activeRunContextPresent: true,
    })).toEqual({
      authorization: "Bearer fresh-actor-runtime-token",
      source: "ai-access-token",
    });

    expect(traces).toEqual([
      {
        event: "server:ai-gateway-runtime-authorization:expired",
        payload: {
          ageMs: 1500,
          maxAgeMs: 1000,
          source: "ai-access-token",
          runtimeAuthorizationActorTokenHashPresent: true,
        },
      },
    ]);
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

  test("does not satisfy session-scoped provider start detection with another run's workspace hit", () => {
    const now = 1000;
    const owner = createAiGatewayRuntimeOwner({ now: () => now });
    owner.registerActiveRun({
      ...activeRun,
      runId: "run-a",
      opencodeSessionId: "session-a",
    });
    owner.registerActiveRun({
      ...activeRun,
      runId: "run-b",
      opencodeSessionId: "session-b",
    });

    owner.recordSessionHit({
      sessionId: "session-b",
      workspaceId: "workspace-1",
      requestId: "request-b",
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      at: now,
    });

    expect(owner.hasProviderHitAfter({
      sessionId: "session-a",
      workspaceId: "workspace-1",
      startedAt: now - 1,
    })).toBe(false);
    expect(owner.hasProviderHitAfter({
      sessionId: "session-b",
      workspaceId: "workspace-1",
      startedAt: now - 1,
    })).toBe(true);
    expect(owner.hasProviderHitAfter({
      sessionId: "",
      workspaceId: "workspace-1",
      startedAt: now - 1,
    })).toBe(true);
  });
});
