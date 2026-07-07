import type { ConversationAbortTarget } from "./conversation-service";
import type { SessionCreationWorkflowCreateOptions } from "../pages/session-creation-workflow";
import type { SessionConversationFlowController } from "../pages/session-conversation-flow";
import type {
  SessionSendWorkflow,
  SessionSendWorkflowSendOptions,
} from "../pages/session-send-workflow";
import type { SessionSubmitResult } from "../lib/session-send-contract";
import type { ComposerDraft } from "../types";

export type SessionFlowFacade = {
  createSessionAndOpen: (
    initialTitle?: string,
    options?: SessionCreationWorkflowCreateOptions,
  ) => Promise<string | undefined>;
  sendPrompt: (draft: ComposerDraft, options: SessionSendWorkflowSendOptions) => Promise<SessionSubmitResult>;
  abortSession: (sessionId?: string, target?: ConversationAbortTarget) => Promise<void>;
};

export type SessionFlowFacadeOptions = {
  createSessionAndOpen: SessionFlowFacade["createSessionAndOpen"];
  sendWorkflow: Pick<SessionSendWorkflow, "sendPrompt" | "abortSession">;
};

export function createSessionFlowFacade(options: SessionFlowFacadeOptions): SessionFlowFacade {
  return {
    createSessionAndOpen: (initialTitle, createOptions) =>
      options.createSessionAndOpen(initialTitle, createOptions),
    sendPrompt: (draft, sendOptions) =>
      options.sendWorkflow.sendPrompt(draft, sendOptions),
    abortSession: (sessionId, target) =>
      options.sendWorkflow.abortSession(sessionId, target),
  };
}

export type SessionViewFlowFacade = Pick<
  SessionConversationFlowController,
  | "cancelRun"
  | "handleActiveSessionStatusChanged"
  | "handleCancelQueuedDraft"
  | "handleEditQueuedDraft"
  | "handleEditUserMessage"
  | "handleMoveQueuedDraft"
  | "handleSelectedSessionChanged"
  | "handleSendPrompt"
  | "handleSessionStatusMapChanged"
  | "retryRun"
>;

export type SessionViewFlowFacadeOptions = {
  conversationFlow: SessionViewFlowFacade;
};

export function createSessionViewFlowFacade(
  options: SessionViewFlowFacadeOptions,
): SessionViewFlowFacade {
  return {
    cancelRun: () => options.conversationFlow.cancelRun(),
    handleActiveSessionStatusChanged: (status, previousStatus) =>
      options.conversationFlow.handleActiveSessionStatusChanged(status, previousStatus),
    handleCancelQueuedDraft: (id) =>
      options.conversationFlow.handleCancelQueuedDraft(id),
    handleEditQueuedDraft: (id) =>
      options.conversationFlow.handleEditQueuedDraft(id),
    handleEditUserMessage: (editable) =>
      options.conversationFlow.handleEditUserMessage(editable),
    handleMoveQueuedDraft: (id, targetIndex) =>
      options.conversationFlow.handleMoveQueuedDraft(id, targetIndex),
    handleSelectedSessionChanged: (input) =>
      options.conversationFlow.handleSelectedSessionChanged(input),
    handleSendPrompt: (draft, sendOptions) =>
      options.conversationFlow.handleSendPrompt(draft, sendOptions),
    handleSessionStatusMapChanged: (statuses, previousStatuses) =>
      options.conversationFlow.handleSessionStatusMapChanged(statuses, previousStatuses),
    retryRun: () => options.conversationFlow.retryRun(),
  };
}
