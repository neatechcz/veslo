/**
 * Safe, versioned diagnostic metadata which links already-known identities.
 *
 * This is deliberately not a command envelope: callers must only provide a
 * run id once their own durable admission boundary has accepted it.  Client
 * message and queue ids remain causation hints and can never make an
 * operation authoritative.
 */
export type OperationCorrelation = {
  version: 1;
  authoritativeOperation: { kind: "conversation-run"; id: string } | null;
  causation: {
    clientMessageId: string | null;
    queueItemId: string | null;
  };
  scope: {
    workspaceId: string | null;
    conversationId: string | null;
  };
  origin: string | null;
  phase: string | null;
  outcome: string | null;
  reason: string | null;
};

export type ConversationRunCorrelationInput = {
  /** Only pass after the server has durably admitted this exact run. */
  admittedRunId?: string | null;
  clientMessageId?: string | null;
  queueItemId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  origin?: string | null;
  phase?: string | null;
  outcome?: string | null;
  reason?: string | null;
};

const MAX_CORRELATION_ID_LENGTH = 256;
const MAX_CORRELATION_LABEL_LENGTH = 128;

function safeId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= MAX_CORRELATION_ID_LENGTH ? normalized : null;
}

function safeLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= MAX_CORRELATION_LABEL_LENGTH ? normalized : null;
}

export function createConversationRunCorrelation(input: ConversationRunCorrelationInput): OperationCorrelation {
  const admittedRunId = safeId(input.admittedRunId);
  return {
    version: 1,
    authoritativeOperation: admittedRunId ? { kind: "conversation-run", id: admittedRunId } : null,
    causation: {
      clientMessageId: safeId(input.clientMessageId),
      queueItemId: safeId(input.queueItemId),
    },
    scope: {
      workspaceId: safeId(input.workspaceId),
      conversationId: safeId(input.conversationId),
    },
    origin: safeLabel(input.origin),
    phase: safeLabel(input.phase),
    outcome: safeLabel(input.outcome),
    reason: safeLabel(input.reason),
  };
}
