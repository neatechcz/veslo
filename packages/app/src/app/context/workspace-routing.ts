import { createContext, useContext } from "solid-js";

import type { createClient, OpencodeAuth } from "../lib/opencode";

export type RoutingClient = ReturnType<typeof createClient>;

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
  ensure(
    workspaceId: string,
    baseUrl: string,
    options?: EnsureOptions
  ): Promise<ClientEntry | null>;
  release(workspaceId: string): void;
  forEach(cb: (workspaceId: string, client: RoutingClient) => void): void;
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

  return {
    client(workspaceId?: string) {
      if (workspaceId) {
        const entry = entries.get(workspaceId);
        if (entry) return entry.client;
      }
      return opts.clientSource();
    },
    active() {
      const wsId = opts.activeWorkspaceId();
      if (wsId) {
        const entry = entries.get(wsId);
        if (entry) return entry.client;
      }
      return opts.clientSource();
    },
    activeWorkspaceId() {
      return opts.activeWorkspaceId();
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
      } catch {
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
      return entry;
    },
    release(workspaceId: string) {
      entries.delete(workspaceId);
    },
    forEach(cb) {
      for (const [id, entry] of entries) cb(id, entry.client);
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
