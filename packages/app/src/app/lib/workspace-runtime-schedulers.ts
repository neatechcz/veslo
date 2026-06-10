import { createEffect, createRoot, getOwner, onCleanup } from "solid-js";

import { recordPerfLog, runtimePerfAuditEnabled } from "./perf-log";

export type PermissionPollingSchedulerOptions = {
  routedWorkspaceCount: () => number;
  activeWorkspaceId: () => string | null;
  activeSendTraceId: () => string | null;
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
