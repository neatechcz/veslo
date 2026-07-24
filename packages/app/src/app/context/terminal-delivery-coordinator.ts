export type TerminalDeliveryKey = {
  workspaceId: string;
  conversationId: string;
  runId: string;
};

export type TerminalDeliveryProvisionalKey = {
  workspaceId: string;
  conversationId: string;
  clientMessageId: string;
};

type DeliveryKey = TerminalDeliveryKey | TerminalDeliveryProvisionalKey;

export type TerminalDeliveryMutation = {
  commit: () => void;
  kind: "assistant" | "hydration" | "error";
};

type TerminalDeliveryCoordinatorOptions = {
  scheduleRenderBoundary?: (callback: () => void) => void;
  trace?: (event: string, payload: Record<string, unknown>) => void;
};

type Entry = {
  key: DeliveryKey;
  terminal: boolean;
  terminalBoundaryComplete: boolean;
  boundaryScheduled: boolean;
  tail: TerminalDeliveryMutation | null;
  terminalDisplays: TerminalDeliveryMutation[];
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

export const terminalDeliveryKey = (key: TerminalDeliveryKey) =>
  `${normalize(key.workspaceId)}\0${normalize(key.conversationId)}\0${normalize(key.runId)}`;

export const terminalDeliveryProvisionalKey = (key: TerminalDeliveryProvisionalKey) =>
  `${normalize(key.workspaceId)}\0${normalize(key.conversationId)}\0provisional\0${normalize(key.clientMessageId)}`;

const validKey = (key: TerminalDeliveryKey) => Boolean(
  normalize(key.workspaceId) && normalize(key.conversationId) && normalize(key.runId),
);

const validProvisionalKey = (key: TerminalDeliveryProvisionalKey) => Boolean(
  normalize(key.workspaceId) && normalize(key.conversationId) && normalize(key.clientMessageId),
);

const deliveryKeyId = (key: DeliveryKey) =>
  "runId" in key ? terminalDeliveryKey(key) : terminalDeliveryProvisionalKey(key);

const validDeliveryKey = (key: DeliveryKey) =>
  "runId" in key ? validKey(key) : validProvisionalKey(key);

const defaultScheduleRenderBoundary = (callback: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
};

/**
 * Owns only the last visible transcript mutation for an exact terminal run.
 * Lifecycle truth and transcript persistence stay with their existing owners.
 */
export function createTerminalDeliveryCoordinator(options: TerminalDeliveryCoordinatorOptions = {}) {
  const entries = new Map<string, Entry>();
  const scheduleRenderBoundary = options.scheduleRenderBoundary ?? defaultScheduleRenderBoundary;

  const trace = (event: string, entry: Entry, extra: Record<string, unknown> = {}) => {
    options.trace?.(event, {
      workspaceId: entry.key.workspaceId,
      conversationId: entry.key.conversationId,
      runId: "runId" in entry.key ? entry.key.runId : null,
      clientMessageId: "clientMessageId" in entry.key ? entry.key.clientMessageId : null,
      ...extra,
    });
  };

  const entryFor = (key: DeliveryKey) => {
    if (!validDeliveryKey(key)) return null;
    const id = deliveryKeyId(key);
    const existing = entries.get(id);
    if (existing) return existing;
    const entry: Entry = {
      key: { ...key },
      terminal: false,
      terminalBoundaryComplete: false,
      boundaryScheduled: false,
      tail: null,
      terminalDisplays: [],
    };
    entries.set(id, entry);
    return entry;
  };

  const commit = (entry: Entry, mutation: TerminalDeliveryMutation, reason: string) => {
    mutation.commit();
    trace(
      reason === "after-terminal-boundary"
        ? "terminal-delivery:visible-mutation-commit-after-terminal"
        : "terminal-delivery:visible-mutation-commit",
      entry,
      { kind: mutation.kind, reason },
    );
  };

  const flushTerminal = (entry: Entry) => {
    entry.boundaryScheduled = false;
    entry.terminalBoundaryComplete = true;
    if (entry.tail) {
      const tail = entry.tail;
      entry.tail = null;
      commit(entry, tail, "after-terminal-boundary");
    }
    for (const mutation of entry.terminalDisplays.splice(0)) {
      commit(entry, mutation, "after-terminal-boundary");
    }
  };

  return {
    retainVisibleMutation(key: DeliveryKey, mutation: TerminalDeliveryMutation) {
      const entry = entryFor(key);
      if (!entry || entry.terminalBoundaryComplete) {
        mutation.commit();
        return false;
      }
      if (entry.tail) commit(entry, entry.tail, "replaced-by-newer-visible-mutation");
      entry.tail = mutation;
      trace("terminal-delivery:visible-mutation-prepared", entry, { kind: mutation.kind });
      return true;
    },
    retainTerminalDisplay(key: TerminalDeliveryKey, mutation: TerminalDeliveryMutation) {
      const entry = entryFor(key);
      if (!entry || entry.terminalBoundaryComplete) {
        mutation.commit();
        return false;
      }
      if (mutation.kind === "hydration") {
        const existingHydrationIndex = entry.terminalDisplays.findIndex((item) => item.kind === "hydration");
        if (existingHydrationIndex >= 0) {
          entry.terminalDisplays[existingHydrationIndex] = mutation;
          trace("terminal-delivery:terminal-display-replaced", entry, { kind: mutation.kind });
          return true;
        }
      }
      entry.terminalDisplays.push(mutation);
      trace("terminal-delivery:terminal-display-held", entry, { kind: mutation.kind });
      return true;
    },
    confirmTerminal(key: TerminalDeliveryKey, onBoundaryComplete?: () => void) {
      const entry = entryFor(key);
      if (!entry || entry.terminal || entry.boundaryScheduled || entry.terminalBoundaryComplete) return false;
      entry.terminal = true;
      entry.boundaryScheduled = true;
      trace("terminal-delivery:terminal-confirmed", entry);
      scheduleRenderBoundary(() => {
        flushTerminal(entry);
        onBoundaryComplete?.();
      });
      return true;
    },
    promoteProvisional(provisional: TerminalDeliveryProvisionalKey, exact: TerminalDeliveryKey) {
      if (!validProvisionalKey(provisional) || !validKey(exact)) return false;
      const provisionalId = terminalDeliveryProvisionalKey(provisional);
      const entry = entries.get(provisionalId);
      if (!entry) return false;
      const exactId = terminalDeliveryKey(exact);
      const exactEntry = entries.get(exactId);
      if (exactEntry && exactEntry !== entry) return false;
      entries.delete(provisionalId);
      entry.key = { ...exact };
      entries.set(exactId, entry);
      trace("terminal-delivery:provisional-promoted", entry);
      return true;
    },
    dispose(key: TerminalDeliveryKey) {
      return entries.delete(terminalDeliveryKey(key));
    },
    disposeProvisional(key: TerminalDeliveryProvisionalKey) {
      return entries.delete(terminalDeliveryProvisionalKey(key));
    },
    releaseProvisionalWithoutTerminal(key: TerminalDeliveryProvisionalKey) {
      const entry = entries.get(terminalDeliveryProvisionalKey(key));
      if (!entry) return false;
      if (entry.tail) {
        const tail = entry.tail;
        entry.tail = null;
        commit(entry, tail, "provisional-released-without-terminal");
      }
      for (const mutation of entry.terminalDisplays.splice(0)) {
        commit(entry, mutation, "provisional-released-without-terminal");
      }
      entries.delete(terminalDeliveryProvisionalKey(key));
      trace("terminal-delivery:provisional-released-without-terminal", entry);
      return true;
    },
    disposeAll() {
      entries.clear();
    },
  };
}
