import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "../utils";
import { reportError } from "../lib/error-reporter";
import { wrapStartupRequestAuditFetch } from "../lib/startup-request-audit";
import {
  readVesloServerSettingsToken,
  resolveOpencodeProxyAuthHeaders,
} from "../lib/veslo-server";
import {
  SERVER_ACTIVE_STORAGE_KEY,
  SERVER_LIST_STORAGE_KEY,
  isWorkspaceOpencodeProxyUrl,
  normalizeServerUrl,
  resolveServerProviderInitialState,
  serverDisplayName,
  shouldPersistServerProviderStorage,
} from "./server-url";

export { isWorkspaceOpencodeProxyUrl, normalizeServerUrl, serverDisplayName } from "./server-url";

type ServerContextValue = {
  url: string;
  name: string;
  list: string[];
  healthy: () => boolean | undefined;
  setActive: (url: string) => void;
  add: (url: string) => void;
  remove: (url: string) => void;
};

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

export function ServerProvider(props: ParentProps & { defaultUrl: string }) {
  const [list, setList] = createSignal<string[]>([]);
  const [active, setActiveRaw] = createSignal("");
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [ready, setReady] = createSignal(false);

  const readStoredList = () => {
    try {
      const raw = window.localStorage.getItem(SERVER_LIST_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const readStoredActive = () => {
    try {
      const stored = window.localStorage.getItem(SERVER_ACTIVE_STORAGE_KEY);
      return typeof stored === "string" ? stored : "";
    } catch {
      return "";
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (ready()) return;

    const fallback = normalizeServerUrl(props.defaultUrl) ?? "";

    // In production web builds served by Veslo (Docker "remote" mode), OpenCode
    // traffic should go through the server proxy (usually same-origin `/opencode`).
    // Do not reuse any persisted localhost targets.
    const forceProxy =
      !isTauriRuntime() &&
      (import.meta.env.PROD ||
        (typeof import.meta.env?.VITE_VESLO_URL === "string" &&
          import.meta.env.VITE_VESLO_URL.trim().length > 0));
    if (forceProxy && fallback) {
      const initial = resolveServerProviderInitialState({
        defaultUrl: fallback,
        storedList: [],
        storedActive: "",
        isTauriRuntime: false,
        forceProxy: true,
      });
      setList(initial.list);
      setActiveRaw(initial.active);
      setReady(true);
      return;
    }

    const tauri = isTauriRuntime();
    const initial = resolveServerProviderInitialState({
      defaultUrl: fallback,
      storedList: tauri ? [] : readStoredList(),
      storedActive: tauri ? "" : readStoredActive(),
      isTauriRuntime: tauri,
      forceProxy: false,
    });

    setList(initial.list);
    setActiveRaw(initial.active);
    setReady(true);
  });

  createEffect(() => {
    if (!ready()) return;
    if (typeof window === "undefined") return;

    try {
      if (!shouldPersistServerProviderStorage(isTauriRuntime())) {
        window.localStorage.removeItem(SERVER_LIST_STORAGE_KEY);
        window.localStorage.removeItem(SERVER_ACTIVE_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(SERVER_LIST_STORAGE_KEY, JSON.stringify(list()));
      window.localStorage.setItem(SERVER_ACTIVE_STORAGE_KEY, active());
    } catch {
      // ignore
    }
  });

  const activeUrl = createMemo(() => active());

  const checkHealth = async (url: string) => {
    if (!url) return false;
    if (isWorkspaceOpencodeProxyUrl(url)) {
      return false;
    }
    const headers = resolveOpencodeProxyAuthHeaders({
      baseUrl: url,
      settingsToken: readVesloServerSettingsToken(),
      isTauriRuntime: isTauriRuntime(),
    });
    const client = createOpencodeClient({
      baseUrl: url,
      headers,
      signal: AbortSignal.timeout(3000),
      fetch: isTauriRuntime()
        ? wrapStartupRequestAuditFetch(
            tauriFetch as unknown as typeof globalThis.fetch,
            "tauri.server.health",
          )
        : undefined,
    });
    return client.global
      .health()
      .then((result) => result.data?.healthy === true)
      .catch(e => { reportError(e, "server.healthCheck"); return false; });
  };

  createEffect(() => {
    const url = activeUrl();
    if (!url) return;

    setHealthy(undefined);

    let activeRun = true;
    let busy = false;

    const run = () => {
      if (busy) return;
      busy = true;
      void checkHealth(url)
        .then((next) => {
          if (!activeRun) return;
          setHealthy(next);
        })
        .finally(() => {
          busy = false;
        });
    };

    run();
    const interval = window.setInterval(run, 10_000);

    onCleanup(() => {
      activeRun = false;
      window.clearInterval(interval);
    });
  });

  const setActive = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setActiveRaw(next);
  };

  const add = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => {
      if (current.includes(next)) return current;
      return [...current, next];
    });
    setActiveRaw(next);
  };

  const remove = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => current.filter((item) => item !== next));
    setActiveRaw((current) => {
      if (current !== next) return current;
      const remaining = list().filter((item) => item !== next);
      return remaining[0] ?? "";
    });
  };

  const value: ServerContextValue = {
    get url() {
      return activeUrl();
    },
    get name() {
      return serverDisplayName(activeUrl());
    },
    get list() {
      return list();
    },
    healthy,
    setActive,
    add,
    remove,
  };

  return <ServerContext.Provider value={value}>{props.children}</ServerContext.Provider>;
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error("Server context is missing");
  }
  return context;
}
