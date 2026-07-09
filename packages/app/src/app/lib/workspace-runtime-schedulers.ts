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
  autoRefreshDebounceMs?: number;
  autoRefreshTtlMs?: number;
  now?: () => number;
};

export function mcpAutoRefreshTargetKey(input: {
  workspaceId?: string | null;
  projectDir: string;
}): string {
  return JSON.stringify({
    workspaceId: input.workspaceId?.trim() ?? "",
    projectDir: input.projectDir.trim(),
  });
}

export function shouldRefreshMcpAutoRefreshTarget(input: {
  targetKey: string;
  lastTargetKey: string;
  lastRefreshAt: number;
  now: number;
  ttlMs: number;
}): boolean {
  return input.targetKey !== input.lastTargetKey ||
    input.ttlMs <= 0 ||
    input.now - input.lastRefreshAt >= input.ttlMs;
}

export function createMcpAutoRefreshScheduler(options: McpAutoRefreshSchedulerOptions) {
  let deferredRefreshTimer: number | null = null;
  let autoRefreshTimer: number | null = null;
  let queuedAutoRefreshProjectDir = "";
  let lastAutoRefreshKey = "";
  let lastAutoRefreshAt = 0;
  const autoRefreshDebounceMs = options.autoRefreshDebounceMs ?? 100;
  const autoRefreshTtlMs = options.autoRefreshTtlMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  onCleanup(() => {
    if (deferredRefreshTimer !== null) {
      window.clearTimeout(deferredRefreshTimer);
      deferredRefreshTimer = null;
    }
    if (autoRefreshTimer !== null) {
      window.clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  });

  const refreshIfTargetChangedOrStale = (projectDir: string) => {
    const targetKey = mcpAutoRefreshTargetKey({
      workspaceId: options.activeWorkspaceId?.() ?? "",
      projectDir,
    });
    const nextNow = now();
    const elapsedMs = nextNow - lastAutoRefreshAt;
    if (!shouldRefreshMcpAutoRefreshTarget({
      targetKey,
      lastTargetKey: lastAutoRefreshKey,
      lastRefreshAt: lastAutoRefreshAt,
      now: nextNow,
      ttlMs: autoRefreshTtlMs,
    })) {
      recordPerfLog(runtimePerfAuditEnabled(), "workspace.mcp", "refresh-skip-recent-target", {
        activeWorkspaceId: options.activeWorkspaceId?.() ?? null,
        projectDir,
        elapsedMs,
        ttlMs: autoRefreshTtlMs,
      });
      return;
    }

    lastAutoRefreshKey = targetKey;
    lastAutoRefreshAt = nextNow;
    void options.refreshMcpServers();
  };

  const scheduleAutoRefresh = (projectDir: string) => {
    queuedAutoRefreshProjectDir = projectDir;
    if (autoRefreshTimer !== null) return;
    autoRefreshTimer = window.setTimeout(() => {
      autoRefreshTimer = null;
      if (!options.isTauriRuntime()) return;
      if (options.activeWorkspaceRuntimeReady() === false) return;
      const nextProjectDir = (queuedAutoRefreshProjectDir || options.workspaceProjectDir()).trim();
      queuedAutoRefreshProjectDir = "";
      if (!nextProjectDir) return;
      const nextActiveSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
      if (nextActiveSendTraceId) {
        scheduleDeferredRefresh(nextActiveSendTraceId, nextProjectDir);
        return;
      }
      refreshIfTargetChangedOrStale(nextProjectDir);
    }, autoRefreshDebounceMs);
  };

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
      scheduleAutoRefresh(nextProjectDir);
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
    scheduleAutoRefresh(projectDir);
  });
}
