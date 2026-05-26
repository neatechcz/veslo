// VSLO-86 — drop-in replacement for opencode SDK `event.subscribe()` that
// keeps the SSE stream entirely on the Rust side. The Tauri http plugin
// holds the IPC channel open for a fetched body stream; when JS opened the
// SDK SSE through `tauriFetch`, that pending `fetch_read_body` invoke would
// freeze paralel short requests (sidebar session listing across workspaces)
// until the 60s frontend timeout fired. Rust-side SSE means JS only
// `listen()`s for events — no held fetch promise, no blocked IPC.
//
// API mirrors the parts of the SDK subscription we actually use:
// `{ stream: AsyncIterable<Event>, [Symbol.asyncDispose] }`. Drop into both
// callsites: `global-sdk.tsx` and `session.ts`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../utils/paths";

const SSE_EVENT_NAME = "veslo://engine-sse-event";

type SsePayload =
  | {
      kind: "open";
      subscriptionId: string;
      workspaceId: string;
    }
  | {
      kind: "message";
      subscriptionId: string;
      workspaceId: string;
      data: string;
    }
  | {
      kind: "error";
      subscriptionId: string;
      workspaceId: string;
      message: string;
    }
  | {
      kind: "closed";
      subscriptionId: string;
      workspaceId: string;
      reason: string;
    };

export type EngineSseSubscribeOptions = {
  workspaceId: string;
  /** Base URL of the orchestrator proxy or engine (without trailing `/event`). */
  baseUrl: string;
  /** Optional `directory` query for engine-side filtering. */
  directory?: string | null;
  username?: string | null;
  password?: string | null;
  /** AbortSignal lets callers tear down the subscription. */
  signal?: AbortSignal;
};

export type EngineSseSubscription = {
  subscriptionId: string;
  /** Async iterable of parsed event payloads, matching SDK `subscription.stream` shape. */
  stream: AsyncIterable<unknown>;
  /** Tear down the Rust-side task and remove the listener. Idempotent. */
  close: () => Promise<void>;
};

export function isEngineSseAvailable(): boolean {
  return isTauriRuntime();
}

export async function engineSseSubscribe(
  options: EngineSseSubscribeOptions,
): Promise<EngineSseSubscription> {
  if (!isTauriRuntime()) {
    throw new Error("engine SSE proxy is desktop-only");
  }

  // Queue of pending events buffered between Rust emit and JS consumer.
  const queue: unknown[] = [];
  const resolvers: Array<(value: IteratorResult<unknown>) => void> = [];
  let closed = false;
  let closeReason: string | null = null;

  const pushEvent = (event: unknown) => {
    if (closed) return;
    const resolver = resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const closeStream = (reason: string | null) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    while (resolvers.length > 0) {
      const resolver = resolvers.shift()!;
      resolver({ value: undefined, done: true });
    }
  };

  const sub = await invoke<{ subscriptionId: string }>("engine_sse_subscribe", {
    options: {
      workspaceId: options.workspaceId,
      baseUrl: options.baseUrl,
      directory: options.directory ?? null,
      username: options.username ?? null,
      password: options.password ?? null,
    },
  });

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<SsePayload>(SSE_EVENT_NAME, (event) => {
      const payload = event.payload;
      if (!payload || payload.subscriptionId !== sub.subscriptionId) return;

      switch (payload.kind) {
        case "open":
          // Engine accepted the stream — nothing to surface to caller, the
          // first real event in the queue is enough signal.
          break;
        case "message": {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload.data);
          } catch {
            // Malformed JSON from engine — skip rather than tearing down the
            // stream. Should not happen for healthy opencode but worth being
            // defensive about.
            console.warn("[engine-sse] dropped malformed event", { data: payload.data.slice(0, 200) });
            return;
          }
          pushEvent(parsed);
          break;
        }
        case "error":
          console.warn("[engine-sse] stream error", { message: payload.message, workspaceId: payload.workspaceId });
          break;
        case "closed":
          closeStream(payload.reason);
          break;
      }
    });
  } catch (err) {
    // Couldn't register listener — try to clean up Rust subscription.
    try {
      await invoke("engine_sse_unsubscribe", { subscriptionId: sub.subscriptionId });
    } catch {
      // ignore
    }
    throw err;
  }

  const close = async () => {
    closeStream(closeReason ?? "client-close");
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // ignore
      }
      unlisten = null;
    }
    try {
      await invoke("engine_sse_unsubscribe", { subscriptionId: sub.subscriptionId });
    } catch {
      // ignore — Rust side may already be torn down
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      void close();
    } else {
      options.signal.addEventListener("abort", () => {
        void close();
      });
    }
  }

  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<unknown>>((resolve) => {
            resolvers.push(resolve);
          });
        },
        return(): Promise<IteratorResult<unknown>> {
          void close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    subscriptionId: sub.subscriptionId,
    stream,
    close,
  };
}
