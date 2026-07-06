import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client";
import { createGlobalEmitter } from "@solid-primitives/event-bus";
import {
  batch,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";

import { extractSessionId } from "../utils";
import { reportError } from "../lib/error-reporter";
import { engineSseSubscribe, isEngineSseAvailable } from "../lib/engine-sse";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import {
  readVesloServerSettingsToken,
  resolveOpencodeProxyAuthHeaders,
} from "../lib/veslo-server";
import { usePlatform } from "./platform";
import { useServer } from "./server";

type GlobalSDKContextValue = {
  url: () => string;
  client: () => ReturnType<typeof createOpencodeClient>;
  event: ReturnType<typeof createGlobalEmitter<{ [key: string]: Event }>>;
};

const GlobalSDKContext = createContext<GlobalSDKContextValue | undefined>(undefined);

export function GlobalSDKProvider(props: ParentProps) {
  const server = useServer();
  const platform = usePlatform();
  const emitter = createGlobalEmitter<{ [key: string]: Event }>();
  const [client, setClient] = createSignal(
    createOpencodeClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      throwOnError: true,
    }),
  );
  const [url, setUrl] = createSignal(server.url);

  createEffect(() => {
    const baseUrl = server.url;
    const isHealthy = server.healthy() === true;

    const settingsToken = readVesloServerSettingsToken();
    const headers = resolveOpencodeProxyAuthHeaders({
      baseUrl,
      settingsToken,
      isTauriRuntime: platform.platform === "desktop",
    });
    const bearerToken = headers ? settingsToken : "";
    setUrl(baseUrl);

    // Always keep the request client in sync with the active URL.
    setClient(
      createOpencodeClient({
        baseUrl,
        headers,
        fetch: platform.fetch,
        throwOnError: true,
      }),
    );

    // Avoid silent retry loops (SSE reconnects) when the dependency is unavailable.
    if (!baseUrl || !isHealthy) {
      return;
    }

    const abort = new AbortController();
    const eventClient = createOpencodeClient({
      baseUrl,
      headers,
      signal: abort.signal,
      fetch: platform.fetch,
    });

    type Queued = { directory: string; payload: Event };

    let queue: Array<Queued | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;

    const keyForEvent = (directory: string, payload: Event) => {
      if (payload.type === "session.status") {
        const sessionID = extractSessionId(payload.properties);
        if (!sessionID) return undefined;
        return `session.status:${directory}:${sessionID}`;
      }
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`;
      if (payload.type === "todo.updated") {
        const sessionID = extractSessionId(payload.properties);
        if (!sessionID) return undefined;
        return `todo.updated:${directory}:${sessionID}`;
      }
      if (payload.type === "mcp.tools.changed") return `mcp.tools.changed:${directory}:${payload.properties.server}`;
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part;
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`;
      }
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const events = queue;
      queue = [];
      coalesced.clear();
      if (events.length === 0) return;

      last = Date.now();
      batch(() => {
        for (const entry of events) {
          if (!entry) continue;
          emitter.emit(entry.directory, entry.payload);
        }
      });
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      timer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    const stop = () => {
      flush();
    };

    // VSLO-86 — keep the SSE stream entirely on the Rust side when running in
    // Tauri. JS-side `eventClient.event.subscribe()` holds the Tauri http
    // plugin's IPC channel open for as long as the stream lives, which
    // blocks every other veslo-server call (health, Soul overview, config
    // patches) until 8-12s timeouts fire and the UI looks frozen for ~60s
    // after boot. The Rust proxy now accepts Bearer auth so the previous
    // 401 reconnect loop (which forced us back onto the SDK path) is gone.
    let rustSubscription: Awaited<ReturnType<typeof engineSseSubscribe>> | null = null;
    let sdkSubscription: Awaited<ReturnType<typeof eventClient.event.subscribe>> | null = null;

    const consumeEvents = async (stream: AsyncIterable<unknown>) => {
      let yielded = Date.now();
      for await (const event of stream) {
        const record = event as Event & { directory?: string; payload?: Event };
        const payload = record.payload ?? record;
        if (!payload?.type) continue;

        const directory = typeof record.directory === "string" ? record.directory : "global";
        const key = keyForEvent(directory, payload);
        if (key) {
          const index = coalesced.get(key);
          if (index !== undefined) {
            queue[index] = undefined;
          }
          coalesced.set(key, queue.length);
        }

        queue.push({ directory, payload });
        schedule();

        if (Date.now() - yielded < 8) continue;
        yielded = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };

    void (async () => {
      if (isEngineSseAvailable()) {
        recordSendWorkflowTrace("global-sdk", "global-sse:rust-proxy", {
          transport: "rust-proxy",
          hasBaseUrl: Boolean(baseUrl),
        });
        rustSubscription = await engineSseSubscribe({
          workspaceId: "__global__",
          baseUrl,
          bearerToken: bearerToken || null,
          signal: abort.signal,
        });
        await consumeEvents(rustSubscription.stream);
      } else {
        recordSendWorkflowTrace("global-sdk", "global-sse:sdk-fallback", {
          transport: "sdk-sse-fallback",
          reason: "engine_sse_unavailable",
          hasBaseUrl: Boolean(baseUrl),
        });
        sdkSubscription = await eventClient.event.subscribe(undefined, { signal: abort.signal });
        await consumeEvents(sdkSubscription.stream as AsyncIterable<unknown>);
      }
    })()
      .finally(stop)
      .catch(e => reportError(e, "sse.subscribe"));

    onCleanup(() => {
      abort.abort();
      if (rustSubscription) {
        void rustSubscription.close().catch(() => {});
        rustSubscription = null;
      }
      stop();
    });
  });

  const value: GlobalSDKContextValue = {
    url,
    client,
    event: emitter,
  };

  return <GlobalSDKContext.Provider value={value}>{props.children}</GlobalSDKContext.Provider>;
}

export function useGlobalSDK() {
  const context = useContext(GlobalSDKContext);
  if (!context) {
    throw new Error("Global SDK context is missing");
  }
  return context;
}
