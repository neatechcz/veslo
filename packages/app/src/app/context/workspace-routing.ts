import { createContext, useContext } from "solid-js";

import type { createClient } from "../lib/opencode";

export type RoutingClient = ReturnType<typeof createClient>;

export type WorkspaceRoutingMode = "single-active" | "multi";

export type ClientEntry = {
  workspaceId: string;
  client: RoutingClient;
  baseUrl: string;
  lastUsed: number;
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
 * The `multi` mode contract (true per-workspace clients, lifecycle, SSE pools)
 * is wired up in F3Ú5 / F3Ú6. Until then `mode()` returns `"single-active"`.
 */
export interface WorkspaceRouting {
  mode(): WorkspaceRoutingMode;
  client(workspaceId?: string): RoutingClient | null;
  active(): RoutingClient | null;
  activeWorkspaceId(): string;
  ensure(workspaceId: string, baseUrl: string): Promise<ClientEntry | null>;
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
  return {
    mode: () => opts.mode(),
    client(_workspaceId?: string) {
      return opts.clientSource();
    },
    active() {
      return opts.clientSource();
    },
    activeWorkspaceId() {
      return opts.activeWorkspaceId();
    },
    async ensure(_workspaceId: string, baseUrl: string) {
      const c = opts.clientSource();
      if (!c) return null;
      return {
        workspaceId: opts.activeWorkspaceId(),
        client: c,
        baseUrl,
        lastUsed: Date.now(),
      };
    },
    release(_workspaceId: string) {
      // no-op in single-active mode
    },
    forEach(cb) {
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
