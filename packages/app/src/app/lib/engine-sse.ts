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

type EngineSseInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type EngineSseListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn>;
type EngineSseRuntime = {
  isTauriRuntime: () => boolean;
  invoke: EngineSseInvoke;
  listen: EngineSseListen;
};

export type EngineSseSubscribeOptions = {
  workspaceId: string;
  /** Base URL of the orchestrator proxy or engine (without trailing `/event`). */
  baseUrl: string;
  /** Optional `directory` query for engine-side filtering. */
  directory?: string | null;
  /** Stable owner key used by the desktop bridge to replace older duplicate streams. */
  connectionKey?: string | null;
  username?: string | null;
  password?: string | null;
  /** Veslo-server bearer token. Takes precedence over username/password when set. */
  bearerToken?: string | null;
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
  return engineSseSubscribeWithRuntime(options, {
    isTauriRuntime,
    invoke: invoke as EngineSseInvoke,
    listen: listen as EngineSseListen,
  });
}

export function createEngineSseSubscribeForTests(runtime: EngineSseRuntime) {
  return (options: EngineSseSubscribeOptions) => engineSseSubscribeWithRuntime(options, runtime);
}

async function engineSseSubscribeWithRuntime(
  options: EngineSseSubscribeOptions,
  runtime: EngineSseRuntime,
): Promise<EngineSseSubscription> {
  if (!runtime.isTauriRuntime()) {
    throw new Error("engine SSE proxy is desktop-only");
  }

  const subscriptionId = createSubscriptionId();

  // Queue of pending events buffered between Rust emit and JS consumer.
  const queue: unknown[] = [];
  const resolvers: Array<{
    resolve: (value: IteratorResult<unknown>) => void;
    reject: (reason: Error) => void;
  }> = [];
  let closed = false;
  let closeReason: string | null = null;
  let streamErrorMessage: string | null = null;
  let opened = false;
  let settleReady: (() => void) | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  const resolveReady = () => {
    if (!settleReady) return;
    const resolve = settleReady;
    settleReady = null;
    rejectReady = null;
    resolve();
  };

  const failReady = (message: string) => {
    if (!rejectReady) return;
    const reject = rejectReady;
    settleReady = null;
    rejectReady = null;
    reject(new Error(message));
  };

  const pushEvent = (event: unknown) => {
    if (closed) return;
    const resolver = resolvers.shift();
    if (resolver) {
      resolver.resolve({ value: event, done: false });
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
      if (reason === "stream-error") {
        resolver.reject(new Error(streamErrorMessage ?? "engine SSE stream error"));
      } else {
        resolver.resolve({ value: undefined, done: true });
      }
    }
  };

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await runtime.listen<SsePayload>(SSE_EVENT_NAME, (event) => {
      const payload = event.payload;
      if (!payload || payload.subscriptionId !== subscriptionId) return;

      switch (payload.kind) {
        case "open":
          opened = true;
          resolveReady();
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
          if (!opened) {
            failReady(payload.message);
          } else {
            streamErrorMessage = payload.message;
            console.warn("[engine-sse] stream error", { message: payload.message, workspaceId: payload.workspaceId });
          }
          break;
        case "closed":
          closeStream(payload.reason);
          if (!opened) {
            failReady(`stream closed before open: ${payload.reason}`);
          }
          break;
      }
    });

    await runtime.invoke<{ subscriptionId: string }>("engine_sse_subscribe", {
      options: {
        subscriptionId,
        workspaceId: options.workspaceId,
        baseUrl: options.baseUrl,
        directory: options.directory ?? null,
        connectionKey: options.connectionKey ?? null,
        username: options.username ?? null,
        password: options.password ?? null,
        bearerToken: options.bearerToken ?? null,
      },
    });
    await ready;
  } catch (err) {
    // Couldn't register listener — try to clean up Rust subscription.
    try {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      await runtime.invoke("engine_sse_unsubscribe", { subscriptionId });
    } catch {
      // ignore
    }
    throw err;
  }

  let abortListener: (() => void) | null = null;

  const close = async () => {
    closeStream(closeReason ?? "client-close");
    if (options.signal && abortListener) {
      try {
        options.signal.removeEventListener("abort", abortListener);
      } catch {
        // ignore
      }
      abortListener = null;
    }
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // ignore
      }
      unlisten = null;
    }
    try {
      await runtime.invoke("engine_sse_unsubscribe", { subscriptionId });
    } catch {
      // ignore — Rust side may already be torn down
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      void close();
    } else {
      abortListener = () => {
        void close();
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
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
            if (closeReason === "stream-error") {
              return Promise.reject(new Error(streamErrorMessage ?? "engine SSE stream error"));
            }
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            resolvers.push({ resolve, reject });
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
    subscriptionId,
    stream,
    close,
  };
}

function createSubscriptionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `engine-sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
