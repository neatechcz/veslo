import type { QueuedDraft } from "./session-queue-model.js";

export const isQueuedMessageMovable = (item: QueuedDraft) => item.state === "queued";

export const canReorderQueuedMessages = (items: QueuedDraft[]) => items.every(isQueuedMessageMovable);

export const movableQueueTargetIndex = (items: QueuedDraft[], targetId: string): number =>
  canReorderQueuedMessages(items) ? items.findIndex((item) => item.id === targetId) : -1;
