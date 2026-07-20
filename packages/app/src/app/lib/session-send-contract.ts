export type SessionSendOrigin =
  | "session:normal"
  | "session:send-now"
  | "session:queue-drain"
  | "session:replacement"
  | "app:retry-last-prompt"
  | "app:soul-prompt";

export type SessionSendCorrelation = {
  clientMessageId: string;
  origin: SessionSendOrigin;
  source?: string | null;
};

export type SessionSendOptionsBase = SessionSendCorrelation & {
  sendTraceId?: string | null;
  /** Captured per-send without changing the workspace default model. */
  modelOverride?: ModelRef | null;
};

type SessionSubmitDraftDisposition = "clear" | "restore" | "keep" | "mark-failed";

type SessionSubmitStatus = "accepted" | "submitted" | "queued" | "blocked" | "failed";

export type SessionSubmitImplicitSkillCommandConfirmation = {
  type: "implicit_skill_command";
  skillName: string;
  arguments: string;
};

type SessionSubmitConfirmation =
  | SessionSubmitImplicitSkillCommandConfirmation;

export type SessionSubmitResult = {
  accepted: boolean;
  status: SessionSubmitStatus;
  draftDisposition: SessionSubmitDraftDisposition;
  code?: string | null;
  message?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  runId?: string | null;
  queueItemId?: string | null;
  reservedRunId?: string | null;
  queuePosition?: number | null;
  clientMessageId?: string | null;
  confirmation?: SessionSubmitConfirmation | null;
};

type MaterializedSessionConversationScope = {
  kind: "conversation";
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
};

type MaterializedSessionWorkspaceScope = {
  kind: "workspace";
  workspaceId: string;
};

export type MaterializedSessionScope =
  | MaterializedSessionConversationScope
  | MaterializedSessionWorkspaceScope;

type MaterializedSessionHandoffBase = {
  workspaceId: string;
  workspaceRoot?: string | null;
  directory?: string | null;
  pendingSessionKey?: string | null;
  sessionId: string;
  clientMessageId: string;
  sendTraceId?: string | null;
};

export type MaterializedSessionHandoff =
  | (MaterializedSessionHandoffBase & {
      scope: MaterializedSessionConversationScope;
      conversationId: string;
      opencodeSessionId: string;
    })
  | (MaterializedSessionHandoffBase & {
      scope: MaterializedSessionWorkspaceScope;
      conversationId?: null;
      opencodeSessionId?: null;
    });

export type CreateMaterializedSessionHandoffInput = MaterializedSessionHandoffBase & {
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export function createMaterializedSessionHandoff(
  input: CreateMaterializedSessionHandoffInput,
): MaterializedSessionHandoff {
  const workspaceId = input.workspaceId.trim();
  const conversationId = input.conversationId?.trim() || "";
  const opencodeSessionId = input.opencodeSessionId?.trim() || "";
  const base: MaterializedSessionHandoffBase = {
    workspaceId,
    workspaceRoot: input.workspaceRoot?.trim() || null,
    directory: input.directory?.trim() || input.workspaceRoot?.trim() || null,
    pendingSessionKey: input.pendingSessionKey ?? null,
    sessionId: input.sessionId.trim(),
    clientMessageId: input.clientMessageId.trim(),
    sendTraceId: input.sendTraceId?.trim() || null,
  };
  if (conversationId && opencodeSessionId) {
    return {
      ...base,
      scope: {
        kind: "conversation",
        workspaceId,
        conversationId,
        opencodeSessionId,
      },
      conversationId,
      opencodeSessionId,
    };
  }
  return {
    ...base,
    scope: {
      kind: "workspace",
      workspaceId,
    },
    conversationId: null,
    opencodeSessionId: null,
  };
}

export function createSessionClientMessageId(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `msg_${suffix.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function normalizeSessionSendCorrelation(input: SessionSendCorrelation): SessionSendCorrelation {
  const source = input.source?.trim() || null;
  return {
    clientMessageId: input.clientMessageId.trim(),
    origin: input.origin,
    ...(source ? { source } : {}),
  };
}

export function sessionSubmitResultFromAccepted(
  accepted: boolean,
  message?: string | null,
): SessionSubmitResult {
  return accepted
    ? {
        accepted: true,
        status: "accepted",
        draftDisposition: "clear",
      }
    : {
        accepted: false,
        status: "blocked",
        draftDisposition: "restore",
        code: "send_rejected",
        message: message ?? null,
      };
}

type SessionSubmitSuccessInput = Omit<
  SessionSubmitResult,
  "accepted" | "status" | "draftDisposition"
> & {
  draftDisposition?: SessionSubmitDraftDisposition;
};

type SessionSubmitFailureInput = Omit<
  SessionSubmitResult,
  "accepted" | "status" | "draftDisposition"
> & {
  draftDisposition?: SessionSubmitDraftDisposition;
};

export function sessionSubmitAcceptedResult(input: SessionSubmitSuccessInput = {}): SessionSubmitResult {
  const { draftDisposition = "clear", ...rest } = input;
  return {
    accepted: true,
    status: "accepted",
    draftDisposition,
    ...rest,
  };
}

export function sessionSubmitSubmittedResult(input: SessionSubmitSuccessInput = {}): SessionSubmitResult {
  const { draftDisposition = "clear", ...rest } = input;
  return {
    accepted: true,
    status: "submitted",
    draftDisposition,
    ...rest,
  };
}

export function sessionSubmitQueuedResult(input: SessionSubmitSuccessInput = {}): SessionSubmitResult {
  const { draftDisposition = "clear", ...rest } = input;
  return {
    accepted: true,
    status: "queued",
    draftDisposition,
    ...rest,
  };
}

export function sessionSubmitBlockedResult(input: SessionSubmitFailureInput = {}): SessionSubmitResult {
  const {
    draftDisposition = "restore",
    code = "send_blocked",
    message = null,
    ...rest
  } = input;
  return {
    accepted: false,
    status: "blocked",
    draftDisposition,
    code,
    message,
    ...rest,
  };
}

export function sessionSubmitFailedResult(input: SessionSubmitFailureInput = {}): SessionSubmitResult {
  const {
    draftDisposition = "restore",
    code = "send_failed",
    message = null,
    ...rest
  } = input;
  return {
    accepted: false,
    status: "failed",
    draftDisposition,
    code,
    message,
    ...rest,
  };
}

export function sessionSubmitCompatibilityResultFromAccepted(
  accepted: boolean,
  message?: string | null,
): SessionSubmitResult {
  return accepted
    ? sessionSubmitAcceptedResult()
    : sessionSubmitBlockedResult({
        code: "send_rejected",
        message: message ?? null,
      });
}

export function sessionSubmitWasAccepted(result: SessionSubmitResult): boolean {
  return result.accepted;
}

export function sessionSubmitNeedsImplicitSkillConfirmation(
  result: SessionSubmitResult,
): result is SessionSubmitResult & { confirmation: SessionSubmitImplicitSkillCommandConfirmation } {
  return result.status === "blocked" &&
    result.code === "implicit_skill_confirmation_required" &&
    result.confirmation?.type === "implicit_skill_command";
}
import type { ModelRef } from "../types";
