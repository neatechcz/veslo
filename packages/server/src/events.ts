import type { ReloadEvent, ReloadReason, ReloadTrigger } from "./types.js";
import { shortId } from "./utils.js";

export type ReloadEventListener = (event: ReloadEvent) => void;

export class ReloadEventStore {
  private events: ReloadEvent[] = [];
  private seq = 0;
  private maxSize: number;
  private lastRecorded: Map<string, number> = new Map();
  private listeners = new Set<ReloadEventListener>();

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  record(workspaceId: string, reason: ReloadReason, trigger?: ReloadTrigger): ReloadEvent {
    const event: ReloadEvent = {
      id: shortId(),
      seq: ++this.seq,
      workspaceId,
      reason,
      trigger,
      timestamp: Date.now(),
    };

    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }

    for (const listener of this.listeners) {
      // A diagnostic/reconcile consumer must never turn a successfully
      // recorded control-plane event into a failed mutation response.
      try {
        listener(event);
      } catch {
        // The event remains available to polling clients and later work.
      }
    }

    return event;
  }

  recordDebounced(
    workspaceId: string,
    reason: ReloadReason,
    trigger?: ReloadTrigger,
    debounceMs = 750,
  ): ReloadEvent | null {
    const now = Date.now();
    const key = `${workspaceId}:${reason}`;
    const last = this.lastRecorded.get(key) ?? 0;
    if (now - last < debounceMs) return null;
    this.lastRecorded.set(key, now);
    return this.record(workspaceId, reason, trigger);
  }

  list(workspaceId: string, since?: number): ReloadEvent[] {
    const cursor = Number.isFinite(since) ? (since as number) : 0;
    return this.events.filter((event) => event.workspaceId === workspaceId && event.seq > cursor);
  }

  cursor(): number {
    return this.seq;
  }

  /**
   * Event consumers own follow-up work; recording remains synchronous and
   * durable for polling clients even when a consumer is absent or removed.
   */
  subscribe(listener: ReloadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
