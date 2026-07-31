export type ConversationRunDeliveryScope = {
  workspaceId: string;
  conversationId: string;
  runId: string;
};

export type ConversationRunDeliveryRejectionReason =
  | "missing_binding_envelope"
  | "binding_workspace_mismatch"
  | "unknown_session"
  | "stale_generation"
  | "background_workspace_policy"
  | "duplicate_event"
  | "invalid_event_shape"
  | "other_allowlisted_rejection";

type AggregateReport = {
  kind: "aggregate";
  acceptedEventCount: number;
  rejectedByReason: Partial<Record<ConversationRunDeliveryRejectionReason, number>>;
  storeCommitCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  reportedAt: string;
};

type TerminalReport = {
  kind: "terminal";
  hydration: "not_attempted" | "adopted" | "skipped" | "failed";
  presentation: "visible_output" | "hidden_progress" | "no_visible_output" | "unknown";
  reportedAt: string;
};

export type ConversationRunDeliveryReport = AggregateReport | TerminalReport;

type AggregateState = {
  scope: ConversationRunDeliveryScope;
  acceptedEventCount: number;
  rejectedByReason: Partial<Record<ConversationRunDeliveryRejectionReason, number>>;
  storeCommitCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  assistantMessageIds: Set<string>;
  aggregateReported: boolean;
  aggregateTimer: ReturnType<typeof setTimeout> | null;
};

const keyForScope = (scope: ConversationRunDeliveryScope) =>
  `${scope.workspaceId}\u0000${scope.conversationId}\u0000${scope.runId}`;
const MAX_TERMINAL_RUN_FENCES = 1_024;

const normalizedScope = (scope: ConversationRunDeliveryScope): ConversationRunDeliveryScope | null => {
  const workspaceId = scope.workspaceId.trim();
  const conversationId = scope.conversationId.trim();
  const runId = scope.runId.trim();
  return workspaceId && conversationId && runId ? { workspaceId, conversationId, runId } : null;
};

/**
 * Bounded app-side evidence only. It batches transport/store observations and
 * sends at most one aggregate plus one terminal outcome for a durable run.
 */
export function createConversationRunDeliveryReporter(options: {
  report: (scope: ConversationRunDeliveryScope, report: ConversationRunDeliveryReport) => Promise<unknown> | void;
  now?: () => Date;
}) {
  const states = new Map<string, AggregateState>();
  const terminalRunFences = new Set<string>();
  const terminalRunFenceOrder: string[] = [];
  const now = options.now ?? (() => new Date());
  const timestamp = () => now().toISOString();

  const get = (scope: ConversationRunDeliveryScope) => {
    const normalized = normalizedScope(scope);
    if (!normalized) return null;
    const key = keyForScope(normalized);
    if (terminalRunFences.has(key)) return null;
    let state = states.get(key);
    if (!state) {
      state = {
        scope: normalized,
        acceptedEventCount: 0,
        rejectedByReason: {},
        storeCommitCount: 0,
        assistantMessageIds: new Set(),
        aggregateReported: false,
        aggregateTimer: null,
      };
      states.set(key, state);
    }
    return state;
  };

  const fenceTerminalRun = (scope: ConversationRunDeliveryScope) => {
    const key = keyForScope(scope);
    if (terminalRunFences.has(key)) return;
    terminalRunFences.add(key);
    terminalRunFenceOrder.push(key);
    if (terminalRunFenceOrder.length > MAX_TERMINAL_RUN_FENCES) {
      const oldest = terminalRunFenceOrder.shift();
      if (oldest) terminalRunFences.delete(oldest);
    }
  };

  const sendAggregate = (state: AggregateState, final = false) => {
    if (state.aggregateReported && !final) return;
    state.aggregateReported = true;
    void Promise.resolve(options.report(state.scope, {
      kind: "aggregate",
      acceptedEventCount: state.acceptedEventCount,
      rejectedByReason: { ...state.rejectedByReason },
      storeCommitCount: state.storeCommitCount,
      ...(state.firstObservedAt ? { firstObservedAt: state.firstObservedAt } : {}),
      ...(state.lastObservedAt ? { lastObservedAt: state.lastObservedAt } : {}),
      reportedAt: timestamp(),
    })).catch(() => undefined);
  };

  const scheduleAggregate = (state: AggregateState) => {
    if (state.aggregateReported || state.aggregateTimer !== null) return;
    // `applyEvent()` is async, so a microtask may run between successive SSE
    // handlers. One zero-delay task captures that current stream batch without
    // issuing one app-to-server write per part.
    state.aggregateTimer = setTimeout(() => {
      state.aggregateTimer = null;
      sendAggregate(state);
    }, 0);
  };

  const observe = (
    scope: ConversationRunDeliveryScope,
    input: { accepted?: boolean; storeCommitted?: boolean; rejected?: ConversationRunDeliveryRejectionReason },
  ) => {
    const state = get(scope);
    if (!state) return;
    const observedAt = timestamp();
    state.firstObservedAt ??= observedAt;
    state.lastObservedAt = observedAt;
    if (input.accepted) state.acceptedEventCount += 1;
    if (input.storeCommitted) state.storeCommitCount += 1;
    if (input.rejected) {
      state.rejectedByReason[input.rejected] = (state.rejectedByReason[input.rejected] ?? 0) + 1;
    }
    scheduleAggregate(state);
  };

  return {
    observeAccepted(
      scope: ConversationRunDeliveryScope,
      storeCommitted: boolean,
      message?: { id: string; role?: string | null },
    ) {
      observe(scope, { accepted: true, storeCommitted });
      const state = get(scope);
      const messageId = message?.id.trim() ?? "";
      if (state && message?.role === "assistant" && messageId) state.assistantMessageIds.add(messageId);
    },
    observeRejected(scope: ConversationRunDeliveryScope, reason: ConversationRunDeliveryRejectionReason) {
      observe(scope, { rejected: reason });
    },
    reportTerminal(
      scope: ConversationRunDeliveryScope,
      terminal: Omit<TerminalReport, "kind" | "reportedAt">,
    ) {
      const state = get(scope);
      if (!state) return;
      if (state.aggregateTimer !== null) {
        clearTimeout(state.aggregateTimer);
        state.aggregateTimer = null;
      }
      // The early aggregate gives cold-start evidence. Re-send the same
      // aggregate once at the terminal boundary so counts cover the full run.
      sendAggregate(state, true);
      void Promise.resolve(options.report(state.scope, {
        kind: "terminal",
        ...terminal,
        reportedAt: timestamp(),
      })).catch(() => undefined);
      fenceTerminalRun(state.scope);
      states.delete(keyForScope(state.scope));
    },
    assistantMessageIds(scope: ConversationRunDeliveryScope): string[] {
      const state = get(scope);
      return state ? [...state.assistantMessageIds] : [];
    },
  };
}
