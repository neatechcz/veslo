import type { ComposerDraft, ModelRef } from "../../types";

export type QueuedDraftState = "queued" | "editing" | "sending" | "error";

export type QueuedDraftEnvelope = {
  clientMessageId: string;
  /** Captured on enqueue so a later picker change cannot affect this draft. */
  modelOverride?: ModelRef | null;
};

export type QueuedDraft = QueuedDraftEnvelope & {
  id: string;
  draft: ComposerDraft;
  createdAt: number;
  updatedAt: number;
  state: QueuedDraftState;
  stateBeforeEditing?: Exclude<QueuedDraftState, "editing">;
  error?: string;
};

const createQueueId = () => `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const isDrainEligible = (item: QueuedDraft) => item.state === "queued";

export function appendQueuedDraft(
  queue: QueuedDraft[],
  draft: ComposerDraft,
  envelope: QueuedDraftEnvelope,
  now = Date.now(),
  id = createQueueId(),
): QueuedDraft[] {
  const clientMessageId = envelope.clientMessageId.trim();
  if (!clientMessageId) throw new Error("Queued drafts require a clientMessageId");
  return [
    ...queue,
    {
      id,
      draft,
      clientMessageId,
      ...(envelope.modelOverride ? { modelOverride: envelope.modelOverride } : {}),
      createdAt: now,
      updatedAt: now,
      state: "queued",
    },
  ];
}

export function firstQueuedDraft(queue: QueuedDraft[]): QueuedDraft | null {
  const head = queue.at(0);
  return head && isDrainEligible(head) ? head : null;
}

export function resolveQueuedDraftSessionKey(
  queuesBySessionKey: Record<string, QueuedDraft[]>,
  originalSessionKey: string,
  id: string,
): string {
  const originalQueue = queuesBySessionKey[originalSessionKey] ?? [];
  if (originalQueue.some((item) => item.id === id)) return originalSessionKey;
  const remappedEntry = Object.entries(queuesBySessionKey).find(
    ([sessionKey, queue]) => sessionKey !== originalSessionKey && queue.some((item) => item.id === id),
  );
  return remappedEntry?.[0] ?? originalSessionKey;
}

export function updateQueuedDraft(
  queue: QueuedDraft[],
  id: string,
  draft: ComposerDraft,
  now = Date.now(),
  envelope?: QueuedDraftEnvelope,
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  const clientMessageId = envelope?.clientMessageId.trim();
  if (envelope && !clientMessageId) throw new Error("Queued drafts require a clientMessageId");
  return queue.map((item) => {
    if (item.id !== id) return item;
    return {
      ...item,
      draft,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(envelope && "modelOverride" in envelope
        ? { modelOverride: envelope.modelOverride ?? undefined }
        : {}),
      updatedAt: now,
    };
  });
}

export function removeQueuedDraft(queue: QueuedDraft[], id: string): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.filter((item) => item.id !== id);
}

export function moveQueuedDraft(queue: QueuedDraft[], id: string, targetIndex: number): QueuedDraft[] {
  if (!queue.every(isDrainEligible)) return queue;

  const sourceIndex = queue.findIndex((item) => item.id === id);
  if (sourceIndex === -1) return queue;

  const clampedTargetIndex = Math.max(0, Math.min(targetIndex, queue.length - 1));
  if (sourceIndex === clampedTargetIndex) return queue;

  const reorderedItems = [...queue];
  const [moved] = reorderedItems.splice(sourceIndex, 1);
  reorderedItems.splice(clampedTargetIndex, 0, moved!);
  return reorderedItems;
}

export function markQueuedDraftSending(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id
      ? { ...item, state: "sending", stateBeforeEditing: undefined, error: undefined, updatedAt: now }
      : item,
  );
}

export function markQueuedDraftError(
  queue: QueuedDraft[],
  id: string,
  error: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id
      ? { ...item, state: "error", stateBeforeEditing: undefined, error, updatedAt: now }
      : item,
  );
}

export function markQueuedDraftQueued(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id
      ? { ...item, state: "queued", stateBeforeEditing: undefined, error: undefined, updatedAt: now }
      : item,
  );
}

export function markQueuedDraftEditing(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id
      ? {
          ...item,
          state: "editing",
          stateBeforeEditing: item.state === "editing" ? item.stateBeforeEditing : item.state,
          updatedAt: now,
        }
      : item,
  );
}

export function restoreQueuedDraftAfterEditing(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) => {
    if (item.id !== id || item.state !== "editing") return item;
    const restoredState = item.stateBeforeEditing ?? "queued";
    return {
      ...item,
      state: restoredState,
      stateBeforeEditing: undefined,
      ...(restoredState === "error" ? {} : { error: undefined }),
      updatedAt: now,
    };
  });
}
