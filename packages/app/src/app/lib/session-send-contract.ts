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
};

export type SessionSendOptionsBase = SessionSendCorrelation & {
  sendTraceId?: string | null;
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
  return {
    clientMessageId: input.clientMessageId.trim(),
    origin: input.origin,
  };
}
