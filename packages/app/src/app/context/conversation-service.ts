import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  parseVesloWorkspaceIdFromUrl,
  VesloServerError,
  type VesloConversationAbortInput,
  type VesloConversationAbortResult,
  type VesloConversationCreateResult,
  type VesloConversationReadDiagnostic,
  type VesloConversationRunInput,
  type VesloConversationRunResult,
  type VesloConversationRunStatusResult,
  type VesloConversationSubmitRequest,
  type VesloConversationSubmitResult,
  type VesloSessionTranscriptRecoveryInput,
  type VesloSessionTranscriptRecoveryResult,
  type VesloSessionTranscriptReadOptions,
  type VesloSessionTranscriptSnapshot,
} from "../lib/veslo-server";
import { normalizeDirectoryPath, safeStringify } from "../utils";
import type { StartupPreference } from "../types";
import type { ManagedAiRuntimeAuthPrimeDiagnostic } from "./managed-ai-runtime-config";
import type { SendTargetWorkspaceScope } from "./workspace-session-selection";

export type ConversationServiceClient = {
  baseUrl?: string;
  listWorkspaces: () => Promise<{ items: ConversationWorkspaceRegistryEntry[] }>;
  addLocalWorkspace: (input: {
    path: string;
    name?: string;
    baseUrl?: string | null;
    directory?: string | null;
    opencodeUsername?: string | null;
    opencodePassword?: string | null;
  }) => Promise<{ items: ConversationWorkspaceRegistryEntry[] }>;
  listConversations: (
    workspaceId: string,
    directory?: string,
    options?: { sync?: boolean },
  ) => Promise<{
    workspaceId: string;
    items: Array<Session & { conversationId?: string | null; opencodeSessionId?: string | null }>;
    source?: "sqlite" | "unavailable";
    diagnostic?: VesloConversationReadDiagnostic;
  }>;
  importConversations: (
    workspaceId: string,
    input: { directory?: string | null; sessions: Session[] },
  ) => Promise<{
    workspaceId: string;
    items: Array<Session & { conversationId?: string | null; opencodeSessionId?: string | null }>;
  }>;
  getSessionTranscript: (
    workspaceId: string,
    sessionId: string,
    limit?: number,
    directory?: string,
    options?: VesloSessionTranscriptReadOptions,
  ) => Promise<VesloSessionTranscriptSnapshot>;
  createConversation: (
    workspaceId: string,
    input?: { directory?: string | null; title?: string | null },
    options?: { sendTraceId?: string | null },
  ) => Promise<VesloConversationCreateResult>;
  submitConversation: (
    workspaceId: string,
    input: VesloConversationSubmitRequest,
    options?: { sendTraceId?: string | null },
  ) => Promise<VesloConversationSubmitResult>;
  runConversation: (
    workspaceId: string,
    conversationId: string,
    input: VesloConversationRunInput,
    options?: { sendTraceId?: string | null },
  ) => Promise<VesloConversationRunResult>;
  abortConversation: (
    workspaceId: string,
    conversationId: string,
    input: VesloConversationAbortInput,
  ) => Promise<VesloConversationAbortResult>;
  getConversationRunStatus: (
    workspaceId: string,
    conversationId: string,
    runId: string,
  ) => Promise<VesloConversationRunStatusResult>;
  recoverSessionTranscript: (
    workspaceId: string,
    sessionId: string,
    input: VesloSessionTranscriptRecoveryInput,
  ) => Promise<VesloSessionTranscriptRecoveryResult>;
};

export type ConversationServiceWorkspace = {
  id: string;
  name?: string | null;
  workspaceType?: string | null;
  remoteType?: string | null;
  path?: string | null;
  directory?: string | null;
  baseUrl?: string | null;
  vesloWorkspaceId?: string | null;
  vesloHostUrl?: string | null;
};

export type ConversationServiceBrowseScope = {
  sessionId?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type ConversationServiceScopeInput = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type ConversationAbortTarget = {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type ConversationWorkspaceResolution<Client extends ConversationServiceClient = ConversationServiceClient> = {
  serverClient: Client;
  serverWorkspaceId: string;
  workspaceId: string;
  directory: string;
};

export type ConversationSendPreflightContext<Client extends ConversationServiceClient = ConversationServiceClient> = {
  traceId: string;
  managedAiReady?: boolean;
  runtimeHealthOk?: boolean;
  targetWorkspace?: SendTargetWorkspaceScope | null;
  conversationWorkspaceByDirectory: Map<string, Promise<ConversationWorkspaceResolution<Client> | null>>;
};

function conversationPreflightContractDiagnostics(preflight: unknown): Record<string, unknown> {
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)) {
    return {
      hasPreflight: Boolean(preflight),
      preflightType: preflight === null ? "null" : typeof preflight,
    };
  }

  const record = preflight as Record<string, unknown>;
  const cache = record.conversationWorkspaceByDirectory;
  const targetWorkspace = record.targetWorkspace;
  const targetWorkspaceRecord =
    targetWorkspace && typeof targetWorkspace === "object" && !Array.isArray(targetWorkspace)
      ? targetWorkspace as Record<string, unknown>
      : null;

  return {
    hasPreflight: true,
    preflightKeys: Object.keys(record).sort(),
    hasConversationWorkspaceByDirectory: cache !== undefined && cache !== null,
    conversationWorkspaceByDirectoryType:
      cache instanceof Map
        ? "Map"
        : Array.isArray(cache)
          ? "array"
          : cache === null
            ? "null"
            : typeof cache,
    targetWorkspaceId:
      typeof targetWorkspaceRecord?.workspaceId === "string"
        ? targetWorkspaceRecord.workspaceId
        : null,
    runtimeHealthOk: typeof record.runtimeHealthOk === "boolean" ? record.runtimeHealthOk : null,
    managedAiReady: typeof record.managedAiReady === "boolean" ? record.managedAiReady : null,
  };
}

export type ConversationRunSubmitOptions<Client extends ConversationServiceClient = ConversationServiceClient> = {
  sendTraceId?: string | null;
  preflight?: ConversationSendPreflightContext<Client>;
  targetWorkspace?: SendTargetWorkspaceScope | null;
};

export type ConversationReadIntent =
  | "browse-only"
  | "live-read"
  | "status-poll"
  | "write-follow-up"
  | "write-control";

export type ConversationPassiveReadPolicy = {
  intent: ConversationReadIntent;
  reason: string;
  workspaceId?: string | null;
  directory?: string | null;
};

type ConversationManagedProfile = {
  providerId?: string | null;
  effectiveModel?: {
    modelID?: string | null;
  } | null;
};

type ConversationEngineInfo = {
  baseUrl?: string | null;
  projectDir?: string | null;
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
};

export type ConversationServiceDeps<Client extends ConversationServiceClient = ConversationServiceClient> = {
  vesloServerClient: () => Client | null;
  vesloServerStatus: () => string;
  isTauriRuntime: () => boolean;
  startupPreference: () => StartupPreference | null;
  ensureLocalVesloServerRunning: (options?: {
    requireRuntimeChainReady?: boolean;
  }) => Promise<boolean>;
  workspaces: () => ConversationServiceWorkspace[];
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  sessionDirectoryOverrideById: () => Record<string, string>;
  resolveSelectedSessionBrowseScope: (sessionId: string) => ConversationServiceBrowseScope | null;
  resolveWorkspaceRootForConversationScope: (workspaceId: string, directory?: string | null) => string;
  rememberConversationScope: (scope: ConversationServiceScopeInput) => void;
  rememberConversationScopesFromSessions: (
    workspaceId: string,
    directory: string | undefined,
    sessions: Array<Session & { conversationId?: string | null; opencodeSessionId?: string | null }>,
  ) => void;
  rememberConversationScopeFromTranscript: (
    workspaceId: string,
    directory: string | undefined,
    snapshot: Pick<
      VesloSessionTranscriptSnapshot,
      "sessionId" | "directory" | "conversationId" | "opencodeSessionId"
    > | null,
  ) => void;
  rememberLatestConversationRunId: (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }) => void;
  resolveLatestConversationRunId: (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
  }) => string;
  rememberLatestConversationLifecycleRunId: (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
    runId?: string | null;
  }) => void;
  resolveLatestConversationLifecycleRunId: (input: {
    workspaceId: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    uiSessionId?: string | null;
  }) => string;
  managedAiAccess: () => ConversationManagedProfile | null;
  ensureManagedAiRuntimeAuthorizationForSend?: (
    targetWorkspace?: SendTargetWorkspaceScope | null,
  ) => Promise<boolean>;
  managedAiRuntimeAuthorizationPrimeDiagnostic?: () => ManagedAiRuntimeAuthPrimeDiagnostic | null;
  activeSendTraceId: () => string | null;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  recordExternalSendTraceEntries: (entries: unknown) => void;
  engineInfo: (workspaceId?: string, directory?: string) => Promise<ConversationEngineInfo>;
  wsDebug: (event: string, payload?: Record<string, unknown>) => void;
};

type ConversationWorkspaceRegistryEntry = {
  id: string;
  path?: string;
  directory?: string;
  baseUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
  };
};

const normalizeBaseUrlForCompare = (value: string | null | undefined) =>
  value?.trim().replace(/\/+$/, "") ?? "";

const parseWorkspaceMountId = (value: string | null | undefined) => {
  const baseUrl = normalizeBaseUrlForCompare(value);
  if (!baseUrl) return "";
  try {
    const match = new URL(baseUrl).pathname.match(/^\/workspace\/([^/]+)\/opencode(?:\/.*)?$/);
    return match ? decodeURIComponent(match[1] ?? "").trim() : "";
  } catch {
    return "";
  }
};

const conversationWorkspaceCacheKey = (workspaceId: string, directory: string) => [
  workspaceId.trim(),
  normalizeDirectoryPath(directory) || directory.trim(),
].join("\n");

// Kept in sync with the server-owned source cache. The app only requests a
// display view, but its trace needs to identify the source window measured by
// the corresponding server event.
const TRANSCRIPT_PROJECTION_SOURCE_LIMIT = 200;

function isInvalidHostTokenError(error: unknown): boolean {
  return error instanceof VesloServerError &&
    error.status === 401 &&
    /invalid host token/i.test(error.message);
}

export function createConversationService<Client extends ConversationServiceClient>(
  deps: ConversationServiceDeps<Client>,
) {
  type ConversationWorkspaceRegistrationResult = { id: string; cacheable: boolean };
  type ConversationWorkspaceRegistrationFlight = {
    id: string;
    promise: Promise<ConversationWorkspaceRegistrationResult>;
  };

  const conversationWorkspaceRegistrationCacheByClient = new WeakMap<
    object,
    Map<string, ConversationWorkspaceRegistrationFlight>
  >();
  let conversationWorkspaceRegistrationFlightSequence = 0;

  const resolveConversationServerWorkspaceId = (workspaceIdRaw: string) => {
    const workspaceId = workspaceIdRaw.trim();
    if (!workspaceId) return "";

    const workspace = deps.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return workspaceId;

    if (workspace.workspaceType === "remote" && workspace.remoteType === "veslo") {
      return (
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        workspaceId
      );
    }

    return workspace.vesloWorkspaceId?.trim() || "";
  };

  const passiveReadPolicyAllowsServerStart = (policy: ConversationPassiveReadPolicy | undefined) =>
    policy?.intent === "write-follow-up" ||
    policy?.intent === "write-control";

  const recordPassiveServerStartDeclined = (policy: ConversationPassiveReadPolicy | undefined) => {
    deps.recordSendTrace("conversation-read:server-start-declined", {
      reason: policy?.reason ?? "unspecified",
      intent: policy?.intent ?? "unspecified",
      workspaceId: policy?.workspaceId ?? null,
      directory: policy?.directory ?? null,
      vesloServerStatus: deps.vesloServerStatus(),
    });
    deps.wsDebug("conversation-read:server-start:declined", {
      reason: policy?.reason ?? "unspecified",
      intent: policy?.intent ?? "unspecified",
      workspaceId: policy?.workspaceId ?? null,
      directory: policy?.directory ?? null,
    });
  };

  const resolvePassiveConversationReadClient = async (
    policy?: ConversationPassiveReadPolicy,
  ) => {
    let serverClient = deps.vesloServerClient();
    if (serverClient) return serverClient;

    const allowServerStart = passiveReadPolicyAllowsServerStart(policy);
    if (!allowServerStart) {
      recordPassiveServerStartDeclined(policy);
      return null;
    }

    let attemptedServerStart = false;
    if (deps.isTauriRuntime() && deps.startupPreference() !== "server" && deps.vesloServerStatus() === "disconnected") {
      attemptedServerStart = true;
      await deps.ensureLocalVesloServerRunning().catch((error) => {
        deps.wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = deps.vesloServerClient();
    }
    if (serverClient) return serverClient;

    if (deps.isTauriRuntime() && !attemptedServerStart) {
      await deps.ensureLocalVesloServerRunning().catch((error) => {
        deps.wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = deps.vesloServerClient();
    }

    return serverClient;
  };

  const rememberConversationSubmitResultScope = (input: {
    workspaceId: string;
    workspaceRoot: string;
    directory: string;
    requestConversationId?: string | null;
    requestOpencodeSessionId?: string | null;
    requestPendingClientSessionId?: string | null;
    result: Extract<VesloConversationSubmitResult, { status: "materialized" | "submitted" | "queued" }>;
    traceId?: string | null;
  }) => {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) return;
    const directory = input.directory.trim();
    const workspaceRoot = input.workspaceRoot.trim() || directory;
    const conversationId = input.result.conversationId?.trim() || input.requestConversationId?.trim() || "";
    const opencodeSessionId = input.result.opencodeSessionId?.trim() || input.requestOpencodeSessionId?.trim() || "";
    const resultPendingClientSessionId =
      "pendingClientSessionId" in input.result ? input.result.pendingClientSessionId : null;
    const aliases = [
      input.requestPendingClientSessionId,
      resultPendingClientSessionId,
      input.requestOpencodeSessionId,
      input.result.opencodeSessionId,
      input.requestConversationId,
      input.result.conversationId,
    ]
      .map((value) => value?.trim() ?? "")
      .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
    if (aliases.length === 0 && conversationId) {
      aliases.push(conversationId);
    }

    for (const sessionId of aliases) {
      deps.rememberConversationScope({
        sessionId,
        workspaceId,
        workspaceRoot,
        directory: directory || workspaceRoot,
        conversationId,
        opencodeSessionId,
      });
    }

    if (input.result.status === "submitted" || input.result.status === "queued") {
      const runId = input.result.status === "submitted" ? input.result.runId : input.result.reservedRunId;
      deps.rememberLatestConversationRunId({
        workspaceId,
        conversationId,
        opencodeSessionId,
        uiSessionId: input.requestOpencodeSessionId?.trim() || undefined,
        runId,
      });
      deps.rememberLatestConversationLifecycleRunId({
        workspaceId,
        conversationId,
        opencodeSessionId,
        uiSessionId: input.requestOpencodeSessionId?.trim() || undefined,
        runId,
      });
    }

    deps.recordSendTrace("submitConversationFromVesloWriteApi:conversation-scope-remembered", {
      ...(input.traceId ? { traceId: input.traceId } : {}),
      workspaceId,
      conversationId,
      opencodeSessionId,
      aliasCount: aliases.length,
      status: input.result.status,
    });
  };

  const conversationWorkspaceRegistrationCacheFor = (serverClient: Client) => {
    const key = serverClient as object;
    let cache = conversationWorkspaceRegistrationCacheByClient.get(key);
    if (!cache) {
      cache = new Map<string, ConversationWorkspaceRegistrationFlight>();
      conversationWorkspaceRegistrationCacheByClient.set(key, cache);
    }
    return cache;
  };

  const ensureConversationReadWorkspaceRegistered = async (
    serverClient: Client,
    workspaceIdRaw: string,
    directoryRaw?: string | null,
    options: {
      requireLiveOpencodeBaseUrl?: boolean;
      traceId?: string | null;
      caller?: "submit" | "read";
    } = {},
  ) => {
    const workspaceId = workspaceIdRaw.trim();
    const fallback = resolveConversationServerWorkspaceId(workspaceId);
    const requireLiveOpencodeBaseUrl = options.requireLiveOpencodeBaseUrl === true;
    if (!workspaceId) return "";

    const workspace = deps.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return fallback;

    const workspaceRootRaw = workspace.path?.trim() || workspace.directory?.trim() || "";
    const targetDirectoryRaw = directoryRaw?.trim() || workspaceRootRaw;
    const workspaceRoot = normalizeDirectoryPath(workspaceRootRaw);
    const targetDirectory = normalizeDirectoryPath(targetDirectoryRaw);
    if (!targetDirectory) return "";
    const matchDirectories = new Set([workspaceRoot, targetDirectory].filter(Boolean));

    const resolveLocalOpencodeRegistration = async () => {
      if (!deps.isTauriRuntime()) return null;
      try {
        const info = await deps.engineInfo(workspaceId, workspaceRootRaw || targetDirectoryRaw);
        const resolvedBaseUrl = normalizeBaseUrlForCompare(info.baseUrl);
        if (!resolvedBaseUrl) return null;
        return {
          baseUrl: resolvedBaseUrl,
          directory: info.projectDir?.trim() || targetDirectoryRaw || workspaceRootRaw,
          opencodeUsername: info.opencodeUsername?.trim() || null,
          opencodePassword: info.opencodePassword?.trim() || null,
        };
      } catch (error) {
        deps.wsDebug("conversation-read:engine-info:failed", {
          workspaceId,
          directory: targetDirectory,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        return null;
      }
    };

    const matchesRegistration = (
      entry: ConversationWorkspaceRegistryEntry,
      registration: Awaited<ReturnType<typeof resolveLocalOpencodeRegistration>>,
    ) => {
      if (!registration?.baseUrl) return !requireLiveOpencodeBaseUrl;
      const existingBaseUrl = normalizeBaseUrlForCompare(entry.baseUrl || entry.opencode?.baseUrl);
      const mountId = parseWorkspaceMountId(registration.baseUrl);
      if (mountId && entry.id !== mountId) return false;
      if (!existingBaseUrl) return !requireLiveOpencodeBaseUrl;
      return existingBaseUrl === registration.baseUrl;
    };

    const findMatchingWorkspace = (items: ConversationWorkspaceRegistryEntry[]) => {
      const match = items.find((entry) => {
        const candidates = [
          entry.path,
          entry.directory,
          entry.opencode?.directory,
        ]
          .map((value) => normalizeDirectoryPath(value?.trim() ?? ""))
          .filter(Boolean);
        return candidates.some((candidate) => matchDirectories.has(candidate));
      });
      return match ?? null;
    };

    const registrationCache = conversationWorkspaceRegistrationCacheFor(serverClient);
    const registrationCacheBaseKey = conversationWorkspaceCacheKey(workspaceId, targetDirectoryRaw);
    const liveRegistrationCacheKey = [registrationCacheBaseKey, "live-opencode"].join("\0");
    const readRegistrationCacheKey = [registrationCacheBaseKey, "read"].join("\0");
    const registrationCacheKey = requireLiveOpencodeBaseUrl
      ? liveRegistrationCacheKey
      : readRegistrationCacheKey;
    const traceId = options.traceId?.trim() || null;
    const caller = options.caller ?? (requireLiveOpencodeBaseUrl ? "submit" : "read");
    const recordRegistrationFlight = (
      action: "start" | "join" | "settle" | "reject",
      flightId: string,
    ) => {
      deps.recordSendTrace("conversation-workspace-registration:flight", {
        traceId,
        action,
        flightId,
        caller,
        scope: "app",
      });
    };

    if (!requireLiveOpencodeBaseUrl) {
      const liveRegistration = registrationCache.get(liveRegistrationCacheKey);
      if (liveRegistration) {
        recordRegistrationFlight("join", liveRegistration.id);
        try {
          const result = await liveRegistration.promise;
          if (result.cacheable && result.id) return result.id;
        } catch {
          // A failed live registration is not a read result. Fall through to a read registration.
        }
      }
    }

    const cachedRegistration = registrationCache.get(registrationCacheKey);
    if (cachedRegistration) {
      recordRegistrationFlight("join", cachedRegistration.id);
      return (await cachedRegistration.promise).id;
    }

    const registrationPromise = (async (): Promise<ConversationWorkspaceRegistrationResult> => {
      const opencodeRegistration = await resolveLocalOpencodeRegistration();
      if (requireLiveOpencodeBaseUrl && !opencodeRegistration?.baseUrl) {
        // OpenCode URLs are per-runtime; writes must not reuse stale registrations.
        deps.recordSendTrace("conversation-read:live-opencode-unavailable", {
          workspaceId,
          directory: targetDirectory,
        });
        return { id: "", cacheable: false };
      }

      const refreshClientAfterHostAuthFailure = async (
        error: unknown,
        stage: "list" | "register",
      ): Promise<Client | null> => {
        if (!isInvalidHostTokenError(error) || !deps.isTauriRuntime() || deps.startupPreference() === "server") {
          return null;
        }
        deps.recordSendTrace("conversation-workspace-registration:host-token-refresh:start", {
          workspaceId,
          directory: targetDirectory,
          stage,
        });
        // Local host tokens can rotate across sidecar respawns; refresh once before giving up.
        const ok = await deps.ensureLocalVesloServerRunning().catch((refreshError) => {
          deps.wsDebug("conversation-workspace-registration:host-token-refresh:failed", {
            workspaceId,
            directory: targetDirectory,
            stage,
            error: refreshError instanceof Error ? refreshError.message : safeStringify(refreshError),
          });
          return false;
        });
        const refreshedClient = ok ? deps.vesloServerClient() : null;
        const usable = refreshedClient && refreshedClient !== serverClient ? refreshedClient : null;
        deps.recordSendTrace("conversation-workspace-registration:host-token-refresh:end", {
          workspaceId,
          directory: targetDirectory,
          stage,
          ok,
          hasRefreshedClient: Boolean(usable),
          sameClient: Boolean(refreshedClient && refreshedClient === serverClient),
        });
        return usable;
      };

      const registerWithClient = async (
        activeClient: Client,
        allowHostAuthRefresh: boolean,
      ): Promise<ConversationWorkspaceRegistrationResult> => {
        try {
          const listed = await activeClient.listWorkspaces();
          const existing = findMatchingWorkspace(listed.items);
          if (existing && matchesRegistration(existing, opencodeRegistration)) {
            return { id: existing.id, cacheable: true };
          }
        } catch (error) {
          if (allowHostAuthRefresh) {
            const refreshedClient = await refreshClientAfterHostAuthFailure(error, "list");
            if (refreshedClient) return registerWithClient(refreshedClient, false);
          }
          deps.wsDebug("conversation-read:workspace-list:failed", {
            workspaceId,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
        }

        try {
          const added = await activeClient.addLocalWorkspace({
            path: workspaceRootRaw || targetDirectoryRaw,
            name: workspace.name?.trim() || undefined,
            baseUrl: opencodeRegistration?.baseUrl ?? undefined,
            directory: opencodeRegistration?.directory || targetDirectoryRaw,
            opencodeUsername: opencodeRegistration?.opencodeUsername ?? undefined,
            opencodePassword: opencodeRegistration?.opencodePassword ?? undefined,
          });
          const registered = findMatchingWorkspace(added.items);
          if (registered && matchesRegistration(registered, opencodeRegistration)) {
            return { id: registered.id, cacheable: true };
          }
        } catch (error) {
          if (allowHostAuthRefresh) {
            const refreshedClient = await refreshClientAfterHostAuthFailure(error, "register");
            if (refreshedClient) return registerWithClient(refreshedClient, false);
          }
          deps.wsDebug("conversation-read:workspace-register:failed", {
            workspaceId,
            directory: targetDirectory,
            hasBaseUrl: Boolean(opencodeRegistration?.baseUrl),
            error: error instanceof Error ? error.message : safeStringify(error),
          });
        }

        return { id: "", cacheable: false };
      };

      return await registerWithClient(serverClient, true);
    })();

    const flightId = "conversation-registration-" + String(++conversationWorkspaceRegistrationFlightSequence);
    const registrationFlight = { id: flightId, promise: registrationPromise };
    registrationCache.set(registrationCacheKey, registrationFlight);
    recordRegistrationFlight("start", flightId);
    try {
      const result = await registrationPromise;
      if (!result.cacheable && registrationCache.get(registrationCacheKey) === registrationFlight) {
        registrationCache.delete(registrationCacheKey);
      }
      recordRegistrationFlight("settle", flightId);
      return result.id;
    } catch (error) {
      if (registrationCache.get(registrationCacheKey) === registrationFlight) {
        registrationCache.delete(registrationCacheKey);
      }
      recordRegistrationFlight("reject", flightId);
      throw error;
    }
  };

  const resolveConversationServerWorkspaceForSend = async (
    workspaceId: string,
    directory: string,
    preflight: ConversationSendPreflightContext<Client> | undefined,
    reason: string,
  ): Promise<ConversationWorkspaceResolution<Client> | null> => {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedDirectory = directory.trim();
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    if (!normalizedWorkspaceId || !normalizedDirectory) {
      deps.recordSendTrace(`${reason}:conversation-workspace-skipped-empty`, {
        ...(tracePayload ?? {}),
        hasWorkspaceId: Boolean(normalizedWorkspaceId),
        hasDirectory: Boolean(normalizedDirectory),
      });
      return null;
    }

    const cacheKey = conversationWorkspaceCacheKey(normalizedWorkspaceId, normalizedDirectory);
    const conversationWorkspaceCache = preflight?.conversationWorkspaceByDirectory;
    const hasConversationWorkspaceCache = conversationWorkspaceCache instanceof Map;
    if (preflight && !hasConversationWorkspaceCache) {
      deps.recordSendTrace(`${reason}:conversation-preflight-contract:validation-failed`, {
        ...(tracePayload ?? {}),
        workspaceId: normalizedWorkspaceId,
        directory: normalizedDirectory,
        validator: "explicit-guard",
        schema: "conversation-send-preflight-context",
        ...conversationPreflightContractDiagnostics(preflight),
      });
    }
    const cached = hasConversationWorkspaceCache
      ? conversationWorkspaceCache.get(cacheKey)
      : undefined;
    if (cached) {
      deps.recordSendTrace(`${reason}:conversation-workspace-cache-hit`, {
        ...(tracePayload ?? {}),
        workspaceId: normalizedWorkspaceId,
        directory: normalizedDirectory,
      });
      return await cached;
    }

    const promise = deps.sendTraceStep(
      `${reason}:conversation-workspace-resolve`,
      async () => {
        const serverClient = await deps.sendTraceStep(
          `${reason}:resolve-passive-client`,
          () => resolvePassiveConversationReadClient({
            intent: "write-follow-up",
            reason,
            workspaceId: normalizedWorkspaceId,
            directory: normalizedDirectory,
          }),
          {
            ...(tracePayload ?? {}),
            vesloServerStatus: deps.vesloServerStatus(),
            hasCachedClient: Boolean(deps.vesloServerClient()),
          },
        );
        if (!serverClient) {
          deps.recordSendTrace(`${reason}:conversation-workspace-unavailable-client`, tracePayload);
          return null;
        }

        const serverWorkspaceId = await deps.sendTraceStep(
          `${reason}:ensure-workspace-registered`,
          () => ensureConversationReadWorkspaceRegistered(
            serverClient,
            normalizedWorkspaceId,
            normalizedDirectory,
            {
              requireLiveOpencodeBaseUrl: true,
              traceId: tracePayload?.traceId ?? null,
              caller: "submit",
            },
          ),
          {
            ...(tracePayload ?? {}),
            workspaceId: normalizedWorkspaceId,
            directory: normalizedDirectory,
          },
        );
        if (!serverWorkspaceId) {
          deps.recordSendTrace(`${reason}:conversation-workspace-unavailable-id`, {
            ...(tracePayload ?? {}),
            workspaceId: normalizedWorkspaceId,
            directory: normalizedDirectory,
          });
          return null;
        }

        deps.recordSendTrace(`${reason}:conversation-workspace-resolved`, {
          ...(tracePayload ?? {}),
          workspaceId: normalizedWorkspaceId,
          serverWorkspaceId,
          directory: normalizedDirectory,
        });
        // Host-token recovery can swap the memoized local client during registration.
        const resolvedServerClient = deps.vesloServerClient() ?? serverClient;
        return {
          serverClient: resolvedServerClient,
          serverWorkspaceId,
          workspaceId: normalizedWorkspaceId,
          directory: normalizedDirectory,
        };
      },
      {
        ...(tracePayload ?? {}),
        workspaceId: normalizedWorkspaceId,
        directory: normalizedDirectory,
      },
    );

    if (hasConversationWorkspaceCache) {
      conversationWorkspaceCache.set(cacheKey, promise);
    }
    return await promise;
  };

  const listConversationsFromVesloReadApi = async (
    workspaceId: string,
    directory?: string,
    options?: { sync?: boolean },
  ) => {
    const serverClient = await resolvePassiveConversationReadClient({
      intent: "browse-only",
      reason: "listConversationsFromVesloReadApi",
      workspaceId,
      directory,
    });
    if (!serverClient) {
      return { workspaceId, serverWorkspaceId: "", items: [], source: "unavailable" as const };
    }
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) {
      return { workspaceId, serverWorkspaceId: "", items: [], source: "unavailable" as const };
    }
    const result = await serverClient.listConversations(serverWorkspaceId, directory, {
      sync: options?.sync === true,
    });
    if (result.source === "unavailable") {
      deps.recordSendTrace("listConversationsFromVesloReadApi:unavailable", {
        workspaceId,
        serverWorkspaceId,
        directory: directory ?? null,
        sync: options?.sync === true,
        diagnostic: result.diagnostic ?? null,
      });
    }
    deps.rememberConversationScopesFromSessions(workspaceId, directory, result.items);
    return { ...result, serverWorkspaceId };
  };

  const backfillConversationsToVesloReadApi = async (
    workspaceId: string,
    directory: string,
    sessionsToImport: Session[],
  ) => {
    if (sessionsToImport.length === 0) return;
    const serverClient = await resolvePassiveConversationReadClient({
      intent: "write-follow-up",
      reason: "backfillConversationsToVesloReadApi",
      workspaceId,
      directory,
    });
    if (!serverClient) return;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return;
    const result = await serverClient.importConversations(serverWorkspaceId, {
      directory,
      sessions: sessionsToImport,
    });
    deps.rememberConversationScopesFromSessions(workspaceId, directory, result.items);
  };

  const getTranscriptFromVesloReadApi = async (
    workspaceId: string,
    sessionId: string,
    limit: number,
    directory?: string,
    options?: VesloSessionTranscriptReadOptions,
  ) => {
    const projectionCaller = options?.includeLatestRunArtifacts === true && options.caller
      ? options.caller
      : null;
    const projectionStartedAt = projectionCaller ? Date.now() : 0;
    const traceProjection = (event: "request" | "settle" | "error", payload?: Record<string, unknown>) => {
      if (!projectionCaller) return;
      deps.recordSendTrace(`session-transcript-projection:${event}`, {
        traceId: options?.sendTraceId?.trim() || null,
        caller: projectionCaller,
        displayLimit: limit,
        sourceLimit: TRANSCRIPT_PROJECTION_SOURCE_LIMIT,
        ...(payload ?? {}),
      });
    };
    traceProjection("request");
    try {
      const serverClient = await resolvePassiveConversationReadClient({
        intent: "live-read",
        reason: "getTranscriptFromVesloReadApi",
        workspaceId,
        directory,
      });
      if (!serverClient) {
        traceProjection("settle", {
          outcome: "unavailable",
          durationMs: Math.max(0, Date.now() - projectionStartedAt),
        });
        return null;
      }
      const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
      if (!serverWorkspaceId) {
        traceProjection("settle", {
          outcome: "unavailable",
          durationMs: Math.max(0, Date.now() - projectionStartedAt),
        });
        return null;
      }
      const snapshot = await serverClient.getSessionTranscript(serverWorkspaceId, sessionId, limit, directory, options);
      if (snapshot.source === "unavailable") {
        deps.recordSendTrace("getTranscriptFromVesloReadApi:unavailable", {
          workspaceId,
          serverWorkspaceId,
          sessionId,
          directory: directory ?? null,
          limit,
          diagnostic: snapshot.diagnostic ?? null,
        });
      }
      deps.rememberConversationScopeFromTranscript(workspaceId, directory, snapshot);
      traceProjection("settle", {
        outcome: snapshot.source === "unavailable" ? "unavailable" : "loaded",
        source: snapshot.source ?? "unknown",
        messageCount: snapshot.messages.length,
        durationMs: Math.max(0, Date.now() - projectionStartedAt),
      });
      return snapshot;
    } catch (error) {
      traceProjection("error", {
        errorType: error instanceof Error ? error.name : "unknown",
        durationMs: Math.max(0, Date.now() - projectionStartedAt),
      });
      throw error;
    }
  };

  const createConversationFromVesloWriteApi = async (
    workspaceId: string,
    directory: string,
    title?: string,
    preflight?: ConversationSendPreflightContext<Client>,
  ) => {
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    deps.recordSendTrace("createConversationFromVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      workspaceId,
      directory,
      hasTitle: Boolean(title?.trim()),
      ...conversationPreflightContractDiagnostics(preflight),
    });
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      preflight,
      "createConversationFromVesloWriteApi",
    );
    if (!resolution) {
      deps.recordSendTrace("createConversationFromVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    const result = await deps.sendTraceStep(
      "createConversationFromVesloWriteApi:create",
      () => resolution.serverClient.createConversation(resolution.serverWorkspaceId, {
        directory,
        title,
      }, {
        sendTraceId: preflight?.traceId ?? null,
      }),
      {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        directory,
      },
    );
    deps.rememberConversationScope({
      sessionId: result.id,
      workspaceId,
      workspaceRoot: deps.resolveWorkspaceRootForConversationScope(workspaceId, directory),
      directory,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    });
    return result;
  };

  const submitConversationFromVesloWriteApi = async (
    workspaceId: string,
    directory: string,
    input: VesloConversationSubmitRequest,
    preflight?: ConversationSendPreflightContext<Client>,
  ): Promise<VesloConversationSubmitResult | null> => {
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    deps.recordSendTrace("submitConversationFromVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      workspaceId,
      directory,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      hasConversationTarget: Boolean(input.target?.conversationId?.trim() || input.target?.opencodeSessionId?.trim()),
    });
    const managedProfile = deps.managedAiAccess();
    const expectAiGatewayStart = input.draft.mode === "prompt" && Boolean(managedProfile);
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      preflight,
      "submitConversationFromVesloWriteApi",
    );
    if (!resolution) {
      deps.recordSendTrace("submitConversationFromVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    if (expectAiGatewayStart && deps.ensureManagedAiRuntimeAuthorizationForSend) {
      const targetForRuntimeAuthorization = preflight?.targetWorkspace ?? null;
      const runtimeAuthorizationReady = await deps.sendTraceStep(
        "submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime",
        () => deps.ensureManagedAiRuntimeAuthorizationForSend!(targetForRuntimeAuthorization),
        {
          ...(tracePayload ?? {}),
          workspaceId,
          serverWorkspaceId: resolution.serverWorkspaceId,
          targetWorkspaceId: targetForRuntimeAuthorization?.workspaceId ?? null,
        },
      );
      const authPrimeDiagnostic = runtimeAuthorizationReady
        ? null
        : deps.managedAiRuntimeAuthorizationPrimeDiagnostic?.() ?? null;
      deps.recordSendTrace("submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result", {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        ready: runtimeAuthorizationReady,
        authPrimeDiagnosticReason: authPrimeDiagnostic?.reason ?? null,
        ...(authPrimeDiagnostic ? { authPrimeDiagnostic } : {}),
      });
      if (!runtimeAuthorizationReady) {
        throw new Error("Managed AI gateway authorization is not ready for this runtime.");
      }
    }
    const request: VesloConversationSubmitRequest = {
      ...input,
      target: {
        ...(input.target ?? {}),
        directory,
      },
      options: {
        ...(input.options ?? {}),
        ...(expectAiGatewayStart ? { expectAiGatewayStart: true } : {}),
      },
    };
    const result = await deps.sendTraceStep(
      "submitConversationFromVesloWriteApi:submit",
      () => resolution.serverClient.submitConversation(resolution.serverWorkspaceId, request, {
        sendTraceId: preflight?.traceId ?? null,
      }),
      {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        directory,
        clientMessageId: input.clientMessageId,
        origin: input.origin,
      },
    );
    if ("debugTrace" in result) {
      deps.recordExternalSendTraceEntries(result.debugTrace);
    }
    if (
      result.status === "materialized" ||
      result.status === "submitted" ||
      result.status === "queued"
    ) {
      const workspaceRoot = deps.resolveWorkspaceRootForConversationScope(workspaceId, directory);
      rememberConversationSubmitResultScope({
        workspaceId,
        workspaceRoot,
        directory,
        requestConversationId: input.target?.conversationId,
        requestOpencodeSessionId: input.target?.opencodeSessionId,
        requestPendingClientSessionId: input.target?.pendingClientSessionId,
        result,
        traceId: preflight?.traceId ?? null,
      });
    }
    return result;
  };

  const submitConversationRunViaVesloWriteApi = async (
    sessionId: string,
    input: VesloConversationRunInput,
    options: ConversationRunSubmitOptions<Client> = {},
  ): Promise<VesloConversationRunResult | null> => {
    const traceId = options.preflight?.traceId || options.sendTraceId?.trim() || deps.activeSendTraceId() || "";
    const tracePayload = traceId ? { traceId } : undefined;
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    const scope = deps.resolveSelectedSessionBrowseScope(normalizedSessionId);
    const targetWorkspace = options.targetWorkspace ?? options.preflight?.targetWorkspace ?? null;
    const managedProfile = deps.managedAiAccess();
    const expectAiGatewayStart = input.kind === "prompt_async" && Boolean(managedProfile);
    const scopeWorkspaceId = scope?.workspaceId?.trim() || "";
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() || "";
    const workspaceId = scopeWorkspaceId || targetWorkspaceId;
    if (!workspaceId) {
      deps.recordSendTrace("submitConversationRunViaVesloWriteApi:blocked-missing-workspace-scope", {
        ...(tracePayload ?? {}),
        ...conversationPreflightContractDiagnostics(options.preflight),
        sessionId: normalizedSessionId,
        kind: input.kind,
        scopeWorkspaceId: scopeWorkspaceId || null,
        targetWorkspaceId: targetWorkspaceId || null,
        hasConversationScope: Boolean(scope?.conversationId?.trim()),
      });
      throw new Error("Conversation run requires a scoped workspace.");
    }
    if (scopeWorkspaceId && targetWorkspaceId && scopeWorkspaceId !== targetWorkspaceId) {
      deps.recordSendTrace("submitConversationRunViaVesloWriteApi:blocked-workspace-scope-mismatch", {
        ...(tracePayload ?? {}),
        ...conversationPreflightContractDiagnostics(options.preflight),
        sessionId: normalizedSessionId,
        kind: input.kind,
        scopeWorkspaceId,
        targetWorkspaceId,
        scopeDirectory: scope?.directory?.trim() || null,
        targetDirectory: targetWorkspace?.directory?.trim() || null,
      });
      throw new Error("Conversation workspace does not match the send target workspace.");
    }
    const scopedDirectory = input.directory?.trim() || scope?.directory?.trim() || targetWorkspace?.directory?.trim() || "";
    const workspaceRoot =
      scope?.workspaceRoot?.trim() ||
      targetWorkspace?.workspaceRoot?.trim() ||
      deps.resolveWorkspaceRootForConversationScope(workspaceId, scopedDirectory) ||
      "";
    const directory = scopedDirectory || workspaceRoot;
    if (!directory) {
      deps.recordSendTrace("submitConversationRunViaVesloWriteApi:blocked-missing-directory", {
        ...(tracePayload ?? {}),
        ...conversationPreflightContractDiagnostics(options.preflight),
        sessionId: normalizedSessionId,
        workspaceId,
        kind: input.kind,
        scopeWorkspaceId: scopeWorkspaceId || null,
        targetWorkspaceId: targetWorkspaceId || null,
        scopedDirectory: scopedDirectory || null,
        workspaceRoot: workspaceRoot || null,
      });
      throw new Error("Conversation directory is required.");
    }

    deps.recordSendTrace("submitConversationRunViaVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      ...conversationPreflightContractDiagnostics(options.preflight),
      sessionId: normalizedSessionId,
      workspaceId,
      directory,
      kind: input.kind,
      clientMessageId: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
      origin: typeof input.origin === "string" ? input.origin : null,
      hasConversationScope: Boolean(scope?.conversationId),
      scopeWorkspaceId: scopeWorkspaceId || null,
      targetWorkspaceId: targetWorkspaceId || null,
      conversationId: scope?.conversationId?.trim() || null,
      opencodeSessionId: scope?.opencodeSessionId?.trim() || null,
      expectAiGatewayStart,
      managedProviderId: managedProfile?.providerId ?? null,
      managedModelId: managedProfile?.effectiveModel?.modelID ?? null,
      preflightManagedAiReady: options.preflight?.managedAiReady ?? null,
      preflightRuntimeHealthOk: options.preflight?.runtimeHealthOk ?? null,
    });
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      options.preflight,
      "submitConversationRunViaVesloWriteApi",
    );
    if (!resolution) {
      deps.recordSendTrace("submitConversationRunViaVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    if (expectAiGatewayStart && deps.ensureManagedAiRuntimeAuthorizationForSend) {
      const targetForRuntimeAuthorization = targetWorkspace ?? options.preflight?.targetWorkspace ?? null;
      const runtimeAuthorizationReady = await deps.sendTraceStep(
        "submitConversationRunViaVesloWriteApi:managed-ai-runtime-auth-prime",
        () => deps.ensureManagedAiRuntimeAuthorizationForSend!(targetForRuntimeAuthorization),
        {
          ...(tracePayload ?? {}),
          workspaceId,
          serverWorkspaceId: resolution.serverWorkspaceId,
          targetWorkspaceId: targetForRuntimeAuthorization?.workspaceId ?? null,
        },
      );
      const authPrimeDiagnostic = runtimeAuthorizationReady
        ? null
        : deps.managedAiRuntimeAuthorizationPrimeDiagnostic?.() ?? null;
      deps.recordSendTrace("submitConversationRunViaVesloWriteApi:managed-ai-runtime-auth-prime:result", {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        ready: runtimeAuthorizationReady,
        authPrimeDiagnosticReason: authPrimeDiagnostic?.reason ?? null,
        ...(authPrimeDiagnostic ? { authPrimeDiagnostic } : {}),
      });
      if (!runtimeAuthorizationReady) {
        throw new Error("Managed AI gateway authorization is not ready for this runtime.");
      }
    }
    const conversationId = scope?.conversationId?.trim() || normalizedSessionId;
    const result = await deps.sendTraceStep(
      "submitConversationRunViaVesloWriteApi:run",
      () => resolution.serverClient.runConversation(
        resolution.serverWorkspaceId,
        conversationId,
        {
          ...input,
          directory,
          ...(expectAiGatewayStart ? { expectAiGatewayStart: true } : {}),
        },
        {
          sendTraceId: traceId || undefined,
        },
      ),
      {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        conversationId,
        kind: input.kind,
      },
    );
    deps.recordExternalSendTraceEntries(result.debugTrace);
    const resolvedWorkspaceRoot = deps.resolveWorkspaceRootForConversationScope(workspaceId, directory);
    const rememberRunConversationScope = (sessionId: string) => {
      const id = sessionId.trim();
      if (!id) return;
      deps.rememberConversationScope({
        sessionId: id,
        workspaceId,
        workspaceRoot: resolvedWorkspaceRoot,
        directory,
        conversationId: result.conversationId,
        opencodeSessionId: result.opencodeSessionId,
      });
    };
    const opencodeSessionId = result.opencodeSessionId?.trim() || "";
    rememberRunConversationScope(opencodeSessionId || normalizedSessionId);
    if (normalizedSessionId && normalizedSessionId !== opencodeSessionId) {
      rememberRunConversationScope(normalizedSessionId);
    }
    const abortRunId = result.status === "submitted"
      ? result.runId
      : result.activeRunId?.trim() || result.reservedRunId;
    deps.rememberLatestConversationRunId({
      workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      uiSessionId: normalizedSessionId,
      runId: abortRunId,
    });
    const lifecycleRunId = result.status === "submitted"
      ? result.runId
      : result.reservedRunId;
    deps.rememberLatestConversationLifecycleRunId({
      workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      uiSessionId: normalizedSessionId,
      runId: lifecycleRunId,
    });
    return result;
  };

  const resolveConversationAbortScope = (
    sessionId: string,
    target?: ConversationAbortTarget,
  ) => {
    const normalizedSessionId = sessionId.trim();
    const existingScope = deps.resolveSelectedSessionBrowseScope(normalizedSessionId);
    const workspaceId = target?.workspaceId?.trim() || existingScope?.workspaceId?.trim() || deps.activeWorkspaceId().trim();
    const directory =
      target?.directory?.trim() ||
      existingScope?.directory?.trim() ||
      deps.sessionDirectoryOverrideById()[normalizedSessionId]?.trim() ||
      "";
    const workspaceRoot =
      target?.workspaceRoot?.trim() ||
      existingScope?.workspaceRoot?.trim() ||
      deps.resolveWorkspaceRootForConversationScope(workspaceId, directory) ||
      deps.activeWorkspaceRoot().trim();
    const targetConversationId = target?.conversationId?.trim() || "";
    const targetOpenCodeSessionId = target?.opencodeSessionId?.trim() || "";
    const existingConversationId = existingScope?.conversationId?.trim() || "";
    const existingOpenCodeSessionId = existingScope?.opencodeSessionId?.trim() || "";
    const sessionOrConversationId =
      targetConversationId ||
      existingConversationId ||
      targetOpenCodeSessionId ||
      existingOpenCodeSessionId ||
      normalizedSessionId;
    return {
      sessionId: normalizedSessionId,
      workspaceId,
      workspaceRoot,
      directory: directory || workspaceRoot,
      hasConversationScope: Boolean(
        targetConversationId ||
        existingConversationId ||
        targetOpenCodeSessionId ||
        existingOpenCodeSessionId
      ),
      conversationId: sessionOrConversationId,
      opencodeSessionId: targetOpenCodeSessionId || existingOpenCodeSessionId || normalizedSessionId,
    };
  };

  const abortConversationFromVesloWriteApi = async (
    sessionId: string,
    target?: ConversationAbortTarget,
  ) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    const scope = resolveConversationAbortScope(normalizedSessionId, target);
    const workspaceId = scope.workspaceId;
    if (!workspaceId) {
      throw new Error("Workspace id is required for conversation abort.");
    }
    const directory = scope.directory;
    if (!directory) {
      throw new Error("Conversation directory is required.");
    }
    const conversationId = scope.conversationId || normalizedSessionId;
    const runId = deps.resolveLatestConversationRunId({
      workspaceId,
      conversationId,
      opencodeSessionId: scope.opencodeSessionId,
      uiSessionId: normalizedSessionId,
    });

    const serverClient = await resolvePassiveConversationReadClient({
      intent: "write-control",
      reason: "abortConversationFromVesloWriteApi",
      workspaceId,
      directory,
    });
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return null;
    deps.recordSendTrace("abortConversation:request", {
      sessionID: normalizedSessionId,
      workspaceId,
      serverWorkspaceId,
      conversationId,
      opencodeSessionId: scope?.opencodeSessionId ?? null,
      runId: runId || null,
      mode: runId ? "run" : "active",
    });
    const result = await serverClient.abortConversation(serverWorkspaceId, conversationId, {
      directory,
      ...(runId ? { runId } : { mode: "active" as const }),
    });
    deps.recordSendTrace("abortConversation:success", {
      sessionID: normalizedSessionId,
      workspaceId,
      serverWorkspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      runId: result.runId,
      status: result.status,
    });
    deps.rememberConversationScope({
      sessionId: result.opencodeSessionId || normalizedSessionId,
      workspaceId,
      workspaceRoot: scope.workspaceRoot || deps.resolveWorkspaceRootForConversationScope(workspaceId, directory),
      directory,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    });
    return result;
  };

  const resolveConversationRunForSession = (
    sessionId: string,
    workspaceIdHint?: string | null,
    options?: { allowLatest?: boolean },
  ) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;
    const scope = deps.resolveSelectedSessionBrowseScope(normalizedSessionId);
    if (options?.allowLatest && (!scope?.workspaceId?.trim() || !scope.conversationId?.trim())) {
      deps.recordSendTrace("resolveConversationRunForSession:latest-missing-scope", {
        sessionId: normalizedSessionId,
        workspaceIdHint: workspaceIdHint?.trim() || null,
      });
      return null;
    }
    const workspaceId =
      scope?.workspaceId?.trim() ||
      workspaceIdHint?.trim() ||
      deps.activeWorkspaceId().trim();
    if (!workspaceId) return null;
    const workspaceRoot =
      scope?.workspaceRoot?.trim() ||
      deps.resolveWorkspaceRootForConversationScope(workspaceId, scope?.directory) ||
      deps.activeWorkspaceRoot().trim();
    const directory =
      scope?.directory?.trim() ||
      deps.sessionDirectoryOverrideById()[normalizedSessionId]?.trim() ||
      workspaceRoot;
    const conversationId = scope?.conversationId?.trim() || normalizedSessionId;
    const opencodeSessionId = scope?.opencodeSessionId?.trim() || normalizedSessionId;
    const runId = deps.resolveLatestConversationLifecycleRunId({
      workspaceId,
      conversationId,
      opencodeSessionId,
      uiSessionId: normalizedSessionId,
    }) || deps.resolveLatestConversationRunId({
      workspaceId,
      conversationId,
      opencodeSessionId,
      uiSessionId: normalizedSessionId,
    });
    const exactBrowseScope = Boolean(
      scope?.workspaceId?.trim() &&
      scope.conversationId?.trim(),
    );
    if (!runId && !(options?.allowLatest && exactBrowseScope)) return null;
    return {
      sessionId: normalizedSessionId,
      workspaceId,
      conversationId,
      opencodeSessionId,
      directory,
      runId: runId || "latest",
    };
  };

  const readConversationRunStatus = async (scope: {
    workspaceId: string;
    directory?: string | null;
    conversationId: string;
    opencodeSessionId?: string | null;
    sessionId?: string | null;
    runId: string;
    clientMessageId?: string | null;
  }) => {
    const serverClient = await resolvePassiveConversationReadClient({
      intent: "status-poll",
      reason: "readConversationRunStatus",
      workspaceId: scope.workspaceId,
      directory: scope.directory,
    });
    const tracePayload = {
      workspaceId: scope.workspaceId,
      directory: scope.directory?.trim() || null,
      conversationId: scope.conversationId,
      runId: scope.runId,
    };
    if (!serverClient) {
      deps.recordSendTrace("readConversationRunStatus:unavailable", {
        ...tracePayload,
        reason: "no-server-client",
      });
      return null;
    }
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(
      serverClient,
      scope.workspaceId,
      scope.directory,
    );
    if (!serverWorkspaceId) {
      deps.recordSendTrace("readConversationRunStatus:unavailable", {
        ...tracePayload,
        reason: "workspace-registration-unavailable",
      });
      return null;
    }
    try {
      const result = await serverClient.getConversationRunStatus(
        serverWorkspaceId,
        scope.conversationId,
        scope.runId,
      );
      if (scope.runId === "latest" && result.runId?.trim()) {
        deps.rememberLatestConversationLifecycleRunId({
          workspaceId: scope.workspaceId,
          conversationId: scope.conversationId,
          opencodeSessionId: scope.opencodeSessionId,
          uiSessionId: scope.sessionId,
          runId: result.runId,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof VesloServerError && error.status === 404) {
        deps.recordSendTrace("readConversationRunStatus:not-found", {
          ...tracePayload,
          serverWorkspaceId,
          status: error.status,
          code: error.code,
          message: error.message,
        });
        return null;
      }
      throw error;
    }
  };

  const recoverConversationTranscript = async (scope: {
    workspaceId: string;
    sessionId: string;
    directory?: string | null;
    expectedRunId?: string | null;
    diagnosticTraceId?: string | null;
  }) => {
    const workspaceId = scope.workspaceId.trim();
    const sessionId = scope.sessionId.trim();
    const directory = scope.directory?.trim() || undefined;
    if (!workspaceId || !sessionId) return null;
    const serverClient = deps.vesloServerClient();
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return null;
    const recovery = await serverClient.recoverSessionTranscript(serverWorkspaceId, sessionId, {
      directory,
      expectedRunId: scope.expectedRunId?.trim() || undefined,
    });
    if (recovery.state === "persisted" || recovery.state === "unchanged") {
      return getTranscriptFromVesloReadApi(workspaceId, sessionId, 140, directory, {
        includeLatestRunArtifacts: true,
        caller: "terminal-recovery",
        sendTraceId: scope.diagnosticTraceId,
      });
    }
    return null;
  };

  const recoverAcceptedConversationTranscript = async (scope: {
    workspaceId: string;
    directory?: string | null;
    conversationId: string;
    opencodeSessionId?: string | null;
    sessionId: string;
    runId: string;
    clientMessageId?: string | null;
    diagnosticTraceId?: string | null;
  }) => {
    const sessionId = scope.opencodeSessionId?.trim() || scope.sessionId.trim();
    if (!sessionId) return null;
    const recoverExactTranscript = () => recoverConversationTranscript({
      workspaceId: scope.workspaceId,
      sessionId,
      directory: scope.directory,
      expectedRunId: scope.runId,
      diagnosticTraceId: scope.diagnosticTraceId,
    });

    // A terminal status already obtained by the lifecycle owner is sufficient
    // for the normal transcript path. Do not re-ensure a healthy local server
    // for every completed answer; use foreground recovery only when no client
    // is available or the direct transcript read proves that the remembered
    // client is stale.
    const recoverAfterEnsure = async () => {
      const status = await recoverAcceptedConversationRunStatus(scope);
      if (!status || status.stale || !["completed", "failed", "aborted"].includes(status.status)) return null;
      return recoverExactTranscript();
    };
    if (!deps.vesloServerClient()) return recoverAfterEnsure();
    try {
      return await recoverExactTranscript();
    } catch (error) {
      deps.recordSendTrace("accepted-run-transcript-recovery:direct-read-error", {
        workspaceId: scope.workspaceId.trim(),
        conversationId: scope.conversationId.trim(),
        runId: scope.runId.trim(),
        clientMessageId: scope.clientMessageId?.trim() || null,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return recoverAfterEnsure();
    }
  };

  const recoverAcceptedConversationRunStatus = async (scope: {
    workspaceId: string;
    directory?: string | null;
    conversationId: string;
    opencodeSessionId?: string | null;
    sessionId?: string | null;
    runId: string;
    clientMessageId?: string | null;
  }) => {
    const workspaceId = scope.workspaceId.trim();
    const conversationId = scope.conversationId.trim();
    const runId = scope.runId.trim();
    if (!workspaceId || !conversationId || !runId) return null;

    // A client object is only a remembered URL/auth pair. Foreground recovery
    // must revalidate the owned local server even when that stale client still
    // exists, otherwise a red server loops in passive transport failures.
    const hadClientBeforeEnsure = Boolean(deps.vesloServerClient());
    deps.recordSendTrace("accepted-run-status-recovery:server-only-ensure-started", {
      workspaceId,
      conversationId,
      runId,
      clientMessageId: scope.clientMessageId?.trim() || null,
      hadClientBeforeEnsure,
    });
    const ensured = await deps.ensureLocalVesloServerRunning({
      requireRuntimeChainReady: false,
    }).catch(() => false);
    if (!ensured || !deps.vesloServerClient()) {
      deps.recordSendTrace("accepted-run-status-recovery:server-only-ensure-failed", {
        workspaceId,
        conversationId,
        runId,
        clientMessageId: scope.clientMessageId?.trim() || null,
        hadClientBeforeEnsure,
      });
      return null;
    }

    const status = await readConversationRunStatus({
      workspaceId,
      directory: scope.directory,
      conversationId,
      opencodeSessionId: scope.opencodeSessionId,
      sessionId: scope.sessionId,
      runId,
      clientMessageId: scope.clientMessageId,
    });
    if (!status) {
      deps.recordSendTrace("accepted-run-status-recovery:refreshed-status-unavailable", {
        workspaceId,
        conversationId,
        runId,
        clientMessageId: scope.clientMessageId?.trim() || null,
      });
    }
    return status;
  };

  return {
    vesloServerClient: deps.vesloServerClient,
    resolveConversationServerWorkspaceId,
    resolvePassiveConversationReadClient,
    ensureConversationReadWorkspaceRegistered,
    resolveConversationServerWorkspaceForSend,
    listConversationsFromVesloReadApi,
    backfillConversationsToVesloReadApi,
    getTranscriptFromVesloReadApi,
    createConversationFromVesloWriteApi,
    submitConversationFromVesloWriteApi,
    submitConversationRunViaVesloWriteApi,
    resolveConversationAbortScope,
    abortConversationFromVesloWriteApi,
    resolveConversationRunForSession,
    readConversationRunStatus,
    recoverAcceptedConversationRunStatus,
    recoverConversationTranscript,
    recoverAcceptedConversationTranscript,
  };
}
