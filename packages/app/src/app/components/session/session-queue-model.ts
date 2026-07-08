import type { ComposerDraft } from "../../types";

type QueuedDraftState = "queued" | "editing" | "sending" | "error";

export type QueuedDraft = {
  id: string;
  draft: ComposerDraft;
  createdAt: number;
  updatedAt: number;
  state: QueuedDraftState;
  error?: string;
};

const createQueueId = () => `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const isDrainEligible = (item: QueuedDraft) => item.state === "queued" || item.state === "error";

export function appendQueuedDraft(
  queue: QueuedDraft[],
  draft: ComposerDraft,
  now = Date.now(),
  id = createQueueId(),
): QueuedDraft[] {
  return [
    ...queue,
    {
      id,
      draft,
      createdAt: now,
      updatedAt: now,
      state: "queued",
    },
  ];
}

export function firstQueuedDraft(queue: QueuedDraft[]): QueuedDraft | null {
  return queue.find(isDrainEligible) ?? null;
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
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) => (item.id === id ? { ...item, draft, updatedAt: now } : item));
}

export function removeQueuedDraft(queue: QueuedDraft[], id: string): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.filter((item) => item.id !== id);
}

export function moveQueuedDraft(queue: QueuedDraft[], id: string, targetIndex: number): QueuedDraft[] {
  const movableItems = queue.filter(isDrainEligible);
  const sourceIndex = movableItems.findIndex((item) => item.id === id);
  if (sourceIndex === -1) return queue;

  const clampedTargetIndex = Math.max(0, Math.min(targetIndex, movableItems.length - 1));
  if (sourceIndex === clampedTargetIndex) return queue;

  const reorderedItems = [...movableItems];
  const [moved] = reorderedItems.splice(sourceIndex, 1);
  reorderedItems.splice(clampedTargetIndex, 0, moved!);

  let nextMovableIndex = 0;
  return queue.map((item) => (isDrainEligible(item) ? reorderedItems[nextMovableIndex++]! : item));
}

export function markQueuedDraftSending(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id ? { ...item, state: "sending", error: undefined, updatedAt: now } : item,
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
    item.id === id ? { ...item, state: "error", error, updatedAt: now } : item,
  );
}

export function markQueuedDraftQueued(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id ? { ...item, state: "queued", error: undefined, updatedAt: now } : item,
  );
}

export function markQueuedDraftEditing(
  queue: QueuedDraft[],
  id: string,
  now = Date.now(),
): QueuedDraft[] {
  if (!queue.some((item) => item.id === id)) return queue;
  return queue.map((item) =>
    item.id === id ? { ...item, state: "editing", error: undefined, updatedAt: now } : item,
  );
}
