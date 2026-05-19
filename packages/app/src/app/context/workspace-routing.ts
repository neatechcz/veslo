import { createContext, useContext } from "solid-js";

import type { createClient, OpencodeAuth } from "../lib/opencode";

export type RoutingClient = ReturnType<typeof createClient>;

export type WorkspaceRoutingMode = "single-active" | "multi";

export type ClientEntry = {
  workspaceId: string;
  client: RoutingClient;
  baseUrl: string;
  directory?: string;
  lastUsed: number;
};

/**
 * VSLO-171 F3Ú5 — options bag for `ensure()`. Mirrors connectToServer's
 * parameters so future multi-mode impl can carry the same context.
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
 * VSLO-171 F3Ú1 — public surface used by the rest of the app to talk to the
 * OpenCode SDK in a per-workspace world.
 *
 * In `single-active` mode the routing is a thin adapter over the existing
 * global `client()` signal in `app.tsx` — `client(workspaceId?)` ignores the
 * workspace id and returns the active client, `ensure`/`release` are no-ops,
 * and `forEach` iterates a single entry (the active one). This lets us migrate
 * the ~71 call sites incrementally without behavior change.
 *
 * In `multi` mode (F3Ú6+) the routing keeps a Map<workspaceId, ClientEntry>
 * and `ensure` actually creates a fresh Client per workspace; until then the
 * multi branch is a skeleton that records entries but still returns the
 * global client (no real per-workspace isolation yet).
 */
export interface WorkspaceRouting {
  mode(): WorkspaceRoutingMode;
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
  mode: () => WorkspaceRoutingMode;
  clientSource: () => RoutingClient | null;
  activeWorkspaceId: () => string;
};

export function createWorkspaceRouting(
  opts: CreateWorkspaceRoutingOptions
): WorkspaceRouting {
  // VSLO-171 F3Ú5 — per-workspace cache. In single-active mode this stays
  // empty and `ensure` returns a wrap over the global client. In multi mode
  // (F3Ú6+) `ensure` creates a fresh Client per workspace and stores it here;
  // today the multi branch records the entry but still returns the global
  // client, so behavior is unchanged.
  const entries = new Map<string, ClientEntry>();

  return {
    mode: () => opts.mode(),
    client(workspaceId?: string) {
      if (opts.mode() === "multi" && workspaceId) {
        const entry = entries.get(workspaceId);
        if (entry) return entry.client;
      }
      return opts.clientSource();
    },
    active() {
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
      const c = opts.clientSource();
      if (!c) return null;
      if (opts.mode() === "multi") {
        // Skeleton: record entry so forEach/client(wsId) can find it. Real
        // per-workspace client creation lands in F3Ú6 (today still hands back
        // the active client — no behavior change).
        const entry: ClientEntry = {
          workspaceId,
          client: c,
          baseUrl,
          directory: options?.directory,
          lastUsed: Date.now(),
        };
        entries.set(workspaceId, entry);
        return entry;
      }
      return {
        workspaceId: opts.activeWorkspaceId(),
        client: c,
        baseUrl,
        directory: options?.directory,
        lastUsed: Date.now(),
      };
    },
    release(workspaceId: string) {
      if (opts.mode() !== "multi") return;
      entries.delete(workspaceId);
    },
    forEach(cb) {
      if (opts.mode() === "multi") {
        for (const [id, entry] of entries) cb(id, entry.client);
        return;
      }
      const c = opts.clientSource();
      if (!c) return;
      const wsId = opts.activeWorkspaceId();
      if (!wsId) return;
      cb(wsId, c);
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
