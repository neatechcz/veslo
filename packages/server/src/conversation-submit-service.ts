import {
  conversationSubmitDraftIsEmpty,
  createConversationSubmitRequestHash,
  parseConversationSubmitRequest,
  type ConversationSubmitResult,
} from "./conversation-submit-contract.js";
import type { ConversationSubmitAttemptStore } from "./conversation-submit-attempt-store.js";
import { ApiError } from "./errors.js";
import type { WorkspaceInfo } from "./types.js";

export type ConversationSubmitService = {
  dryRun(input: {
    workspace: WorkspaceInfo;
    body: Record<string, unknown>;
    resolveDirectory: (requestedRaw: string | null) => Promise<string | null>;
  }): Promise<{ payload: ConversationSubmitResult; httpStatus: number }>;
};

export function createConversationSubmitService(input: {
  attemptStore: ConversationSubmitAttemptStore;
}): ConversationSubmitService {
  const { attemptStore } = input;

  return {
    async dryRun({ workspace, body, resolveDirectory }) {
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

      const completeAttempt = (payload: ConversationSubmitResult, status: "completed" | "blocked" | "failed") => {
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
          // Fall through and rebuild the dry-run result.
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

      const directory = await resolveDirectory(request.target?.directory ?? null);
      const payload: ConversationSubmitResult = {
        status: "dry_run",
        workspaceId: workspace.id,
        clientMessageId: request.clientMessageId,
        requestHash,
        draftDisposition: "keep",
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
    },
  };
}
