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
};

export type SessionSubmitDraftDisposition = "clear" | "restore" | "keep" | "mark-failed";

export type SessionSubmitResult = {
  accepted: boolean;
  status: "accepted" | "blocked" | "failed";
  draftDisposition: SessionSubmitDraftDisposition;
  code?: string | null;
  message?: string | null;
};

export type MaterializedSessionHandoff = {
  workspaceId: string;
  pendingSessionKey?: string | null;
  sessionId: string;
  clientMessageId: string;
  sendTraceId?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

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
