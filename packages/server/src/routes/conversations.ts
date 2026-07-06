import type { ConversationService, ConversationTranscriptResult } from "../conversation-service.js";
import type { ConversationRunLifecycleController } from "../conversation-run-lifecycle-controller.js";
import type { ConversationSubmitService } from "../conversation-submit-service.js";
import { ApiError } from "../errors.js";
import {
  OrchestratorLifecycleRequestError,
  type OrchestratorLifecycleClient,
} from "../orchestrator-lifecycle-client.js";
import { addRoute, type Route } from "../routing.js";
import {
  ensureWritable,
  jsonResponse,
  readJsonBody,
  readOptionalJsonBody,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import {
  deriveLatestRunArtifactsResponse,
  type SessionArtifactMessage,
  type SessionArtifactPart,
} from "../session-artifacts.js";
import type { WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";

const SESSION_TRANSCRIPT_DEFAULT_LIMIT = 140;
const SESSION_TRANSCRIPT_MAX_LIMIT = 200;

export type ConversationRunKind = "prompt_async" | "command" | "shell" | "summarize";

export type ConversationRunTracer = {
  entries: Array<Record<string, unknown>>;
  traceId: string | null;
  record(event: string, payload?: Record<string, unknown>): void;
  step<T>(event: string, fn: () => Promise<T>, payload?: Record<string, unknown>): Promise<T>;
};

export type ConversationExecutionTarget = {
  directory: string;
  binding?: unknown | null;
  opencodeSessionId: string;
  conversationId: string;
};

type SessionTranscriptPrefetchPort = {
  updateInterest(input: {
    workspaceId: string;
    clickedSessionId?: string | null;
    selectedSessionId?: string | null;
    loadedTopLevelSessionIds: string[];
    expandedSubagentSessionIds: string[];
    directory?: string | null;
    sessionDirectoriesById?: Record<string, string | null | undefined>;
    limit?: number;
  }): Promise<unknown>;
  invalidate(input: { workspaceId: string; sessionId: string; directory?: string | null }): void;
};

type ResolveConversationReadDirectory = (
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
) => Promise<string | null>;

type LoadConversationTranscriptResponse = (input: {
  workspace: WorkspaceInfo;
  sessionOrConversationId: string;
  limit: number;
  directory: string | null;
}) => Promise<ConversationTranscriptResult>;

type ResolveConversationExecutionTarget = (input: {
  workspace: WorkspaceInfo;
  sessionOrConversationId: string;
  requestedDirectory: string | undefined;
  missingDirectoryMessage: string;
}) => Promise<ConversationExecutionTarget>;

export type ConversationSessionRouteDependencies = {
  conversationService: ConversationService;
  sessionTranscriptPrefetch: SessionTranscriptPrefetchPort;
  conversationRunLifecycleController: ConversationRunLifecycleController;
  conversationSubmitService: ConversationSubmitService;
  lifecycleClient: OrchestratorLifecycleClient | null;
  resolveConversationReadDirectory: ResolveConversationReadDirectory;
  loadConversationTranscriptResponse: LoadConversationTranscriptResponse;
  createConversationRunTracer(request: Request): ConversationRunTracer;
  resolveConversationExecutionTarget: ResolveConversationExecutionTarget;
  deleteOpenCodeSession(input: { workspace: WorkspaceInfo; sessionId: string }): Promise<unknown>;
  recordSendWorkflowTrace(source: "server", event: string, payload: Record<string, unknown>): void;
};

function optionalBodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBodyNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (body[field] === null) return null;
  return optionalBodyString(body, field);
}

function optionalBodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === "boolean" ? value : undefined;
}

function parseSessionTranscriptLimit(input: unknown): number {
  const parsed =
    typeof input === "number" && Number.isFinite(input)
      ? input
      : typeof input === "string"
        ? Number(input)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return SESSION_TRANSCRIPT_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), SESSION_TRANSCRIPT_MAX_LIMIT);
}

function parseSessionTranscriptMessages(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "messages must be an array");
  }
  return input;
}

function parseSessionTranscriptParts(input: unknown): Record<string, unknown[]> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "partsByMessageId must be an object");
  }
  const partsByMessageId: Record<string, unknown[]> = {};
  for (const [messageId, parts] of Object.entries(input as Record<string, unknown>)) {
    const id = messageId.trim();
    if (!id) continue;
    if (!Array.isArray(parts)) {
      throw new ApiError(400, "invalid_payload", "partsByMessageId values must be arrays");
    }
    partsByMessageId[id] = parts;
  }
  return partsByMessageId;
}

function parseTranscriptStringArray(input: unknown, field: string): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", `${field} must be an array`);
  }
  return input
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function parseSessionTranscriptDeletedParts(input: unknown): Record<string, string[]> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "deletedPartsByMessageId must be an object");
  }
  const deletedPartsByMessageId: Record<string, string[]> = {};
  for (const [messageId, partIds] of Object.entries(input as Record<string, unknown>)) {
    const id = messageId.trim();
    if (!id) continue;
    const parsed = parseTranscriptStringArray(partIds, "deletedPartsByMessageId values");
    if (parsed.length > 0) deletedPartsByMessageId[id] = parsed;
  }
  return deletedPartsByMessageId;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTranscriptMessageInfo(message: unknown): Record<string, unknown> | null {
  if (!isRecordLike(message)) return null;
  return isRecordLike(message.info) ? message.info : message;
}

function readTranscriptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveTranscriptNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function transcriptAssistantMessageIsTerminal(info: Record<string, unknown>): boolean {
  const time = isRecordLike(info.time) ? info.time : null;
  if (time && readPositiveTranscriptNumber(time.completed) !== null) return true;
  if (isRecordLike(info.error)) return true;
  if (readTranscriptString(info.finish)) return true;
  return false;
}

function transcriptLatestAssistantLooksTerminal(messages: unknown[]): boolean {
  if (messages.length === 0) return false;
  const latestInfo = readTranscriptMessageInfo(messages[messages.length - 1]);
  if (!latestInfo) return false;
  if (readTranscriptString(latestInfo.role) !== "assistant") return false;
  return transcriptAssistantMessageIsTerminal(latestInfo);
}

function transcriptReasonSignalsIdle(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return normalized.includes("session.idle") || normalized.includes("session.error");
}

function shouldReconcileLifecycleAfterTranscriptAppend(messages: unknown[], reason: string): boolean {
  return transcriptReasonSignalsIdle(reason) || transcriptLatestAssistantLooksTerminal(messages);
}

function resolveTranscriptMessageIdForArtifacts(message: Record<string, unknown>): string {
  const direct = typeof message.id === "string" ? message.id.trim() : "";
  if (direct) return direct;
  const info = isRecordLike(message.info) ? message.info : null;
  return typeof info?.id === "string" ? info.id.trim() : "";
}

function attachTranscriptPartsForArtifacts(
  messages: unknown[],
  partsByMessageId: Record<string, unknown[]>,
): SessionArtifactMessage[] {
  const result: SessionArtifactMessage[] = [];
  for (const rawMessage of messages) {
    if (!isRecordLike(rawMessage)) continue;
    const messageId = resolveTranscriptMessageIdForArtifacts(rawMessage);
    const persistedParts = messageId ? partsByMessageId[messageId] ?? [] : [];
    const inlineParts = Array.isArray(rawMessage.parts) ? rawMessage.parts : [];
    const parts = (persistedParts.length > 0 ? persistedParts : inlineParts)
      .filter(isRecordLike) as SessionArtifactPart[];
    result.push({
      ...rawMessage,
      parts,
    });
  }
  return result;
}

function parseSessionIdArray(input: unknown, fieldName: string): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", `${fieldName} must be an array`);
  }

  const ids: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_payload", `${fieldName} entries must be strings`);
    }
    const normalized = value.trim();
    if (!normalized) continue;
    ids.push(normalized);
  }
  return ids;
}

function parseOptionalSessionId(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim();
  return normalized ? normalized : undefined;
}

function parseSessionDirectoryMap(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "sessionDirectoriesById must be an object");
  }

  const result: Record<string, string> = {};
  for (const [sessionIdRaw, directoryRaw] of Object.entries(input as Record<string, unknown>)) {
    const sessionId = sessionIdRaw.trim();
    if (!sessionId) continue;
    if (typeof directoryRaw !== "string") {
      throw new ApiError(400, "invalid_payload", "sessionDirectoriesById entries must be strings");
    }
    const directory = directoryRaw.trim();
    if (!directory) continue;
    result[sessionId] = directory;
  }
  return result;
}

function parseConversationRunKind(input: unknown): ConversationRunKind {
  const kind = typeof input === "string" ? input.trim() : "";
  if (kind === "prompt" || kind === "prompt_async") return "prompt_async";
  if (kind === "command" || kind === "shell" || kind === "summarize") return kind;
  throw new ApiError(400, "invalid_payload", "kind must be prompt_async, command, shell, or summarize");
}

function lifecycleRequestApiError(error: OrchestratorLifecycleRequestError): ApiError {
  const status = error.status === 401 || error.status === 403
    ? 503
    : error.status === 404
      ? 404
      : error.status === 501
        ? 501
        : 503;
  const code = status === 404
    ? "lifecycle_not_found"
    : status === 501
      ? "lifecycle_unsupported"
      : "lifecycle_unavailable";
  return new ApiError(status, code, "Run lifecycle owner is unavailable", {
    upstreamStatus: error.status,
    path: error.path,
    body: error.body,
  });
}

function isVesloConversationId(input: string): boolean {
  return /^conv-[0-9a-f]{20}$/i.test(input.trim());
}

export function registerConversationSessionRoutes(
  routes: Route[],
  dependencies: ConversationSessionRouteDependencies,
): void {
  const {
    conversationService,
    sessionTranscriptPrefetch,
    conversationRunLifecycleController,
    conversationSubmitService,
    lifecycleClient,
    resolveConversationReadDirectory,
    loadConversationTranscriptResponse,
    createConversationRunTracer,
    resolveConversationExecutionTarget,
    deleteOpenCodeSession,
    recordSendWorkflowTrace,
  } = dependencies;

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    await deleteOpenCodeSession({ workspace, sessionId });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/conversations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await conversationService.listConversations({
      workspace,
      directory,
      sync: ctx.url.searchParams.get("sync") === "true" || ctx.url.searchParams.get("sync") === "1",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const sendTraceId = ctx.request.headers.get("x-veslo-send-trace-id")?.trim() || null;
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    const startedAt = Date.now();
    recordSendWorkflowTrace("server", "server:conversation-create:start", {
      traceId: sendTraceId,
      workspaceId: workspace.id,
      directory,
      hasTitle: Boolean(optionalBodyNullableString(body, "title")?.trim()),
    });
    try {
      const result = await conversationService.createConversation({
        workspace,
        directory,
        title: optionalBodyNullableString(body, "title") ?? null,
        sendTraceId,
      });
      recordSendWorkflowTrace("server", "server:conversation-create:done", {
        traceId: sendTraceId,
        workspaceId: workspace.id,
        directory,
        conversationId: result.conversationId,
        opencodeSessionId: result.opencodeSessionId,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(result, 201);
    } catch (error) {
      recordSendWorkflowTrace("server", "server:conversation-create:error", {
        traceId: sendTraceId,
        workspaceId: workspace.id,
        directory,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/submit", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const result = await conversationSubmitService.dryRun({
      workspace,
      body,
      resolveDirectory: (requestedRaw) => resolveConversationReadDirectory(workspace, requestedRaw),
    });
    return jsonResponse(result.payload, result.httpStatus);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/import", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const rawSessions = body.sessions;
    if (!Array.isArray(rawSessions)) {
      throw new ApiError(400, "invalid_payload", "sessions must be an array");
    }
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    const sessions = rawSessions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ApiError(400, "invalid_payload", "sessions must contain objects");
      }
      const record = item as Record<string, unknown>;
      const time = record.time && typeof record.time === "object" && !Array.isArray(record.time)
        ? record.time as Record<string, unknown>
        : null;
      return {
        id: typeof record.id === "string" ? record.id : "",
        title: typeof record.title === "string" ? record.title : null,
        parentID: typeof record.parentID === "string" ? record.parentID : null,
        time: {
          created: typeof time?.created === "number" ? time.created : null,
          updated: typeof time?.updated === "number" ? time.updated : null,
        },
      };
    });
    const result = await conversationService.importOpenCodeSessions({
      workspace,
      directory,
      sessions,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/conversations/:conversationId/transcript", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const conversationId = (ctx.params.conversationId ?? "").trim();
    if (!conversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const limit = parseSessionTranscriptLimit(ctx.url.searchParams.get("limit"));
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: conversationId,
      limit,
      directory,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/:conversationId/runs", "client", async (ctx) => {
    const runTrace = createConversationRunTracer(ctx.request);
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    runTrace.record("server:conversation-run:start", {
      workspaceId: ctx.params.id,
      conversationId: ctx.params.conversationId,
    });
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionOrConversationId = (ctx.params.conversationId ?? "").trim();
    if (!sessionOrConversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const body = await readJsonBody(ctx.request);
    const kind = parseConversationRunKind(body.kind);
    const clientMessageId = optionalBodyString(body, "clientMessageId") || optionalBodyString(body, "messageID");
    const origin = optionalBodyString(body, "origin");
    const expectAiGatewayStart = optionalBodyBoolean(body, "expectAiGatewayStart") === true;
    runTrace.record("server:conversation-run:payload", {
      workspaceId: workspace.id,
      conversationId: sessionOrConversationId,
      kind,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      expectAiGatewayStart,
    });
    const target = await runTrace.step(
      "server:conversation-run:resolve-target",
      () => resolveConversationExecutionTarget({
        workspace,
        sessionOrConversationId,
        requestedDirectory: optionalBodyString(body, "directory"),
        missingDirectoryMessage: "Conversation run directory is required",
      }),
      {
        workspaceId: workspace.id,
        workspaceType: workspace.workspaceType,
        kind,
      },
    );
    const runId = shortId();
    const result = await conversationRunLifecycleController.submitRun({
      runTrace,
      workspace,
      target,
      runId,
      kind,
      body,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      expectAiGatewayStart,
    });
    return jsonResponse(result.payload, result.httpStatus);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/:conversationId/abort", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionOrConversationId = (ctx.params.conversationId ?? "").trim();
    if (!sessionOrConversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const body = await readJsonBody(ctx.request);
    const target = await resolveConversationExecutionTarget({
      workspace,
      sessionOrConversationId,
      requestedDirectory: optionalBodyString(body, "directory"),
      missingDirectoryMessage: "Conversation abort directory is required",
    });
    let runId = optionalBodyString(body, "runId");
    if (!runId) {
      if (!lifecycleClient) {
        throw new ApiError(503, "lifecycle_unavailable", "Run lifecycle owner is not configured");
      }
      let activeRun;
      try {
        activeRun = await lifecycleClient.active(workspace.id, target.conversationId);
      } catch (error) {
        if (error instanceof OrchestratorLifecycleRequestError) {
          throw lifecycleRequestApiError(error);
        }
        throw error;
      }
      if (!activeRun) {
        throw new ApiError(404, "active_run_not_found", "No active run was found for this conversation");
      }
      runId = activeRun.runId;
    }
    recordSendWorkflowTrace("server", "server:conversation-abort:start", {
      traceId: null,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      runId,
      opencodeSessionId: target.opencodeSessionId,
      sessionOrConversationId,
    });
    const { upstream, abortedGatewayRequestCount } = await conversationRunLifecycleController.abortRun({
      workspace,
      target,
      runId,
    });
    recordSendWorkflowTrace("server", "server:conversation-abort:done", {
      traceId: null,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      runId,
      opencodeSessionId: target.opencodeSessionId,
      abortedGatewayRequestCount,
      upstreamStatus: typeof upstream === "object" && upstream && "status" in upstream ? upstream.status : null,
    });
    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      opencodeSessionId: target.opencodeSessionId,
      runId,
      status: "submitted",
      kind: "abort",
      upstream,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/conversations/:conversationId/runs/:runId", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const conversationId = (ctx.params.conversationId ?? "").trim();
    const runId = (ctx.params.runId ?? "").trim();
    if (!conversationId || !runId) {
      throw new ApiError(400, "invalid_payload", "conversationId and runId are required");
    }
    if (!lifecycleClient) {
      throw new ApiError(503, "lifecycle_unavailable", "Run lifecycle owner is not configured");
    }
    let status;
    try {
      status = await lifecycleClient.status(workspace.id, conversationId, runId);
    } catch (error) {
      if (error instanceof OrchestratorLifecycleRequestError) {
        throw lifecycleRequestApiError(error);
      }
      throw error;
    }
    if (!status) {
      throw new ApiError(404, "run_not_found", "Run was not found for this conversation");
    }
    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      conversationId,
      runId: status.runId,
      status: status.status,
      stale: status.stale,
      activityKind: status.activityKind ?? null,
      waitReason: status.waitReason ?? null,
      lastUsefulProgressAt: status.lastUsefulProgressAt ?? null,
      retrySince: status.retrySince ?? null,
      noProgressSeconds: status.noProgressSeconds ?? null,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/transcript-prefetch", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const payload = body as Record<string, unknown>;
    const clickedSessionId = parseOptionalSessionId(payload.clickedSessionId);
    const selectedSessionId = parseOptionalSessionId(payload.selectedSessionId);
    const loadedTopLevelSessionIds = parseSessionIdArray(payload.loadedTopLevelSessionIds, "loadedTopLevelSessionIds");
    const expandedSubagentSessionIds = parseSessionIdArray(
      payload.expandedSubagentSessionIds,
      "expandedSubagentSessionIds",
    );
    const limit = parseSessionTranscriptLimit(body.limit);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(payload, "directory") ?? null,
    );
    const rawSessionDirectoriesById = parseSessionDirectoryMap(payload.sessionDirectoriesById);
    const sessionDirectoriesById: Record<string, string> = {};
    for (const [sessionId, sessionDirectory] of Object.entries(rawSessionDirectoriesById)) {
      const resolvedSessionDirectory = await resolveConversationReadDirectory(workspace, sessionDirectory);
      if (!resolvedSessionDirectory) {
        throw new ApiError(400, "invalid_directory", "Session directory is required");
      }
      sessionDirectoriesById[sessionId] = resolvedSessionDirectory;
    }
    const result = await sessionTranscriptPrefetch.updateInterest({
      workspaceId: workspace.id,
      clickedSessionId,
      selectedSessionId,
      loadedTopLevelSessionIds,
      expandedSubagentSessionIds,
      directory,
      sessionDirectoriesById,
      limit,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/transcript", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const body = await readJsonBody(ctx.request);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    if (!directory) {
      throw new ApiError(400, "invalid_directory", "Conversation directory is required");
    }
    const binding = await conversationService.resolveOpenCodeSessionForRead({
      workspaceId: workspace.id,
      directory,
      sessionOrConversationId: sessionId,
    });
    if (!binding && isVesloConversationId(sessionId)) {
      throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
    }

    const messages = parseSessionTranscriptMessages(body.messages);
    const partsByMessageId = parseSessionTranscriptParts(body.partsByMessageId);
    const reason = optionalBodyString(body, "reason") ?? "";
    const result = await conversationService.appendTranscript({
      workspace,
      sessionId,
      directory,
      limit: parseSessionTranscriptLimit(body.limit),
      messages,
      partsByMessageId,
      deletedMessageIds: parseTranscriptStringArray(body.deletedMessageIds, "deletedMessageIds"),
      deletedPartsByMessageId: parseSessionTranscriptDeletedParts(body.deletedPartsByMessageId),
    });
    sessionTranscriptPrefetch.invalidate({
      workspaceId: workspace.id,
      sessionId: result.opencodeSessionId,
      directory,
    });
    if (result.conversationId) {
      sessionTranscriptPrefetch.invalidate({
        workspaceId: workspace.id,
        sessionId: result.conversationId,
        directory,
      });
    }
    void conversationRunLifecycleController.handleTranscriptAppend({
      workspace,
      conversationId: result.conversationId ?? binding?.conversationId ?? sessionId,
      sessionId: result.opencodeSessionId,
      reason,
      shouldReconcile: shouldReconcileLifecycleAfterTranscriptAppend(messages, reason),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/transcript", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const limit = parseSessionTranscriptLimit(ctx.url.searchParams.get("limit"));
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: sessionId,
      limit,
      directory,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/artifacts/latest-run", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const transcript = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: sessionId,
      limit: SESSION_TRANSCRIPT_MAX_LIMIT,
      directory,
    });
    const messages = attachTranscriptPartsForArtifacts(
      transcript.messages,
      transcript.partsByMessageId,
    );

    return jsonResponse(
      deriveLatestRunArtifactsResponse({
        sessionId: transcript.opencodeSessionId,
        workspaceId: workspace.id,
        messages,
      }, { workspaceRoot: directory ?? workspace.path }),
    );
  });
}
