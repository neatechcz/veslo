import { createEffect, createRoot, getOwner, onCleanup } from "solid-js";

import { recordPerfLog, runtimePerfAuditEnabled } from "./perf-log";

export type PermissionPollingSchedulerOptions = {
  routedWorkspaceCount: () => number;
  activeWorkspaceId: () => string | null;
  activeSendTraceId: () => string | null;
  anyWorkspaceRuntimeReady?: () => boolean;
  refreshPendingPermissions: () => Promise<void>;
  intervalMs?: number;
};

let unownedPermissionPollingDispose: (() => void) | null = null;

export function createPermissionPollingScheduler(options: PermissionPollingSchedulerOptions) {
  const intervalMs = options.intervalMs ?? 5000;

  const setup = () => createEffect(() => {
    const id = window.setInterval(() => {
      const activeSendTraceId = options.activeSendTraceId();
      if (activeSendTraceId) {
        recordPerfLog(runtimePerfAuditEnabled(), "session.permissions", "poll-skip-active-send", {
          activeWorkspaceId: options.activeWorkspaceId(),
          routedWorkspaceCount: options.routedWorkspaceCount(),
          activeSendTraceId,
        });
        return;
      }
      if (options.anyWorkspaceRuntimeReady?.() === false) {
        return;
      }
      const routedWorkspaceCount = options.routedWorkspaceCount();
      if (routedWorkspaceCount <= 1) {
        return;
      }
      void options.refreshPendingPermissions();
    }, intervalMs);
    onCleanup(() => window.clearInterval(id));
  });

  if (getOwner()) {
    setup();
    return;
  }

  unownedPermissionPollingDispose?.();
  const dispose = createRoot((disposeRoot) => {
    setup();
    return () => {
      disposeRoot();
      if (unownedPermissionPollingDispose === dispose) {
        unownedPermissionPollingDispose = null;
      }
    };
  });
  unownedPermissionPollingDispose = dispose;
}

export type McpAutoRefreshSchedulerOptions = {
  isTauriRuntime: () => boolean;
  activeWorkspaceRuntimeReady: () => unknown;
  activeWorkspaceId?: () => string | null;
  activeSendTraceId?: () => string | null;
  workspaceProjectDir: () => string;
  refreshMcpServers: () => Promise<void>;
};

export function createMcpAutoRefreshScheduler(options: McpAutoRefreshSchedulerOptions) {
  let deferredRefreshTimer: number | null = null;
  onCleanup(() => {
    if (deferredRefreshTimer !== null) {
      window.clearTimeout(deferredRefreshTimer);
      deferredRefreshTimer = null;
    }
  });

  const scheduleDeferredRefresh = (activeSendTraceId: string, projectDir: string) => {
    if (deferredRefreshTimer !== null) return;
    recordPerfLog(runtimePerfAuditEnabled(), "workspace.mcp", "refresh-skip-active-send", {
      activeWorkspaceId: options.activeWorkspaceId?.() ?? null,
      activeSendTraceId,
      projectDir,
    });
    deferredRefreshTimer = window.setTimeout(() => {
      deferredRefreshTimer = null;
      const nextActiveSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
      if (nextActiveSendTraceId) {
        scheduleDeferredRefresh(nextActiveSendTraceId, options.workspaceProjectDir().trim());
        return;
      }
      if (!options.isTauriRuntime()) return;
      const nextProjectDir = options.workspaceProjectDir().trim();
      if (!nextProjectDir) return;
      void options.refreshMcpServers();
    }, 750);
  };

  createEffect(() => {
    if (!options.isTauriRuntime()) return;
    if (options.activeWorkspaceRuntimeReady() === false) return;
    const projectDir = options.workspaceProjectDir().trim();
    if (!projectDir) return;
    const activeSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
    if (activeSendTraceId) {
      scheduleDeferredRefresh(activeSendTraceId, projectDir);
      return;
    }
    void options.refreshMcpServers();
  });
}
