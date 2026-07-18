import {
  conversationSubmitDraftIsEmpty,
  createConversationSubmitRequestHash,
  parseConversationSubmitRequest,
  type ConversationSubmitBlockedResult,
  type ConversationSubmitDebugTraceEntry,
  type ConversationSubmitFailedResult,
  type ConversationSubmitRequest,
  type ConversationSubmitQueuedResult,
  type ConversationSubmitResolvedRunInput,
  type ConversationSubmitResult,
  type ConversationSubmitSubmittedResult,
} from "./conversation-submit-contract.js";
import type {
  ConversationSubmitAttempt,
  ConversationSubmitAttemptStore,
} from "./conversation-submit-attempt-store.js";
import { deriveConversationSubmitOpenCodeSessionId } from "./conversation-submit-attempt-store.js";
import {
  resolveConversationSubmitDraft,
  type ConversationSubmitDocumentRuntimeStatusReader,
  type ConversationSubmitModelDescriptorResolver,
  type ConversationSubmitSkillCommandResolver,
} from "./conversation-submit-draft-resolution.js";
import type { ConversationService } from "./conversation-service.js";
import type { ConversationRunQueueItem } from "./conversation-run-queue-store.js";
import { ApiError } from "./errors.js";
import type { OrchestratorWorkspaceRegistrationScope } from "./orchestrator-workspace-registration-scope.js";
import type { WorkspaceInfo } from "./types.js";

export type ConversationSubmitService = {
  submit(input: {
    workspace: WorkspaceInfo;
    body: Record<string, unknown>;
    sendTraceId?: string | null;
    orchestratorRegistrationScope?: OrchestratorWorkspaceRegistrationScope | null;
    runtimeAuthorizationActorTokenHash?: string | null;
    runtimeAuthorizationOrgId?: string | null;
    resolveManagedAiModelDescriptor?: ConversationSubmitModelDescriptorResolver;
    resolveDirectory: (requestedRaw: string | null) => Promise<string | null>;
    submitResolvedRun?: ConversationSubmitResolvedRunSubmitter | null;
  }): Promise<ConversationSubmitServiceResponse>;
};

export type ConversationSubmitServiceResponse = {
  payload: ConversationSubmitResult;
  httpStatus: number;
};

export type ConversationSubmitResolvedRunSubmitter = (input: {
  workspace: WorkspaceInfo;
  request: ConversationSubmitRequest;
  resolvedRunInput: ConversationSubmitResolvedRunInput;
  directory: string | null;
  sendTraceId?: string | null;
  orchestratorRegistrationScope?: OrchestratorWorkspaceRegistrationScope | null;
  runtimeAuthorizationActorTokenHash?: string | null;
  runtimeAuthorizationOrgId?: string | null;
}) => Promise<{
  payload:
    | ConversationSubmitSubmittedResult
    | ConversationSubmitQueuedResult
    | ConversationSubmitBlockedResult
    | ConversationSubmitFailedResult;
  httpStatus: number;
}>;

export type ConversationSubmitQueueStatusReader = (
  payload: ConversationSubmitQueuedResult,
) => ConversationRunQueueItem | null;

export function createConversationSubmitService(input: {
  attemptStore: ConversationSubmitAttemptStore;
  conversationService: ConversationService;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
  queueStatusReader?: ConversationSubmitQueueStatusReader;
}): ConversationSubmitService {
  const {
    attemptStore,
    conversationService,
    documentRuntimeStatus,
    resolveSkillCommand,
    queueStatusReader,
  } = input;
  const inFlightSubmitAttempts = new Map<string, Promise<ConversationSubmitServiceResponse>>();

  return {
    async submit({
      workspace,
      body,
      sendTraceId,
      orchestratorRegistrationScope,
      runtimeAuthorizationActorTokenHash,
      runtimeAuthorizationOrgId,
      resolveManagedAiModelDescriptor,
      resolveDirectory,
      submitResolvedRun,
    }) {
      let request = parseConversationSubmitRequest(body);
      const requestHash = createConversationSubmitRequestHash(request);
      const claimed = attemptStore.claim({
        workspaceId: workspace.id,
        clientMessageId: request.clientMessageId,
        requestHash,
      });
      if (claimed.conflict) {
        throw new ApiError(409, "idempotency_conflict", "clientMessageId was already used for a different submit request", {
          workspaceId: workspace.id,
          clientMessageId: request.clientMessageId,
        });
      }
      request = conversationSubmitRequestWithAttemptTarget(request, claimed.attempt);

      const completeAttempt = (
        payload: ConversationSubmitResult,
        status: "materialized" | "completed" | "blocked" | "failed",
      ) => {
        attemptStore.update({
          workspaceId: workspace.id,
          clientMessageId: request.clientMessageId,
          status,
          conversationId:
            "conversationId" in payload && typeof payload.conversationId === "string"
              ? payload.conversationId
              : request.target?.conversationId ?? null,
          opencodeSessionId:
            "opencodeSessionId" in payload && typeof payload.opencodeSessionId === "string"
              ? payload.opencodeSessionId
              : request.target?.opencodeSessionId ?? null,
          runId:
            "runId" in payload && typeof payload.runId === "string"
              ? payload.runId
              : "reservedRunId" in payload && typeof payload.reservedRunId === "string"
                ? payload.reservedRunId
                : null,
          queueItemId:
            "queueItemId" in payload && typeof payload.queueItemId === "string"
              ? payload.queueItemId
              : null,
          resultJson: JSON.stringify(payload),
        });
        return payload;
      };

      const withMaterializedSession = <T extends ConversationSubmitBlockedResult | ConversationSubmitFailedResult>(
        payload: T,
        materializedSession: Awaited<ReturnType<typeof conversationService.createConversation>>,
      ): T => ({
        ...payload,
        workspaceId: workspace.id,
        conversationId: materializedSession.conversationId,
        opencodeSessionId: materializedSession.opencodeSessionId,
        clientMessageId: request.clientMessageId,
        pendingClientSessionId: request.target?.pendingClientSessionId ?? null,
        materializedSession,
      });

      const withExistingTarget = <T extends ConversationSubmitBlockedResult | ConversationSubmitFailedResult>(
        payload: T,
      ): T => ({
        ...payload,
        workspaceId: workspace.id,
        ...(request.target?.conversationId ? { conversationId: request.target.conversationId } : {}),
        ...(request.target?.opencodeSessionId ? { opencodeSessionId: request.target.opencodeSessionId } : {}),
        clientMessageId: request.clientMessageId,
        pendingClientSessionId: request.target?.pendingClientSessionId ?? null,
      });

      if (claimed.attempt.resultJson) {
        try {
          const replayPayload = JSON.parse(claimed.attempt.resultJson) as ConversationSubmitResult;
          const terminalQueueFailure = resolveQueuedReplayFailure(replayPayload, queueStatusReader);
          if (terminalQueueFailure) {
            return {
              payload: terminalQueueFailure,
              httpStatus: 200,
            };
          }
          if (conversationSubmitResultIsReplayable(replayPayload)) {
            return {
              payload: replayPayload,
              httpStatus: 200,
            };
          }
          request = conversationSubmitRequestWithAttemptTarget(request, claimed.attempt);
        } catch {
          // Fall through and rebuild the result from the current request.
          request = conversationSubmitRequestWithAttemptTarget(request, claimed.attempt);
        }
      }

      const inFlightKey = conversationSubmitInFlightKey(workspace.id, request.clientMessageId, requestHash);
      const existingInFlight = inFlightSubmitAttempts.get(inFlightKey);
      if (existingInFlight) return await existingInFlight;

      // The persisted store owns completed retry/conflict behavior; this
      // joins same-process overlap before resultJson exists.
      const inFlight = (async (): Promise<ConversationSubmitServiceResponse> => {
      if (conversationSubmitDraftIsEmpty(request)) {
        return {
          payload: completeAttempt({
            status: "blocked",
            code: "empty_draft",
            message: "Submit draft is empty",
            draftDisposition: "keep",
            recoverable: true,
          }, "blocked"),
          httpStatus: 200,
        };
      }

      if (workspace.workspaceType === "remote") {
        return {
          payload: completeAttempt({
            status: "blocked",
            code: "remote_submit_unavailable",
            message: "Server-owned submit is not available for remote workspaces yet",
            draftDisposition: "restore",
            recoverable: true,
          }, "blocked"),
          httpStatus: 200,
        };
      }

      const debugTrace: ConversationSubmitDebugTraceEntry[] = [];
      const draftResolution = await resolveConversationSubmitDraft({
        request,
        recordDebugTrace: (entry) => {
          debugTrace.push(entry);
        },
        workspace,
        includeGlobal: workspace.workspaceType === "local",
        ...(documentRuntimeStatus ? { documentRuntimeStatus } : {}),
        ...(resolveSkillCommand ? { resolveSkillCommand } : {}),
        ...(resolveManagedAiModelDescriptor ? { resolveManagedAiModelDescriptor } : {}),
      });
      if (draftResolution.status === "blocked") {
        return {
          payload: completeAttempt(draftResolution.result, "blocked"),
          httpStatus: 200,
        };
      }

      const directory = await resolveDirectory(request.target?.directory ?? null);
      const hasExistingTarget = Boolean(
        request.target?.conversationId?.trim() || request.target?.opencodeSessionId?.trim(),
      );
      if (draftResolution.resolvedRunInput.kind === "summarize" && !hasExistingTarget) {
        return {
          payload: completeAttempt({
            status: "blocked",
            code: "compact_target_required",
            message: "Select a session with messages before running /compact.",
            draftDisposition: "restore",
            recoverable: true,
          }, "blocked"),
          httpStatus: 200,
        };
      }
      if (request.options?.dryRun === true) {
        const payload: ConversationSubmitResult = {
          status: "dry_run",
          workspaceId: workspace.id,
          clientMessageId: request.clientMessageId,
          requestHash,
          draftDisposition: "keep",
          resolvedRunInput: draftResolution.resolvedRunInput,
          target: {
            directory,
            conversationId: request.target?.conversationId ?? null,
            opencodeSessionId: request.target?.opencodeSessionId ?? null,
            pendingClientSessionId: request.target?.pendingClientSessionId ?? null,
          },
          ...(debugTrace.length ? { debugTrace } : {}),
        };
        return {
          payload: completeAttempt(payload, "completed"),
          httpStatus: 200,
        };
      }

      if (hasExistingTarget) {
        if (submitResolvedRun) {
          try {
            const result = await submitResolvedRun({
              workspace,
              request,
              resolvedRunInput: draftResolution.resolvedRunInput,
              directory,
              sendTraceId: sendTraceId ?? null,
              orchestratorRegistrationScope: orchestratorRegistrationScope ?? null,
              runtimeAuthorizationActorTokenHash: runtimeAuthorizationActorTokenHash ?? null,
              runtimeAuthorizationOrgId: runtimeAuthorizationOrgId ?? null,
            });
            if (result.payload.status === "blocked" || result.payload.status === "failed") {
              const payload = result.payload.status === "failed"
                ? withSubmitResolutionDebugTrace(result.payload, debugTrace)
                : result.payload;
              return {
                payload: completeAttempt(
                  payload,
                  payload.status === "blocked" ? "blocked" : "failed",
                ),
                httpStatus: result.httpStatus,
              };
            }
            const payload = withSubmitResolutionDebugTrace(result.payload, debugTrace);
            return {
              payload: completeAttempt(payload, "completed"),
              httpStatus: result.httpStatus,
            };
          } catch (error) {
            const payload: ConversationSubmitResult = withSubmitResolutionDebugTrace(withExistingTarget({
              status: "failed",
              code: error instanceof ApiError ? error.code : "run_submit_failed",
              message: error instanceof Error ? error.message : "Run submit failed",
              draftDisposition: "restore",
              debugTrace: [{
                source: "server",
                event: "run_submit_failed",
                upstreamCode: error instanceof ApiError ? error.code : null,
                upstreamStatus: error instanceof ApiError ? error.status : null,
              }],
            }), debugTrace);
            return {
              payload: completeAttempt(payload, "failed"),
              httpStatus: 200,
            };
          }
        }
        return {
          payload: completeAttempt(withExistingTarget({
            status: "blocked",
            code: "run_submit_unavailable",
            message: "Server-owned run submit is not available yet",
            draftDisposition: "restore",
            recoverable: true,
          }), "blocked"),
          httpStatus: 200,
        };
      }

      try {
        const requestedOpenCodeSessionId = claimed.attempt.opencodeSessionId ??
          deriveConversationSubmitOpenCodeSessionId({
            workspaceId: workspace.id,
            clientMessageId: request.clientMessageId,
          });
        attemptStore.update({
          workspaceId: workspace.id,
          clientMessageId: request.clientMessageId,
          status: "materializing",
          opencodeSessionId: requestedOpenCodeSessionId,
        });
        const materializedSession = await conversationService.createConversation({
          workspace,
          directory,
          title: deriveSubmitConversationTitle(request),
          requestedOpenCodeSessionId,
          sendTraceId: sendTraceId ?? null,
          orchestratorRegistrationScope: orchestratorRegistrationScope ?? null,
        });
        attemptStore.update({
          workspaceId: workspace.id,
          clientMessageId: request.clientMessageId,
          status: "materialized",
          conversationId: materializedSession.conversationId,
          opencodeSessionId: materializedSession.opencodeSessionId,
        });
        if (submitResolvedRun) {
          const materializedRequest: ConversationSubmitRequest = {
            ...request,
            target: {
              ...request.target,
              directory,
              conversationId: materializedSession.conversationId,
              opencodeSessionId: materializedSession.opencodeSessionId,
            },
          };
          try {
            const result = await submitResolvedRun({
              workspace,
              request: materializedRequest,
              resolvedRunInput: draftResolution.resolvedRunInput,
              directory,
              sendTraceId: sendTraceId ?? null,
              orchestratorRegistrationScope: orchestratorRegistrationScope ?? null,
              runtimeAuthorizationActorTokenHash: runtimeAuthorizationActorTokenHash ?? null,
              runtimeAuthorizationOrgId: runtimeAuthorizationOrgId ?? null,
            });
            if (result.payload.status === "blocked" || result.payload.status === "failed") {
              const resultPayload = result.payload.status === "failed"
                ? withSubmitResolutionDebugTrace(result.payload, debugTrace)
                : result.payload;
              const materializedPayload = withMaterializedSession(resultPayload, materializedSession);
              return {
                payload: completeAttempt(
                  materializedPayload,
                  result.payload.status === "blocked" ? "blocked" : "failed",
                ),
                httpStatus: result.httpStatus,
              };
            }
            const resultPayload = withSubmitResolutionDebugTrace(result.payload, debugTrace);
            return {
              payload: completeAttempt({
                ...resultPayload,
                materializedSession,
              }, "completed"),
              httpStatus: result.httpStatus,
            };
          } catch (error) {
            const payload: ConversationSubmitResult = withSubmitResolutionDebugTrace(withMaterializedSession({
              status: "failed",
              code: error instanceof ApiError ? error.code : "run_submit_failed",
              message: error instanceof Error ? error.message : "Run submit failed",
              draftDisposition: "restore",
              debugTrace: [{
                source: "server",
                event: "run_submit_failed_after_materialization",
                upstreamCode: error instanceof ApiError ? error.code : null,
                upstreamStatus: error instanceof ApiError ? error.status : null,
              }],
            }, materializedSession), debugTrace);
            return {
              payload: completeAttempt(payload, "failed"),
              httpStatus: 200,
            };
          }
        }
        const payload: ConversationSubmitResult = {
          status: "materialized",
          workspaceId: workspace.id,
          conversationId: materializedSession.conversationId,
          opencodeSessionId: materializedSession.opencodeSessionId,
          clientMessageId: request.clientMessageId,
          pendingClientSessionId: request.target?.pendingClientSessionId ?? null,
          materializedSession,
          draftDisposition: "keep",
        };
        return {
          payload: completeAttempt(payload, "materialized"),
          httpStatus: 200,
        };
      } catch (error) {
        const payload: ConversationSubmitResult = withSubmitResolutionDebugTrace({
          status: "failed",
          code: "conversation_create_failed",
          message: error instanceof Error ? error.message : "Conversation creation failed",
          draftDisposition: "restore",
          debugTrace: [{
            source: "server",
            event: "conversation_create_failed",
            upstreamCode: error instanceof ApiError ? error.code : null,
            upstreamStatus: error instanceof ApiError ? error.status : null,
          }],
        }, debugTrace);
        return {
          payload: completeAttempt(payload, "failed"),
          httpStatus: 200,
        };
      }
      })();
      inFlightSubmitAttempts.set(inFlightKey, inFlight);
      try {
        return await inFlight;
      } finally {
        if (inFlightSubmitAttempts.get(inFlightKey) === inFlight) {
          inFlightSubmitAttempts.delete(inFlightKey);
        }
      }
    },
  };
}

function conversationSubmitInFlightKey(workspaceId: string, clientMessageId: string, requestHash: string): string {
  return JSON.stringify([workspaceId, clientMessageId, requestHash]);
}

function conversationSubmitResultIsReplayable(payload: ConversationSubmitResult): boolean {
  return payload.status !== "blocked" && payload.status !== "failed";
}

type ConversationSubmitDebugTracePayload =
  | ConversationSubmitSubmittedResult
  | ConversationSubmitQueuedResult
  | ConversationSubmitFailedResult;

function withSubmitResolutionDebugTrace<T extends ConversationSubmitDebugTracePayload>(
  payload: T,
  debugTrace: ConversationSubmitDebugTraceEntry[],
): T {
  if (!debugTrace.length) return payload;
  return {
    ...payload,
    debugTrace: [...debugTrace, ...(payload.debugTrace ?? [])],
  };
}

function resolveQueuedReplayFailure(
  payload: ConversationSubmitResult,
  queueStatusReader: ConversationSubmitQueueStatusReader | undefined,
): ConversationSubmitFailedResult | null {
  if (!queueStatusReader || payload.status !== "queued") return null;
  const queueItem = queueStatusReader(payload);
  if (!queueItem || queueItem.state !== "failed") return null;
  return {
    status: "failed",
    code: "queued_run_failed",
    message: queueItem.error?.trim() || "Queued run failed",
    workspaceId: payload.workspaceId,
    conversationId: payload.conversationId,
    opencodeSessionId: payload.opencodeSessionId,
    queueItemId: queueItem.queueItemId,
    reservedRunId: queueItem.reservedRunId,
    clientMessageId: payload.clientMessageId,
    draftDisposition: "restore",
    debugTrace: [{
      source: "server",
      event: "queued_run_failed",
      queueItemId: queueItem.queueItemId,
      queueState: queueItem.state,
    }],
  };
}

function conversationSubmitRequestWithAttemptTarget(
  request: ConversationSubmitRequest,
  attempt: ConversationSubmitAttempt,
): ConversationSubmitRequest {
  if (!attempt.conversationId || !attempt.opencodeSessionId) return request;
  if (request.target?.conversationId?.trim() || request.target?.opencodeSessionId?.trim()) return request;
  return {
    ...request,
    target: {
      ...request.target,
      conversationId: attempt.conversationId,
      opencodeSessionId: attempt.opencodeSessionId,
    },
  };
}

function deriveSubmitConversationTitle(request: ConversationSubmitRequest): string | null {
  const text = request.draft.text.trim() || request.draft.resolvedText?.trim() || "";
  if (text) return text.slice(0, 160);
  if (request.draft.command) {
    const commandText = `/${request.draft.command.name} ${request.draft.command.arguments}`.trim();
    return commandText.slice(0, 160);
  }
  return null;
}
