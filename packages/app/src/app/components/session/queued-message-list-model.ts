import type { QueuedDraft } from "./session-queue-model.js";

export const isQueuedMessageMovable = (item: QueuedDraft) => item.state === "queued" || item.state === "error";

export const movableQueueTargetIndex = (items: QueuedDraft[], targetId: string): number =>
  items.filter(isQueuedMessageMovable).findIndex((item) => item.id === targetId);
