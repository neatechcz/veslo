import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  parseVesloWorkspaceIdFromUrl,
  VesloServerError,
  type VesloConversationAbortInput,
  type VesloConversationAbortResult,
  type VesloConversationCreateResult,
  type VesloConversationRunInput,
  type VesloConversationRunResult,
  type VesloConversationRunStatusResult,
  type VesloSessionTranscriptAppendInput,
  type VesloSessionTranscriptSnapshot,
} from "../lib/veslo-server";
import { normalizeDirectoryPath, safeStringify } from "../utils";
import type { StartupPreference } from "../types";
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
  ) => Promise<VesloSessionTranscriptSnapshot>;
  createConversation: (
    workspaceId: string,
    input?: { directory?: string | null; title?: string | null },
    options?: { sendTraceId?: string | null },
  ) => Promise<VesloConversationCreateResult>;
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
  appendSessionTranscript: (
    workspaceId: string,
    sessionId: string,
    input: VesloSessionTranscriptAppendInput,
  ) => Promise<VesloSessionTranscriptSnapshot>;
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

export type ConversationServiceRunOptions<Client extends ConversationServiceClient = ConversationServiceClient> = {
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
  defaultModel?: {
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
  ensureLocalVesloServerRunning: () => Promise<boolean>;
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

export function createConversationService<Client extends ConversationServiceClient>(
  deps: ConversationServiceDeps<Client>,
) {
  const conversationWorkspaceRegistrationCacheByClient = new WeakMap<
    object,
    Map<string, Promise<{ id: string; cacheable: boolean }>>
  >();

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
    policy?.intent === "write-follow-up" || policy?.intent === "write-control";

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

    if (deps.isTauriRuntime() && deps.startupPreference() !== "server" && deps.vesloServerStatus() === "disconnected") {
      await deps.ensureLocalVesloServerRunning().catch((error) => {
        deps.wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = deps.vesloServerClient();
    }
    if (serverClient) return serverClient;

    if (deps.isTauriRuntime()) {
      await deps.ensureLocalVesloServerRunning().catch((error) => {
        deps.wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = deps.vesloServerClient();
    }

    return serverClient;
  };

  const conversationWorkspaceRegistrationCacheFor = (serverClient: Client) => {
    const key = serverClient as object;
    let cache = conversationWorkspaceRegistrationCacheByClient.get(key);
    if (!cache) {
      cache = new Map<string, Promise<{ id: string; cacheable: boolean }>>();
      conversationWorkspaceRegistrationCacheByClient.set(key, cache);
    }
    return cache;
  };

  const ensureConversationReadWorkspaceRegistered = async (
    serverClient: Client,
    workspaceIdRaw: string,
    directoryRaw?: string | null,
  ) => {
    const workspaceId = workspaceIdRaw.trim();
    const fallback = resolveConversationServerWorkspaceId(workspaceId);
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
      if (!registration?.baseUrl) return true;
      const existingBaseUrl = normalizeBaseUrlForCompare(entry.baseUrl || entry.opencode?.baseUrl);
      const mountId = parseWorkspaceMountId(registration.baseUrl);
      if (mountId && entry.id !== mountId) return false;
      if (!existingBaseUrl) return true;
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
    const registrationCacheKey = conversationWorkspaceCacheKey(workspaceId, targetDirectoryRaw);
    const cachedRegistration = registrationCache.get(registrationCacheKey);
    if (cachedRegistration) {
      return (await cachedRegistration).id;
    }

    const registrationPromise = (async (): Promise<{ id: string; cacheable: boolean }> => {
      const opencodeRegistration = await resolveLocalOpencodeRegistration();

      try {
        const listed = await serverClient.listWorkspaces();
        const existing = findMatchingWorkspace(listed.items);
        if (existing && matchesRegistration(existing, opencodeRegistration)) {
          return { id: existing.id, cacheable: true };
        }
      } catch (error) {
        deps.wsDebug("conversation-read:workspace-list:failed", {
          workspaceId,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      }

      try {
        const added = await serverClient.addLocalWorkspace({
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
        deps.wsDebug("conversation-read:workspace-register:failed", {
          workspaceId,
          directory: targetDirectory,
          hasBaseUrl: Boolean(opencodeRegistration?.baseUrl),
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      }

      return { id: "", cacheable: false };
    })();

    registrationCache.set(registrationCacheKey, registrationPromise);
    try {
      const result = await registrationPromise;
      if (!result.cacheable && registrationCache.get(registrationCacheKey) === registrationPromise) {
        registrationCache.delete(registrationCacheKey);
      }
      return result.id;
    } catch (error) {
      if (registrationCache.get(registrationCacheKey) === registrationPromise) {
        registrationCache.delete(registrationCacheKey);
      }
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
    const cached = preflight?.conversationWorkspaceByDirectory.get(cacheKey);
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
        return {
          serverClient,
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

    preflight?.conversationWorkspaceByDirectory.set(cacheKey, promise);
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
  ) => {
    const serverClient = await resolvePassiveConversationReadClient({
      intent: "live-read",
      reason: "getTranscriptFromVesloReadApi",
      workspaceId,
      directory,
    });
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return null;
    const snapshot = await serverClient.getSessionTranscript(serverWorkspaceId, sessionId, limit, directory);
    deps.rememberConversationScopeFromTranscript(workspaceId, directory, snapshot);
    return snapshot;
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

  const runConversationFromVesloWriteApi = async (
    sessionId: string,
    input: VesloConversationRunInput,
    options: ConversationServiceRunOptions<Client> = {},
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
      deps.recordSendTrace("runConversationFromVesloWriteApi:blocked-missing-workspace-scope", {
        ...(tracePayload ?? {}),
        sessionId: normalizedSessionId,
        kind: input.kind,
      });
      throw new Error("Conversation run requires a scoped workspace.");
    }
    if (scopeWorkspaceId && targetWorkspaceId && scopeWorkspaceId !== targetWorkspaceId) {
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
      throw new Error("Conversation directory is required.");
    }

    deps.recordSendTrace("runConversationFromVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      sessionId: normalizedSessionId,
      workspaceId,
      directory,
      kind: input.kind,
      clientMessageId: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
      origin: typeof input.origin === "string" ? input.origin : null,
      hasConversationScope: Boolean(scope?.conversationId),
      expectAiGatewayStart,
      managedProviderId: managedProfile?.providerId ?? null,
      managedModelId: managedProfile?.defaultModel?.modelID ?? null,
      preflightManagedAiReady: options.preflight?.managedAiReady ?? null,
      preflightRuntimeHealthOk: options.preflight?.runtimeHealthOk ?? null,
    });
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      options.preflight,
      "runConversationFromVesloWriteApi",
    );
    if (!resolution) {
      deps.recordSendTrace("runConversationFromVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    const conversationId = scope?.conversationId?.trim() || normalizedSessionId;
    const result = await deps.sendTraceStep(
      "runConversationFromVesloWriteApi:run",
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
    return {
      sessionId: normalizedSessionId,
      workspaceId,
      workspaceRoot,
      directory: directory || workspaceRoot,
      hasConversationScope: Boolean(target?.conversationId?.trim() || existingScope?.conversationId?.trim()),
      conversationId: target?.conversationId?.trim() || existingScope?.conversationId?.trim() || normalizedSessionId,
      opencodeSessionId: target?.opencodeSessionId?.trim() || existingScope?.opencodeSessionId?.trim() || normalizedSessionId,
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

  const resolveConversationRunForSession = (sessionId: string, workspaceIdHint?: string | null) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;
    const scope = deps.resolveSelectedSessionBrowseScope(normalizedSessionId);
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
    if (!runId) return null;
    return {
      sessionId: normalizedSessionId,
      workspaceId,
      conversationId,
      opencodeSessionId,
      directory,
      runId,
    };
  };

  const readConversationRunStatus = async (scope: {
    workspaceId: string;
    directory?: string | null;
    conversationId: string;
    runId: string;
  }) => {
    const serverClient = await resolvePassiveConversationReadClient({
      intent: "status-poll",
      reason: "readConversationRunStatus",
      workspaceId: scope.workspaceId,
      directory: scope.directory,
    });
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(
      serverClient,
      scope.workspaceId,
      scope.directory,
    );
    if (!serverWorkspaceId) return null;
    try {
      return await serverClient.getConversationRunStatus(
        serverWorkspaceId,
        scope.conversationId,
        scope.runId,
      );
    } catch (error) {
      if (error instanceof VesloServerError && error.status === 404) return null;
      throw error;
    }
  };

  const appendTranscriptSnapshot = async (input: {
    workspaceId: string;
    sessionId: string;
    directory?: string | null;
    limit?: number;
    reason?: string;
    messages: VesloSessionTranscriptAppendInput["messages"];
    partsByMessageId: VesloSessionTranscriptAppendInput["partsByMessageId"];
    deletedMessageIds?: string[];
    deletedPartsByMessageId?: Record<string, string[]>;
  }) => {
    const workspaceId = input.workspaceId.trim();
    const sessionId = input.sessionId.trim();
    const directory = input.directory?.trim() || undefined;
    if (!workspaceId || !sessionId) return;
    const serverClient = deps.vesloServerClient();
    if (!serverClient) return;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return;
    await serverClient.appendSessionTranscript(serverWorkspaceId, sessionId, {
      directory,
      limit: input.limit,
      reason: input.reason,
      messages: input.messages,
      partsByMessageId: input.partsByMessageId,
      deletedMessageIds: input.deletedMessageIds,
      deletedPartsByMessageId: input.deletedPartsByMessageId,
    });
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
    runConversationFromVesloWriteApi,
    resolveConversationAbortScope,
    abortConversationFromVesloWriteApi,
    resolveConversationRunForSession,
    readConversationRunStatus,
    appendTranscriptSnapshot,
  };
}
