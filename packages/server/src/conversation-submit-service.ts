import {
  conversationSubmitDraftIsEmpty,
  createConversationSubmitRequestHash,
  parseConversationSubmitRequest,
  type ConversationSubmitRequest,
  type ConversationSubmitResult,
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
    resolveDirectory: (requestedRaw: string | null) => Promise<string | null>;
  }): Promise<{ payload: ConversationSubmitResult; httpStatus: number }>;
};

export function createConversationSubmitService(input: {
  attemptStore: ConversationSubmitAttemptStore;
  conversationService: ConversationService;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
}): ConversationSubmitService {
  const { attemptStore, conversationService, documentRuntimeStatus, resolveSkillCommand } = input;

  return {
    async submit({
      workspace,
      body,
      sendTraceId,
      resolveDirectory,
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
          resultJson: JSON.stringify(payload),
        });
        return payload;
      };

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
