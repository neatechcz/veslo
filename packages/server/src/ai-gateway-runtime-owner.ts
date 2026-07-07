import type { Actor } from "./types.js";
import { ApiError } from "./errors.js";

export const AI_GATEWAY_REDACTED_SECRET_VALUE = "[REDACTED]";

const OPENCODE_SESSION_ID_MARKER = "OPENCODE_SESSION_ID";
const DEFAULT_SESSION_HIT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVE_RUN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_AUTHORIZATION_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_PROVIDER_START_TIMEOUT_MS = 30_000;

export type ActiveAiGatewayRunContext = {
  at: number;
  traceId: string | null;
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  runtimeAuthorizationActorTokenHash: string | null;
};

export type AiGatewaySessionResolutionSource =
  | "veslo-session-header"
  | "opencode-session-header"
  | "workspace-active-run-context"
  | "sessionless-fallback"
  | "unresolved";

export type AiGatewaySessionResolution = {
  sessionId: string;
  activeRunContext: ActiveAiGatewayRunContext | null;
  workspaceId: string | null;
  source: AiGatewaySessionResolutionSource;
  workspaceFallbackSuppressedReason?: string;
  workspaceFallbackCandidateCount?: number;
  activeContextCount?: number;
};

export type ActiveAiGatewayProxyRequest = {
  requestId: string;
  controller: AbortController;
  startedAt: number;
  abortReason: string | null;
  provider: string | null;
  gatewayPath: string;
  sessionId: string | null;
  workspaceId: string | null;
  traceId: string | null;
  conversationId: string | null;
  runId: string | null;
  opencodeSessionId: string | null;
  clientMessageId: string | null;
  origin: string | null;
};

type AiGatewaySessionHit = {
  at: number;
  requestId: string;
  provider: string | null;
  gatewayPath: string;
  sessionId: string | null;
  workspaceId: string | null;
};

export type AiGatewayRuntimeAuthorizationEntry = {
  authorization: string;
  at: number;
  source: "ai-access-token" | "caller-authorization";
};

export type AiGatewayRuntimeOwnerOptions = {
  activeRunTtlMs?: number;
  sessionHitTtlMs?: number;
  runtimeAuthorizationMaxAgeMs?: number;
  providerStartTimeoutMs?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  recordTrace?: (event: string, payload: Record<string, unknown>) => void;
  log?: {
    log: (message?: unknown, ...optionalParams: unknown[]) => void;
    warn: (message?: unknown, ...optionalParams: unknown[]) => void;
  };
};

export function normalizeAiGatewaySessionId(sessionId?: string | null): string {
  const normalized = sessionId?.trim() ?? "";
  if (!normalized) return "";
  if (containsUnresolvedOpenCodeSessionId(normalized)) return "";
  return normalized;
}

export function containsUnresolvedOpenCodeSessionId(value?: string | null): boolean {
  return (value?.trim() ?? "").includes(OPENCODE_SESSION_ID_MARKER);
}

function isRedactedGatewayTokenPlaceholder(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  const token = normalized.replace(/^Bearer\s+/i, "").trim().toLowerCase();
  return token === AI_GATEWAY_REDACTED_SECRET_VALUE.toLowerCase() || token === "[redacted]" || token === "redacted";
}

function actorRuntimeTokenKey(actor?: Actor): string {
  return actor?.tokenHash?.trim() ?? "";
}

function topLevelRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readAiAccessBundleAccessToken(value: unknown): string {
  const accessToken = topLevelRecord(value).accessToken;
  return typeof accessToken === "string" && accessToken.trim() !== AI_GATEWAY_REDACTED_SECRET_VALUE
    ? accessToken.trim()
    : "";
}

function readAiAccessBundleEnabled(value: unknown): boolean {
  const aiAccess = topLevelRecord(topLevelRecord(value).aiAccess);
  return aiAccess.enabled === true;
}

function roundDiagnosticMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function activeRunContextKey(context: ActiveAiGatewayRunContext): string {
  return [
    context.workspaceId,
    context.conversationId,
    context.runId,
    context.opencodeSessionId,
    context.at,
  ].join("\0");
}

export function createAiGatewayRuntimeOwner(options: AiGatewayRuntimeOwnerOptions = {}) {
  const activeRunTtlMs = options.activeRunTtlMs ?? DEFAULT_ACTIVE_RUN_TTL_MS;
  const sessionHitTtlMs = options.sessionHitTtlMs ?? DEFAULT_SESSION_HIT_TTL_MS;
  const runtimeAuthorizationMaxAgeMs = Math.max(
    1,
    options.runtimeAuthorizationMaxAgeMs ?? DEFAULT_RUNTIME_AUTHORIZATION_MAX_AGE_MS,
  );
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const providerStartTimeoutMs = options.providerStartTimeoutMs ?? (() => DEFAULT_PROVIDER_START_TIMEOUT_MS);
  const recordTrace = options.recordTrace ?? (() => undefined);
  const log = options.log ?? console;

  const sessionHits = new Map<string, AiGatewaySessionHit[]>();
  const workspaceHits = new Map<string, AiGatewaySessionHit[]>();
  const activeRunsBySession = new Map<string, ActiveAiGatewayRunContext[]>();
  const activeRunsByWorkspace = new Map<string, ActiveAiGatewayRunContext[]>();
  const activeProxyRequests = new Map<string, ActiveAiGatewayProxyRequest>();
  const runtimeAuthorizationByActorToken = new Map<string, AiGatewayRuntimeAuthorizationEntry>();

  const summarizeRunContext = (
    context: ActiveAiGatewayRunContext,
    at: number,
  ): Record<string, unknown> => {
    const ageMs = Math.max(0, at - context.at);
    return {
      ageMs: roundDiagnosticMs(ageMs),
      expiresInMs: roundDiagnosticMs(Math.max(0, activeRunTtlMs - ageMs)),
      traceId: context.traceId,
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      runId: context.runId,
      opencodeSessionId: context.opencodeSessionId,
      clientMessageId: context.clientMessageId,
      origin: context.origin,
      runtimeAuthorizationActorTokenHashPresent: Boolean(context.runtimeAuthorizationActorTokenHash),
    };
  };

  const summarizeRunContexts = (
    contexts: ActiveAiGatewayRunContext[],
    at: number,
    limit = 5,
  ): Array<Record<string, unknown>> =>
    contexts
      .slice()
      .sort((left, right) => right.at - left.at)
      .slice(0, limit)
      .map((context) => summarizeRunContext(context, at));

  const summarizeContextKeys = (
    itemsByKey: Map<string, ActiveAiGatewayRunContext[]>,
    limit = 20,
  ): string[] => Array.from(itemsByKey.keys()).sort((left, right) => left.localeCompare(right)).slice(0, limit);

  const listActiveRunContexts = (at = now()): ActiveAiGatewayRunContext[] => {
    pruneActiveRuns(at);
    const seen = new Set<string>();
    const contexts: ActiveAiGatewayRunContext[] = [];
    for (const items of activeRunsByWorkspace.values()) {
      for (const item of items) {
        const key = activeRunContextKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        contexts.push(item);
      }
    }
    return contexts;
  };

  const summarizeRecentContexts = (at: number, limit = 8): Array<Record<string, unknown>> =>
    summarizeRunContexts(listActiveRunContexts(at), at, limit);

  function pruneSessionHits(at = now()): void {
    const cutoff = at - sessionHitTtlMs;
    const prune = (hitsByKey: Map<string, AiGatewaySessionHit[]>) => {
      for (const [key, hits] of hitsByKey) {
        const liveHits = hits.filter((hit) => hit.at >= cutoff);
        if (liveHits.length) {
          hitsByKey.set(key, liveHits);
        } else {
          hitsByKey.delete(key);
        }
      }
    };
    prune(sessionHits);
    prune(workspaceHits);
  }

  function pruneActiveRuns(at = now()): void {
    const cutoff = at - activeRunTtlMs;
    const prune = (itemsByKey: Map<string, ActiveAiGatewayRunContext[]>) => {
      for (const [key, items] of itemsByKey) {
        const liveItems = items.filter((item) => item.at >= cutoff);
        if (liveItems.length) {
          itemsByKey.set(key, liveItems);
        } else {
          itemsByKey.delete(key);
        }
      }
    };
    prune(activeRunsBySession);
    prune(activeRunsByWorkspace);
  }

  function latestRunBySession(sessionId?: string | null): ActiveAiGatewayRunContext | null {
    const normalizedSessionId = normalizeAiGatewaySessionId(sessionId);
    if (!normalizedSessionId) return null;
    const bySession = activeRunsBySession.get(normalizedSessionId) ?? [];
    return bySession[bySession.length - 1] ?? null;
  }

  function latestRunByWorkspace(workspaceId?: string | null): ActiveAiGatewayRunContext | null {
    const normalizedWorkspaceId = workspaceId?.trim() ?? "";
    if (!normalizedWorkspaceId) return null;
    const byWorkspace = activeRunsByWorkspace.get(normalizedWorkspaceId) ?? [];
    return byWorkspace[byWorkspace.length - 1] ?? null;
  }

  function activeRunMatches(
    context: ActiveAiGatewayRunContext,
    input: Pick<ActiveAiGatewayRunContext, "workspaceId" | "conversationId" | "runId" | "opencodeSessionId">,
  ): boolean {
    return context.workspaceId === input.workspaceId &&
      context.conversationId === input.conversationId &&
      context.runId === input.runId &&
      context.opencodeSessionId === input.opencodeSessionId;
  }

  function buildResolutionDiagnostics(input: {
    incomingSessionId?: string | null;
    workspaceId?: string | null;
  }): Record<string, unknown> {
    const at = now();
    pruneActiveRuns(at);
    const normalizedIncomingSessionId = normalizeAiGatewaySessionId(input.incomingSessionId);
    const workspaceId = input.workspaceId?.trim() ?? "";
    const sessionCandidates = normalizedIncomingSessionId
      ? activeRunsBySession.get(normalizedIncomingSessionId) ?? []
      : [];
    const workspaceCandidates = workspaceId
      ? activeRunsByWorkspace.get(workspaceId) ?? []
      : [];
    return {
      normalizedIncomingSessionId: normalizedIncomingSessionId || null,
      workspaceId: workspaceId || null,
      sessionCandidateCount: sessionCandidates.length,
      workspaceCandidateCount: workspaceCandidates.length,
      totalSessionContextKeys: activeRunsBySession.size,
      totalWorkspaceContextKeys: activeRunsByWorkspace.size,
      sessionContextKeys: summarizeContextKeys(activeRunsBySession),
      workspaceContextKeys: summarizeContextKeys(activeRunsByWorkspace),
      sessionCandidates: summarizeRunContexts(sessionCandidates, at),
      workspaceCandidates: summarizeRunContexts(workspaceCandidates, at),
      recentContexts: summarizeRecentContexts(at),
      activeProxyRequestCount: activeProxyRequests.size,
    };
  }

  function registerRuntimeAuthorization(input: {
    actor?: Actor;
    authorization: string;
    source: AiGatewayRuntimeAuthorizationEntry["source"];
  }): void {
    const key = actorRuntimeTokenKey(input.actor);
    const authorization = input.authorization.trim();
    if (!key || !authorization) return;
    const entry = {
      authorization,
      source: input.source,
      at: now(),
    };
    runtimeAuthorizationByActorToken.set(key, entry);
  }

  function clearRuntimeAuthorization(actor?: Actor): void {
    const key = actorRuntimeTokenKey(actor);
    if (!key) return;
    runtimeAuthorizationByActorToken.delete(key);
  }

  function syncRuntimeAuthorizationFromAccessBundle(input: {
    actor?: Actor;
    value: unknown;
    callerAuthorization: string;
  }): void {
    if (!readAiAccessBundleEnabled(input.value)) {
      clearRuntimeAuthorization(input.actor);
      return;
    }

    const accessToken = readAiAccessBundleAccessToken(input.value);
    if (accessToken) {
      registerRuntimeAuthorization({
        ...(input.actor ? { actor: input.actor } : {}),
        authorization: `Bearer ${accessToken}`,
        source: "ai-access-token",
      });
      return;
    }

    registerRuntimeAuthorization({
      ...(input.actor ? { actor: input.actor } : {}),
      authorization: input.callerAuthorization,
      source: "caller-authorization",
    });
  }

  function resolveProviderAuthorization(input: {
    request: Request;
    actor?: Actor;
    accessTokenHeader: string;
    runtimeAuthorizationActorTokenHash?: string | null;
    activeRunContextPresent?: boolean;
  }): {
    authorization: string;
    source: AiGatewayRuntimeAuthorizationEntry["source"];
  } {
    const key = actorRuntimeTokenKey(input.actor);
    const scopedKey = input.runtimeAuthorizationActorTokenHash?.trim() ?? "";
    const runtimeCandidates: Array<{
      key: string;
      entry: AiGatewayRuntimeAuthorizationEntry | undefined;
      scoped: boolean;
    }> = [
      ...(scopedKey ? [{ key: scopedKey, entry: runtimeAuthorizationByActorToken.get(scopedKey), scoped: true }] : []),
      ...(key && key !== scopedKey ? [{ key, entry: runtimeAuthorizationByActorToken.get(key), scoped: false }] : []),
    ];
    let expiredRuntimeAuthorization = false;
    const at = now();
    for (const runtimeCandidate of runtimeCandidates) {
      if (!runtimeCandidate.entry?.authorization.trim()) continue;
      const resolvedRuntime = runtimeCandidate.entry;
      const ageMs = Math.max(0, at - resolvedRuntime.at);
      if (ageMs > runtimeAuthorizationMaxAgeMs) {
        expiredRuntimeAuthorization = true;
        runtimeAuthorizationByActorToken.delete(runtimeCandidate.key);
        recordTrace("server:ai-gateway-runtime-authorization:expired", {
          ageMs: roundDiagnosticMs(ageMs),
          maxAgeMs: runtimeAuthorizationMaxAgeMs,
          source: resolvedRuntime.source,
          runtimeAuthorizationActorTokenHashPresent: runtimeCandidate.scoped,
        });
        continue;
      }
      return {
        authorization: resolvedRuntime.authorization,
        source: resolvedRuntime.source,
      };
    }

    if (expiredRuntimeAuthorization) {
      throw new ApiError(
        401,
        "gateway_runtime_authorization_expired",
        "Managed AI gateway authorization in this Veslo server runtime has expired",
      );
    }

    const legacyAccessToken = input.request.headers.get(input.accessTokenHeader)?.trim() ?? "";
    if (legacyAccessToken) {
      if (isRedactedGatewayTokenPlaceholder(legacyAccessToken)) {
        throw new ApiError(
          401,
          "gateway_legacy_token_unavailable",
          "Legacy AI gateway token is redacted or unavailable",
        );
      }
      recordTrace("server:ai-gateway-legacy-token:ignored", {
        activeRunContextPresent: Boolean(input.activeRunContextPresent),
      });
    }

    throw new ApiError(
      401,
      "gateway_runtime_authorization_required",
      "Managed AI gateway authorization is not available in this Veslo server runtime",
    );
  }

  function registerActiveRun(input: Omit<ActiveAiGatewayRunContext, "at">): void {
    const at = now();
    pruneActiveRuns(at);
    const context: ActiveAiGatewayRunContext = { ...input, at };
    const sessionId = normalizeAiGatewaySessionId(input.opencodeSessionId);
    if (sessionId) {
      const items = activeRunsBySession.get(sessionId) ?? [];
      items.push(context);
      activeRunsBySession.set(sessionId, items.slice(-10));
    }
    const workspaceId = input.workspaceId.trim();
    if (workspaceId) {
      const items = activeRunsByWorkspace.get(workspaceId) ?? [];
      items.push(context);
      activeRunsByWorkspace.set(workspaceId, items.slice(-10));
    }
    recordTrace("server:ai-gateway-active-run:register", {
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId: input.opencodeSessionId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      runtimeAuthorizationActorTokenHashPresent: Boolean(input.runtimeAuthorizationActorTokenHash),
      activeContextDiagnostics: buildResolutionDiagnostics({
        incomingSessionId: input.opencodeSessionId,
        workspaceId: input.workspaceId,
      }),
    });
  }

  function unregisterActiveRun(
    input: Pick<ActiveAiGatewayRunContext, "workspaceId" | "conversationId" | "runId" | "opencodeSessionId">,
  ): void {
    const sessionId = normalizeAiGatewaySessionId(input.opencodeSessionId);
    if (sessionId) {
      const next = (activeRunsBySession.get(sessionId) ?? [])
        .filter((context) => !activeRunMatches(context, input));
      if (next.length) {
        activeRunsBySession.set(sessionId, next);
      } else {
        activeRunsBySession.delete(sessionId);
      }
    }

    const workspaceId = input.workspaceId.trim();
    if (workspaceId) {
      const next = (activeRunsByWorkspace.get(workspaceId) ?? [])
        .filter((context) => !activeRunMatches(context, input));
      if (next.length) {
        activeRunsByWorkspace.set(workspaceId, next);
      } else {
        activeRunsByWorkspace.delete(workspaceId);
      }
    }
  }

  function resolveSession(input: {
    incomingSessionId?: string | null;
    openCodeSessionId?: string | null;
    workspaceId?: string | null;
  }): AiGatewaySessionResolution {
    pruneActiveRuns();
    const hasUnresolvedOpenCodeSessionId = containsUnresolvedOpenCodeSessionId(input.incomingSessionId);
    const incomingSessionId = normalizeAiGatewaySessionId(input.incomingSessionId);
    const openCodeSessionId = normalizeAiGatewaySessionId(input.openCodeSessionId);
    const workspaceId = input.workspaceId?.trim() ?? "";

    if (incomingSessionId) {
      const activeRunContext = latestRunBySession(incomingSessionId);
      return {
        sessionId: incomingSessionId,
        activeRunContext,
        workspaceId: activeRunContext?.workspaceId ?? null,
        source: "veslo-session-header",
      };
    }

    if (openCodeSessionId) {
      const activeRunContext = latestRunBySession(openCodeSessionId);
      return {
        sessionId: openCodeSessionId,
        activeRunContext,
        workspaceId: activeRunContext?.workspaceId ?? null,
        source: "opencode-session-header",
      };
    }

    const workspaceContext = latestRunByWorkspace(workspaceId);
    if (workspaceContext) {
      const activeContexts = listActiveRunContexts();
      const workspaceCandidates = workspaceId ? activeRunsByWorkspace.get(workspaceId) ?? [] : [];
      if (activeContexts.length === 1 && workspaceCandidates.length === 1) {
        return {
          sessionId: normalizeAiGatewaySessionId(workspaceContext.opencodeSessionId),
          activeRunContext: workspaceContext,
          workspaceId: workspaceContext.workspaceId,
          source: "workspace-active-run-context",
        };
      }
      return {
        sessionId: "",
        activeRunContext: null,
        workspaceId: workspaceId || null,
        source: hasUnresolvedOpenCodeSessionId ? "sessionless-fallback" : "unresolved",
        workspaceFallbackSuppressedReason: "ambiguous-active-run-context",
        workspaceFallbackCandidateCount: workspaceCandidates.length,
        activeContextCount: activeContexts.length,
      };
    }

    return {
      sessionId: "",
      activeRunContext: null,
      workspaceId: workspaceId || null,
      source: hasUnresolvedOpenCodeSessionId ? "sessionless-fallback" : "unresolved",
    };
  }

  function registerActiveProxyRequest(
    input: Omit<ActiveAiGatewayProxyRequest, "abortReason">,
  ): ActiveAiGatewayProxyRequest {
    const entry: ActiveAiGatewayProxyRequest = {
      ...input,
      abortReason: null,
    };
    activeProxyRequests.set(entry.requestId, entry);
    return entry;
  }

  function unregisterActiveProxyRequest(requestId: string): void {
    activeProxyRequests.delete(requestId);
  }

  function abortActiveProxyRequests(input: {
    workspaceId: string;
    runId?: string | null;
    sessionId?: string | null;
    reason: string;
  }): ActiveAiGatewayProxyRequest[] {
    const workspaceId = input.workspaceId.trim();
    const runId = input.runId?.trim() ?? "";
    const sessionId = normalizeAiGatewaySessionId(input.sessionId);
    if (!workspaceId || (!runId && !sessionId)) return [];

    const aborted: ActiveAiGatewayProxyRequest[] = [];
    for (const entry of activeProxyRequests.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      const runMatches = Boolean(runId && entry.runId === runId);
      const sessionMatches = Boolean(sessionId && entry.sessionId === sessionId);
      if (!runMatches && !sessionMatches) continue;
      entry.abortReason = input.reason;
      entry.controller.abort();
      aborted.push(entry);
    }

    if (aborted.length) {
      const first = aborted[0];
      recordTrace("server:ai-gateway:proxy-abort-active", {
        traceId: first?.traceId ?? null,
        workspaceId,
        runId: runId || null,
        sessionId: sessionId || null,
        reason: input.reason,
        requestIds: aborted.map((entry) => entry.requestId),
        count: aborted.length,
        conversationIds: Array.from(new Set(aborted.map((entry) => entry.conversationId).filter(Boolean))),
        clientMessageIds: Array.from(new Set(aborted.map((entry) => entry.clientMessageId).filter(Boolean))),
      });
    }

    return aborted;
  }

  function recordSessionHit(input: {
    sessionId?: string;
    workspaceId?: string;
    requestId: string;
    provider: string | null;
    gatewayPath: string;
    at?: number;
  }): void {
    const sessionId = normalizeAiGatewaySessionId(input.sessionId);
    const workspaceId = input.workspaceId?.trim() ?? "";
    if (!sessionId && !workspaceId) return;
    const at = input.at ?? now();
    pruneSessionHits(at);
    const hit: AiGatewaySessionHit = {
      at,
      requestId: input.requestId,
      provider: input.provider,
      gatewayPath: input.gatewayPath,
      sessionId: sessionId || null,
      workspaceId: workspaceId || null,
    };
    if (sessionId) {
      const hits = sessionHits.get(sessionId) ?? [];
      hits.push(hit);
      sessionHits.set(sessionId, hits.slice(-50));
    }
    if (workspaceId) {
      const hits = workspaceHits.get(workspaceId) ?? [];
      hits.push(hit);
      workspaceHits.set(workspaceId, hits.slice(-50));
    }
  }

  function hasProviderHitAfter(input: {
    sessionId: string;
    workspaceId: string;
    startedAt: number;
  }): boolean {
    const normalizedSessionId = normalizeAiGatewaySessionId(input.sessionId);
    const normalizedWorkspaceId = input.workspaceId.trim();
    pruneSessionHits();
    if (
      normalizedSessionId &&
      (sessionHits.get(normalizedSessionId) ?? []).some((hit) => hit.at >= input.startedAt)
    ) {
      return true;
    }
    if (normalizedSessionId) return false;
    if (
      normalizedWorkspaceId &&
      (workspaceHits.get(normalizedWorkspaceId) ?? []).some((hit) => hit.at >= input.startedAt)
    ) {
      return true;
    }
    return false;
  }

  function logProviderStartTimeout(input: Record<string, unknown>): void {
    try {
      log.warn(`[veslo:ai-gateway] provider-start-timeout ${JSON.stringify(input)}`);
    } catch {
      log.warn("[veslo:ai-gateway] provider-start-timeout");
    }
  }

  function logProviderStartWatch(input: Record<string, unknown>): void {
    try {
      log.log(`[veslo:ai-gateway] provider-start-watch ${JSON.stringify(input)}`);
    } catch {
      log.log("[veslo:ai-gateway] provider-start-watch");
    }
  }

  async function waitForProviderStart(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    opencodeSessionId: string;
    clientMessageId?: string | null;
    origin?: string | null;
    startedAt: number;
  }): Promise<{ started: boolean; timeoutMs: number }> {
    const timeoutMs = providerStartTimeoutMs();
    const opencodeSessionId = input.opencodeSessionId.trim();
    const workspaceId = input.workspaceId.trim();
    if (!opencodeSessionId) return { started: false, timeoutMs };

    logProviderStartWatch({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId,
      clientMessageId: input.clientMessageId ?? null,
      origin: input.origin ?? null,
      timeoutMs,
    });

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (hasProviderHitAfter({ sessionId: opencodeSessionId, workspaceId, startedAt: input.startedAt })) {
        return { started: true, timeoutMs };
      }
      await sleep(Math.min(100, Math.max(5, deadline - now())));
    }

    const started = hasProviderHitAfter({ sessionId: opencodeSessionId, workspaceId, startedAt: input.startedAt });
    if (!started) {
      logProviderStartTimeout({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        runId: input.runId,
        opencodeSessionId,
        clientMessageId: input.clientMessageId ?? null,
        origin: input.origin ?? null,
        timeoutMs,
      });
    }
    return { started, timeoutMs };
  }

  function resetForTests(): void {
    sessionHits.clear();
    workspaceHits.clear();
    activeRunsBySession.clear();
    activeRunsByWorkspace.clear();
    activeProxyRequests.clear();
    runtimeAuthorizationByActorToken.clear();
  }

  return {
    abortActiveProxyRequests,
    buildResolutionDiagnostics,
    clearRuntimeAuthorization,
    hasProviderHitAfter,
    listActiveRunContexts,
    recordSessionHit,
    registerActiveProxyRequest,
    registerActiveRun,
    registerRuntimeAuthorization,
    resetForTests,
    resolveProviderAuthorization,
    resolveSession,
    syncRuntimeAuthorizationFromAccessBundle,
    unregisterActiveProxyRequest,
    unregisterActiveRun,
    waitForProviderStart,
  };
}

export type AiGatewayRuntimeOwner = ReturnType<typeof createAiGatewayRuntimeOwner>;
