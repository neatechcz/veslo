import { createContext, createSignal, useContext } from "solid-js";

import type { createClient, OpencodeAuth } from "../lib/opencode";

export type RoutingClient = ReturnType<typeof createClient>;

/**
 * VSLO-86 Task #20 — thrown by guarded `RoutingClient` proxies when the
 * caller-anchored `entryWorkspaceId` no longer matches the currently active
 * workspace.
 *
 * Why: `routedClient()` is read sync, but the SDK methods it returns are
 * called async. A workspace switch between those two events used to silently
 * route the SDK call through the previous workspace's engine. The guard
 * proxies (see `wrapClientWithGuard`) snapshot the workspace ID at lookup
 * time and check it at each method invocation; on mismatch they throw this
 * error so callers can abort cleanly instead of writing to the wrong engine.
 */
export class WorkspaceClientStaleError extends Error {
  constructor(
    public readonly entryWorkspaceId: string,
    public readonly currentWorkspaceId: string,
  ) {
    super(
      `Workspace client is stale: anchored to "${entryWorkspaceId}", active is "${currentWorkspaceId}"`,
    );
    this.name = "WorkspaceClientStaleError";
  }
}

export function isWorkspaceClientStaleError(
  err: unknown,
): err is WorkspaceClientStaleError {
  return err instanceof WorkspaceClientStaleError;
}

/**
 * Recursively proxies a `RoutingClient` so every leaf function call checks
 * `getActiveWsId() === entryWsId` before delegating. Sub-objects (e.g.
 * `client.session`, `client.global`) are wrapped lazily on property access.
 *
 * The guard is intentionally permissive: when `getActiveWsId()` returns an
 * empty string (no active workspace yet — e.g. early bootstrap), the call
 * is allowed through so legitimate startup flows aren't broken.
 */
function wrapClientWithGuard<T extends object>(
  target: T,
  entryWsId: string,
  getActiveWsId: () => string,
): T {
  return new Proxy(target, {
    get(inner, prop, receiver) {
      const value = Reflect.get(inner, prop, receiver);
      if (typeof value === "function") {
        return new Proxy(value as (...args: unknown[]) => unknown, {
          apply(fn, thisArg, args) {
            const current = getActiveWsId();
            if (current && current !== entryWsId) {
              throw new WorkspaceClientStaleError(entryWsId, current);
            }
            return Reflect.apply(fn, thisArg === receiver ? inner : thisArg, args);
          },
        });
      }
      if (value && typeof value === "object") {
        return wrapClientWithGuard(value as object, entryWsId, getActiveWsId);
      }
      return value;
    },
  }) as T;
}

export type ClientEntry = {
  workspaceId: string;
  client: RoutingClient;
  baseUrl: string;
  directory?: string;
  lastUsed: number;
};

/**
 * VSLO-171 — options bag for `ensure()`. Mirrors the parameters
 * connectToServer used to take (directory, auth, workspace context).
 */
export type EnsureOptions = {
  directory?: string;
  auth?: OpencodeAuth;
  context?: {
    workspaceType?: "local" | "remote";
    targetRoot?: string;
    reason?: string;
  };
};

/**
 * VSLO-171 — public surface used by the rest of the app to talk to the
 * OpenCode SDK in a per-workspace world.
 *
 * Each workspace owns its own `Client` instance (created by `ensure`,
 * cached in an internal Map, looked up by `client(workspaceId)`). The
 * caller doesn't need to worry about kill-restart or bootstrap timeouts —
 * a previously-visited workspace re-activates instantly from the cache.
 */
export interface WorkspaceRouting {
  client(workspaceId?: string): RoutingClient | null;
  active(): RoutingClient | null;
  activeWorkspaceId(): string;
  /**
   * VSLO-86 — raw entry lookup so callers (Rust-side SSE proxy) can read
   * `baseUrl`/`directory` without going through the SDK client. Returns the
   * cached `ClientEntry` or `null` if the workspace hasn't been ensured yet.
   */
  entry(workspaceId: string): ClientEntry | null;
  ensure(
    workspaceId: string,
    baseUrl: string,
    options?: EnsureOptions
  ): Promise<ClientEntry | null>;
  lastEnsureError(workspaceId: string): string | null;
  release(workspaceId: string): void;
  forEach(cb: (workspaceId: string, client: RoutingClient) => void): void;
  /**
   * VSLO-86 F4Ú12 — reactive snapshot of currently-ensured workspace IDs.
   * Subscribers (SSE multiplex effect in session.ts) read this to spawn one
   * per-workspace SSE stream and tear them down on release.
   */
  entryIds(): string[];
}

export type CreateWorkspaceRoutingOptions = {
  /**
   * Active workspace's client signal — used as a fallback for `active()`
   * when the active workspace hasn't been ensured yet, and as the source
   * for backwards-compatible callers that read `client` directly.
   */
  clientSource: () => RoutingClient | null;
  activeWorkspaceId: () => string;
  createClient: (
    baseUrl: string,
    directory?: string,
    auth?: OpencodeAuth
  ) => RoutingClient;
  waitForHealthy: (
    client: RoutingClient,
    options?: { timeoutMs?: number }
  ) => Promise<{ healthy: boolean; version?: string }>;
};

export function createWorkspaceRouting(
  opts: CreateWorkspaceRoutingOptions
): WorkspaceRouting {
  const entries = new Map<string, ClientEntry>();
  const ensureErrors = new Map<string, string>();
  // VSLO-86 F4Ú12 — reactive trigger so consumers (SSE multiplex) re-run
  // when workspaces are ensured/released.
  const [entryIdsSignal, setEntryIdsSignal] = createSignal<string[]>([], {
    equals: false,
  });
  const bumpEntryIds = () => setEntryIdsSignal(Array.from(entries.keys()));

  return {
    client(workspaceId?: string) {
      // VSLO-86 Task #20 — anchor the returned client to a snapshot of the
      // workspace ID at lookup time. Caller may pass an explicit ID or rely
      // on the active workspace; either way, all subsequent SDK calls go
      // through guard proxies that re-check the active ID before each call.
      // Workspace switches between this lookup and the async SDK call now
      // surface as `WorkspaceClientStaleError` instead of silently hitting
      // the previous workspace's engine.
      const wsId = workspaceId ?? opts.activeWorkspaceId();
      if (wsId) {
        const entry = entries.get(wsId);
        if (entry) {
          return wrapClientWithGuard(entry.client, wsId, opts.activeWorkspaceId);
        }
        // During local browsing mode the global client can still point at the
        // previously active workspace. Once routing has any workspace entry,
        // a missing entry for the requested/active workspace means "not
        // connected", not "reuse the global client".
        if (workspaceId !== undefined || entries.size > 0) {
          return null;
        }
      }
      return opts.clientSource();
    },
    active() {
      const wsId = opts.activeWorkspaceId();
      if (wsId) {
        const entry = entries.get(wsId);
        if (entry) {
          return wrapClientWithGuard(entry.client, wsId, opts.activeWorkspaceId);
        }
        if (entries.size > 0) {
          return null;
        }
      }
      return opts.clientSource();
    },
    activeWorkspaceId() {
      return opts.activeWorkspaceId();
    },
    entry(workspaceId: string) {
      const id = workspaceId.trim();
      if (!id) return null;
      return entries.get(id) ?? null;
    },
    async ensure(
      workspaceId: string,
      baseUrl: string,
      options?: EnsureOptions
    ) {
      const cached = entries.get(workspaceId);
      if (
        cached &&
        cached.baseUrl === baseUrl &&
        cached.directory === options?.directory
      ) {
        cached.lastUsed = Date.now();
        return cached;
      }
      const client = opts.createClient(
        baseUrl,
        options?.directory,
        options?.auth
      );
      try {
        await opts.waitForHealthy(client, { timeoutMs: 10_000 });
      } catch (error) {
        ensureErrors.set(
          workspaceId,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
      const entry: ClientEntry = {
        workspaceId,
        client,
        baseUrl,
        directory: options?.directory,
        lastUsed: Date.now(),
      };
      entries.set(workspaceId, entry);
      ensureErrors.delete(workspaceId);
      bumpEntryIds();
      return entry;
    },
    lastEnsureError(workspaceId: string) {
      const id = workspaceId.trim();
      if (!id) return null;
      return ensureErrors.get(id) ?? null;
    },
    release(workspaceId: string) {
      ensureErrors.delete(workspaceId);
      if (entries.delete(workspaceId)) bumpEntryIds();
    },
    forEach(cb) {
      for (const [id, entry] of entries) cb(id, entry.client);
    },
    entryIds() {
      return entryIdsSignal();
    },
  };
}

const WorkspaceRoutingContext = createContext<WorkspaceRouting | undefined>(
  undefined
);

export const WorkspaceRoutingProvider = WorkspaceRoutingContext.Provider;

export function useWorkspaceRouting(): WorkspaceRouting {
  const ctx = useContext(WorkspaceRoutingContext);
  if (!ctx) throw new Error("WorkspaceRouting context is missing");
  return ctx;
}

export function useOptionalWorkspaceRouting(): WorkspaceRouting | undefined {
  return useContext(WorkspaceRoutingContext);
}
