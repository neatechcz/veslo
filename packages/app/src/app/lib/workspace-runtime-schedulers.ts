import { createEffect, onCleanup } from "solid-js";

import { recordPerfLog, runtimePerfAuditEnabled } from "./perf-log";

export type PermissionPollingSchedulerOptions = {
  routedWorkspaceCount: () => number;
  activeWorkspaceId: () => string | null;
  activeSendTraceId: () => string | null;
  refreshPendingPermissions: () => Promise<void>;
  intervalMs?: number;
};

export function createPermissionPollingScheduler(options: PermissionPollingSchedulerOptions) {
  const intervalMs = options.intervalMs ?? 5000;

  createEffect(() => {
    const id = window.setInterval(() => {
      const routedWorkspaceCount = options.routedWorkspaceCount();
      if (routedWorkspaceCount <= 1) {
        recordPerfLog(runtimePerfAuditEnabled(), "session.permissions", "poll-skip-single-client", {
          activeWorkspaceId: options.activeWorkspaceId(),
          routedWorkspaceCount,
          activeSendTraceId: options.activeSendTraceId(),
        });
        return;
      }
      void options.refreshPendingPermissions();
    }, intervalMs);
    onCleanup(() => window.clearInterval(id));
  });
}

export type McpAutoRefreshSchedulerOptions = {
  isTauriRuntime: () => boolean;
  engineReady: () => unknown;
  workspaceProjectDir: () => string;
  refreshMcpServers: () => Promise<void>;
};

export function createMcpAutoRefreshScheduler(options: McpAutoRefreshSchedulerOptions) {
  createEffect(() => {
    if (!options.isTauriRuntime()) return;
    options.engineReady();
    const projectDir = options.workspaceProjectDir().trim();
    if (!projectDir) return;
    void options.refreshMcpServers();
  });
}
