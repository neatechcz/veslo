import { createEffect } from "solid-js";

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
export function WorkspaceServerSync(props: { workspaceStore: WorkspaceStore }) {
  const server = useServer();

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const workspaceId = props.workspaceStore.activeWorkspaceId().trim();
    if (!workspaceId) return;

    void engineInfo(workspaceId)
      .then((info) => {
        const nextUrl = info.baseUrl?.trim();
        if (!nextUrl) return;
        if (nextUrl === server.url) return;
        server.setActive(nextUrl);
      })
      .catch(() => {
        // Engine not yet known to orchestrator (lazy spawn happens on first
        // proxy request). Server URL stays on previous value; the SDK will
        // retry on next workspace switch or after manual refresh.
      });
  });

  return null;
}
