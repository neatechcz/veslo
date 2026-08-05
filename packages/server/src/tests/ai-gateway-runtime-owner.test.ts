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
  runtimeAuthorizationOrgId: null,
};

describe("createAiGatewayRuntimeOwner", () => {
  test("caches managed model descriptors briefly and invalidates them when authorization changes", () => {
    let now = 1000;
    const owner = createAiGatewayRuntimeOwner({ now: () => now });
    owner.cacheManagedAiModelCapabilityDescriptor({
      cacheKey: "workspace:actor:org:codex_oauth:gpt-5.6-sol",
      descriptor: {
        providerID: "codex_oauth",
        modelID: "gpt-5.6-sol",
        attachment: true,
        modalities: { input: ["text", "image"] },
      },
      ttlMs: 30_000,
    });

    expect(owner.getManagedAiModelCapabilityDescriptor("workspace:actor:org:codex_oauth:gpt-5.6-sol"))
      .toEqual({
        providerID: "codex_oauth",
        modelID: "gpt-5.6-sol",
        attachment: true,
        modalities: { input: ["text", "image"] },
      });
    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer refreshed-access",
      workspaceId: "workspace",
      source: "ai-access-token",
    });
    expect(owner.getManagedAiModelCapabilityDescriptor("workspace:actor:org:codex_oauth:gpt-5.6-sol"))
      .toBeNull();

    owner.cacheManagedAiModelCapabilityDescriptor({
      cacheKey: "expired",
      descriptor: { providerID: "codex_oauth", modelID: "gpt-5.6-sol" },
      ttlMs: 1,
    });
    now += 2;
    expect(owner.getManagedAiModelCapabilityDescriptor("expired")).toBeNull();
  });

  test("bounds descriptor cache lifetime by the remaining runtime authorization", () => {
    let now = 1_000;
    const owner = createAiGatewayRuntimeOwner({
      now: () => now,
      runtimeAuthorizationMaxAgeMs: 1_000,
    });
    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer access",
      source: "ai-access-token",
    });

    now = 1_750;
    expect(owner.runtimeAuthorizationRemainingMs({ actorTokenHash: actor.tokenHash })).toBe(250);
    owner.cacheManagedAiModelCapabilityDescriptor({
      cacheKey: "bounded",
      descriptor: { providerID: "codex_oauth", modelID: "gpt-5.6-sol" },
      ttlMs: 250,
    });

    now = 2_001;
    expect(owner.runtimeAuthorizationRemainingMs({ actorTokenHash: actor.tokenHash })).toBeNull();
    expect(owner.getManagedAiModelCapabilityDescriptor("bounded")).toBeNull();
  });

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

  test("does not cross-correlate a malformed duplicate OpenCode session id across workspaces", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.registerActiveRun({
      ...activeRun,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      runId: "run-a",
      opencodeSessionId: "duplicate-upstream-session",
    });
    owner.registerActiveRun({
      ...activeRun,
      workspaceId: "workspace-b",
      conversationId: "conversation-b",
      runId: "run-b",
      opencodeSessionId: "duplicate-upstream-session",
    });

    expect(owner.resolveSession({
      incomingSessionId: "duplicate-upstream-session",
      workspaceId: "workspace-a",
    }).activeRunContext?.runId).toBe("run-a");
    expect(owner.resolveSession({
      incomingSessionId: "duplicate-upstream-session",
      workspaceId: "workspace-b",
    }).activeRunContext?.runId).toBe("run-b");
    expect(owner.resolveSession({
      incomingSessionId: "duplicate-upstream-session",
      workspaceId: "workspace-unrelated",
    }).activeRunContext).toBeNull();
    expect(owner.resolveSession({
      incomingSessionId: "duplicate-upstream-session",
    }).activeRunContext).toBeNull();
  });

  test("prefers current runtime access bundle token and clears it when AI access is disabled", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org_123",
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
      orgId: "org_123",
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
      orgId: "org_123",
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
      orgId: "org_123",
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
      runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
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
      runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
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
      runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
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
        runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
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
        runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
        activeRunContextPresent: true,
      })
    ).toThrow(ApiError);
  });

  test("keeps concurrent organization authorizations isolated by server-owned workspace run binding", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org-a",
      workspaceId: "workspace-a",
      callerAuthorization: "Bearer caller-a",
      value: { aiAccess: { enabled: true }, accessToken: "runtime-a" },
    });
    const bindingA = owner.resolveRuntimeAuthorizationBindingForRun({
      actor,
      workspaceId: "workspace-a",
    });
    owner.registerActiveRun({
      ...activeRun,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      runId: "run-a",
      opencodeSessionId: "session-a",
      runtimeAuthorizationActorTokenHash: bindingA.actorTokenHash,
      runtimeAuthorizationOrgId: bindingA.orgId,
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org-b",
      workspaceId: "workspace-b",
      callerAuthorization: "Bearer caller-b",
      value: { aiAccess: { enabled: true }, accessToken: "runtime-b" },
    });
    const bindingB = owner.resolveRuntimeAuthorizationBindingForRun({
      actor,
      workspaceId: "workspace-b",
    });
    owner.registerActiveRun({
      ...activeRun,
      workspaceId: "workspace-b",
      conversationId: "conversation-b",
      runId: "run-b",
      opencodeSessionId: "session-b",
      runtimeAuthorizationActorTokenHash: bindingB.actorTokenHash,
      runtimeAuthorizationOrgId: bindingB.orgId,
    });

    const resolve = (sessionId: string, forgedOrgId: string, forgedWorkspaceId: string) => {
      const context = owner.resolveSession({
        incomingSessionId: sessionId,
        workspaceId: forgedWorkspaceId,
      }).activeRunContext;
      expect(context).not.toBeNull();
      return owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost", {
          headers: {
            "x-veslo-org-id": forgedOrgId,
            "x-veslo-workspace-id": forgedWorkspaceId,
          },
        }),
        accessTokenHeader: "x-veslo-gateway-token",
        runtimeAuthorizationActorTokenHash: context?.runtimeAuthorizationActorTokenHash,
        runtimeAuthorizationOrgId: context?.runtimeAuthorizationOrgId,
        activeRunContextPresent: true,
      });
    };

    expect(resolve("session-a", "org-b", "workspace-b")).toEqual({
      authorization: "Bearer runtime-a",
      source: "ai-access-token",
      orgId: "org-a",
    });
    expect(resolve("session-b", "org-a", "workspace-a")).toEqual({
      authorization: "Bearer runtime-b",
      source: "ai-access-token",
      orgId: "org-b",
    });

    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org-b",
      workspaceId: "workspace-b",
      callerAuthorization: "Bearer caller-b-2",
      value: { aiAccess: { enabled: true }, accessToken: "runtime-b-2" },
    });

    expect(resolve("session-a", "org-b", "workspace-b").authorization).toBe("Bearer runtime-a");
    expect(resolve("session-b", "org-a", "workspace-a").authorization).toBe("Bearer runtime-b-2");
  });

  test("denied organization binding cannot inherit another allowed organization", () => {
    const owner = createAiGatewayRuntimeOwner();
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org-b",
      workspaceId: "workspace-b",
      callerAuthorization: "Bearer caller-b",
      value: { aiAccess: { enabled: true }, accessToken: "runtime-b" },
    });
    owner.syncRuntimeAuthorizationFromAccessBundle({
      actor,
      orgId: "org-a",
      workspaceId: "workspace-a",
      callerAuthorization: "Bearer caller-a",
      value: { aiAccess: { enabled: false } },
    });

    const deniedBinding = owner.resolveRuntimeAuthorizationBindingForRun({
      actor,
      workspaceId: "workspace-a",
    });
    expect(deniedBinding).toEqual({ actorTokenHash: "actor-token", orgId: "org-a" });
    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
        runtimeAuthorizationActorTokenHash: deniedBinding.actorTokenHash,
        runtimeAuthorizationOrgId: deniedBinding.orgId,
        activeRunContextPresent: true,
      })
    ).toThrow(ApiError);
  });

  test("fails closed when a multi-organization actor has no server-owned workspace binding", () => {
    const owner = createAiGatewayRuntimeOwner();
    for (const orgId of ["org-a", "org-b"]) {
      owner.syncRuntimeAuthorizationFromAccessBundle({
        actor,
        orgId,
        callerAuthorization: `Bearer caller-${orgId}`,
        value: { aiAccess: { enabled: true }, accessToken: `runtime-${orgId}` },
      });
    }

    expect(() =>
      owner.resolveRuntimeAuthorizationBindingForRun({ actor, workspaceId: "workspace-unbound" })
    ).toThrow(ApiError);
  });

  test("clearing an actor removes every organization and workspace-scoped authorization", () => {
    const owner = createAiGatewayRuntimeOwner();
    for (const [orgId, workspaceId] of [["org-a", "workspace-a"], ["org-b", "workspace-b"]]) {
      owner.syncRuntimeAuthorizationFromAccessBundle({
        actor,
        orgId,
        workspaceId,
        callerAuthorization: `Bearer caller-${orgId}`,
        value: { aiAccess: { enabled: true }, accessToken: `runtime-${orgId}` },
      });
    }

    owner.clearRuntimeAuthorization(actor);

    for (const workspaceId of ["workspace-a", "workspace-b"]) {
      const binding = owner.resolveRuntimeAuthorizationBindingForRun({ actor, workspaceId });
      expect(() =>
        owner.resolveProviderAuthorization({
          actor: opencodeActor,
          request: new Request("http://localhost"),
          accessTokenHeader: "x-veslo-gateway-token",
          runtimeAuthorizationActorTokenHash: binding.actorTokenHash,
          runtimeAuthorizationOrgId: binding.orgId,
          activeRunContextPresent: true,
        })
      ).toThrow(ApiError);
    }
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

  test("does not let an expired scoped run fall back to another actor authorization", () => {
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

    expect(() =>
      owner.resolveProviderAuthorization({
        actor: opencodeActor,
        request: new Request("http://localhost"),
        accessTokenHeader: "x-veslo-gateway-token",
        runtimeAuthorizationActorTokenHash: actor.tokenHash ?? null,
        activeRunContextPresent: true,
      })
    ).toThrow(ApiError);

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

  test("waits only for the exact recovered authorization binding", async () => {
    let now = 1_000;
    let owner: ReturnType<typeof createAiGatewayRuntimeOwner>;
    owner = createAiGatewayRuntimeOwner({
      now: () => now,
      sleep: async () => {
        now += 10;
        owner.registerRuntimeAuthorization({
          actor,
          authorization: "Bearer recovered-proof",
          orgId: "org-a",
          source: "ai-access-token",
        });
      },
    });

    expect(await owner.waitForRuntimeAuthorization({
      actorTokenHash: actor.tokenHash,
      orgId: "org-a",
      timeoutMs: 100,
    })).toBe(true);
    expect(await owner.waitForRuntimeAuthorization({
      actorTokenHash: "other-actor",
      orgId: "org-a",
      timeoutMs: 0,
    })).toBe(false);
  });

  test("releases only the recovered run whose exact workspace authorization was primed", async () => {
    const owner = createAiGatewayRuntimeOwner();
    const recovered = {
      traceId: null,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      runId: "run-1",
      opencodeSessionId: "session-1",
      clientMessageId: null,
      origin: null,
      runtimeAuthorizationActorTokenHash: actor.tokenHash!,
      runtimeAuthorizationOrgId: "org-a",
      recoveryAuthorizationPending: true,
    };
    owner.registerActiveRun(recovered);
    const context = owner.resolveSession({ incomingSessionId: "session-1" }).activeRunContext;
    expect(context).not.toBeNull();
    expect(owner.isRecoveryAuthorizationPending(context!)).toBe(true);

    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer recovered-proof",
      orgId: "org-a",
      workspaceId: "workspace-2",
      source: "ai-access-token",
    });
    expect(owner.isRecoveryAuthorizationPending(context!)).toBe(true);
    expect(await owner.waitForRuntimeAuthorization({
      actorTokenHash: actor.tokenHash,
      orgId: "org-a",
      recoveryContext: context,
      timeoutMs: 0,
    })).toBe(false);

    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer recovered-proof",
      orgId: "org-a",
      workspaceId: "workspace-1",
      source: "ai-access-token",
    });
    expect(owner.isRecoveryAuthorizationPending(context!)).toBe(false);
    expect(await owner.waitForRuntimeAuthorization({
      actorTokenHash: actor.tokenHash,
      orgId: "org-a",
      recoveryContext: context,
      timeoutMs: 0,
    })).toBe(true);
  });

  test("keeps concurrent recovered contexts pending until each exact workspace and organization prime arrives", async () => {
    const owner = createAiGatewayRuntimeOwner();
    const recoveredA = {
      traceId: null,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      runId: "run-a",
      opencodeSessionId: "session-a",
      clientMessageId: null,
      origin: null,
      runtimeAuthorizationActorTokenHash: actor.tokenHash!,
      runtimeAuthorizationOrgId: "org-a",
      recoveryAuthorizationPending: true,
    };
    const recoveredB = {
      ...recoveredA,
      workspaceId: "workspace-b",
      conversationId: "conversation-b",
      runId: "run-b",
      opencodeSessionId: "session-b",
      runtimeAuthorizationOrgId: "org-b",
    };
    owner.registerActiveRun(recoveredA);
    owner.registerActiveRun(recoveredB);
    const contextA = owner.resolveSession({ incomingSessionId: "session-a" }).activeRunContext;
    const contextB = owner.resolveSession({ incomingSessionId: "session-b" }).activeRunContext;
    expect(contextA).not.toBeNull();
    expect(contextB).not.toBeNull();

    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer recovered-a",
      orgId: "org-a",
      workspaceId: "workspace-a",
      source: "ai-access-token",
    });
    expect(owner.isRecoveryAuthorizationPending(contextA!)).toBe(false);
    expect(owner.isRecoveryAuthorizationPending(contextB!)).toBe(true);
    expect(await owner.waitForRuntimeAuthorization({
      actorTokenHash: actor.tokenHash,
      orgId: "org-b",
      recoveryContext: contextB,
      timeoutMs: 0,
    })).toBe(false);

    owner.registerRuntimeAuthorization({
      actor,
      authorization: "Bearer recovered-b",
      orgId: "org-b",
      workspaceId: "workspace-b",
      source: "ai-access-token",
    });
    expect(owner.isRecoveryAuthorizationPending(contextB!)).toBe(false);
  });

  test("provider-start observation distinguishes no gateway request from a session-correlated hit", async () => {
    let now = 1_000;
    const owner = createAiGatewayRuntimeOwner({
      now: () => now,
      providerStartTimeoutMs: () => 10,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });

    const missing = await owner.waitForProviderStart({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      runId: "run-1",
      opencodeSessionId: "session-1",
      startedAt: now,
    });
    expect(missing).toEqual({
      started: false,
      timeoutMs: 10,
      providerHitScope: "none",
      providerHitCount: 0,
      firstProviderHitAt: null,
      lastProviderHitAt: null,
    });

    owner.recordSessionHit({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      requestId: "request-1",
      provider: "openai",
      gatewayPath: "/providers/openai/v1/chat/completions",
      at: now,
    });
    const observed = await owner.waitForProviderStart({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      runId: "run-1",
      opencodeSessionId: "session-1",
      startedAt: now - 1,
    });
    expect(observed).toEqual({
      started: true,
      timeoutMs: 10,
      providerHitScope: "session",
      providerHitCount: 1,
      firstProviderHitAt: now,
      lastProviderHitAt: now,
    });
  });
});
