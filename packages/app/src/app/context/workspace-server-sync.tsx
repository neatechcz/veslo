import { createEffect, untrack } from "solid-js";

import { engineInfo } from "../lib/tauri";
import { isTauriRuntime } from "../utils";

import { useServer } from "./server";
import type { WorkspaceStore } from "./workspace";

/**
 * VSLO-171 F2Ú7 wiring: when the active workspace changes, ask the orchestrator
 * for the per-workspace engine base_url and publish it to ServerContext. The
 * global OpenCode SDK client (`global-sdk.tsx`) is reactive on `server.url` and
 * reinitializes automatically — all subsequent `c.session.*` calls go through
 * the orchestrator pool proxy `/workspace/:id/opencode/*` instead of the legacy
 * singleton.
 *
 * Renders nothing; lives in the App tree so it can read `workspaceStore` and
 * write to `ServerContext` in the same Solid reactive scope.
 *
 * No-op in non-Tauri runtimes — web build keeps using the veslo-server proxy.
 */
export function WorkspaceServerSync(props: {
  workspaceStore: WorkspaceStore;
  orchestratorPort?: () => number | null;
}) {
  const server = useServer();
  let inFlightWorkspaceServerSyncKey = "";
  let lastResolvedWorkspaceServerSyncKey = "";
  let lastResolvedWorkspaceServerSyncUrl = "";
  let latestWorkspaceServerSyncKey = "";

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const workspaceId = props.workspaceStore.activeWorkspaceId().trim();
    if (!workspaceId) return;
    // Pass path so Rust engine_info can fall back to path-based lookup when
    // the frontend workspace ID doesn't match the orchestrator's (independent
    // ID stores). Without it the proxy URL embeds the frontend ID and the
    // orchestrator returns 404.
    const workspacePath = props.workspaceStore.activeWorkspacePath().trim();

    // Re-track when the orchestrator daemon port changes (dev-session restart).
    // Only updates while developer mode is on — that's a known limitation we
    // accept here. We DO NOT run a background setInterval; previous attempts
    // leaked timers when the component unmounted under HMR, leading to
    // hundreds of pending HTTP requests against veslo-server (~500% CPU).
    const orchestratorPort = props.orchestratorPort?.() ?? null;
    const currentServerUrl = server.url;
    const syncKey = [workspaceId, workspacePath, orchestratorPort ?? ""].join("::");
    latestWorkspaceServerSyncKey = syncKey;
    if (syncKey === inFlightWorkspaceServerSyncKey) return;
    if (
      syncKey === lastResolvedWorkspaceServerSyncKey &&
      currentServerUrl === lastResolvedWorkspaceServerSyncUrl
    ) return;

    inFlightWorkspaceServerSyncKey = syncKey;
    void engineInfo(workspaceId, workspacePath || undefined)
      .then((info) => untrack(() => {
        if (latestWorkspaceServerSyncKey !== syncKey) return;
        const nextUrl = info.baseUrl?.trim();
        if (!nextUrl) return;
        lastResolvedWorkspaceServerSyncKey = syncKey;
        lastResolvedWorkspaceServerSyncUrl = nextUrl;
        if (nextUrl === server.url) return;
        server.setActive(nextUrl);
        void props.workspaceStore.refreshActiveClient(nextUrl);
      }))
      .catch(() => {
        // Engine not yet known to orchestrator (lazy spawn happens on first
        // proxy request). SDK will retry on the next workspace switch.
      })
      .finally(() => {
        if (inFlightWorkspaceServerSyncKey === syncKey) {
          inFlightWorkspaceServerSyncKey = "";
        }
      });
  });

  return null;
}
