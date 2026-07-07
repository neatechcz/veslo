import {
  conversationSubmitDraftIsEmpty,
  createConversationSubmitRequestHash,
  parseConversationSubmitRequest,
  type ConversationSubmitBlockedResult,
  type ConversationSubmitFailedResult,
  type ConversationSubmitRequest,
  type ConversationSubmitQueuedResult,
  type ConversationSubmitResolvedRunInput,
  type ConversationSubmitResult,
  type ConversationSubmitSubmittedResult,
} from "./conversation-submit-contract.js";
import type { ConversationSubmitAttemptStore } from "./conversation-submit-attempt-store.js";
import {
  resolveConversationSubmitDraft,
  type ConversationSubmitDocumentRuntimeStatusReader,
  type ConversationSubmitSkillCommandResolver,
} from "./conversation-submit-draft-resolution.js";
import type { ConversationService } from "./conversation-service.js";
import { ApiError } from "./errors.js";
import type { WorkspaceInfo } from "./types.js";

export type ConversationSubmitService = {
  submit(input: {
    workspace: WorkspaceInfo;
    body: Record<string, unknown>;
    sendTraceId?: string | null;
    runtimeAuthorizationActorTokenHash?: string | null;
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
  runtimeAuthorizationActorTokenHash?: string | null;
}) => Promise<{
  payload:
    | ConversationSubmitSubmittedResult
    | ConversationSubmitQueuedResult
    | ConversationSubmitBlockedResult
    | ConversationSubmitFailedResult;
  httpStatus: number;
}>;

export function createConversationSubmitService(input: {
  attemptStore: ConversationSubmitAttemptStore;
  conversationService: ConversationService;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
}): ConversationSubmitService {
  const { attemptStore, conversationService, documentRuntimeStatus, resolveSkillCommand } = input;
  const inFlightSubmitAttempts = new Map<string, Promise<ConversationSubmitServiceResponse>>();

  return {
    async submit({
      workspace,
      body,
      sendTraceId,
      runtimeAuthorizationActorTokenHash,
      resolveDirectory,
      submitResolvedRun,
    }) {
      const request = parseConversationSubmitRequest(body);
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

      if (claimed.attempt.resultJson) {
        try {
          return {
            payload: JSON.parse(claimed.attempt.resultJson) as ConversationSubmitResult,
            httpStatus: 200,
          };
        } catch {
          // Fall through and rebuild the result from the current request.
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

      const draftResolution = await resolveConversationSubmitDraft({
        request,
        documentRuntimeStatus,
        resolveSkillCommand,
        workspace,
        includeGlobal: workspace.workspaceType === "local",
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
              runtimeAuthorizationActorTokenHash: runtimeAuthorizationActorTokenHash ?? null,
            });
            if (result.payload.status === "blocked" || result.payload.status === "failed") {
              return {
                payload: completeAttempt(
                  result.payload,
                  result.payload.status === "blocked" ? "blocked" : "failed",
                ),
                httpStatus: result.httpStatus,
              };
            }
            return {
              payload: completeAttempt(result.payload, "completed"),
              httpStatus: result.httpStatus,
            };
          } catch (error) {
            const payload: ConversationSubmitResult = {
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
            };
            return {
              payload: completeAttempt(payload, "failed"),
              httpStatus: 200,
            };
          }
        }
        return {
          payload: completeAttempt({
            status: "blocked",
            code: "run_submit_unavailable",
            message: "Server-owned run submit is not available yet",
            draftDisposition: "restore",
            recoverable: true,
          }, "blocked"),
          httpStatus: 200,
        };
      }

      try {
        const materializedSession = await conversationService.createConversation({
          workspace,
          directory,
          title: deriveSubmitConversationTitle(request),
          sendTraceId: sendTraceId ?? null,
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
              runtimeAuthorizationActorTokenHash: runtimeAuthorizationActorTokenHash ?? null,
            });
            if (result.payload.status === "blocked" || result.payload.status === "failed") {
              const materializedPayload = withMaterializedSession(result.payload, materializedSession);
              return {
                payload: completeAttempt(
                  materializedPayload,
                  result.payload.status === "blocked" ? "blocked" : "failed",
                ),
                httpStatus: result.httpStatus,
              };
            }
            return {
              payload: completeAttempt({
                ...result.payload,
                materializedSession,
              }, "completed"),
              httpStatus: result.httpStatus,
            };
          } catch (error) {
            const payload: ConversationSubmitResult = withMaterializedSession({
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
            }, materializedSession);
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
        const payload: ConversationSubmitResult = {
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
        };
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

function deriveSubmitConversationTitle(request: ConversationSubmitRequest): string | null {
  const text = request.draft.text.trim() || request.draft.resolvedText?.trim() || "";
  if (text) return text.slice(0, 160);
  if (request.draft.command) {
    const commandText = `/${request.draft.command.name} ${request.draft.command.arguments}`.trim();
    return commandText.slice(0, 160);
  }
  return null;
}
