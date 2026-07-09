import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";

import { recordPerfLog } from "../lib/perf-log";
import type { WorkspaceDisplay } from "../types";
import { computeWorkspaceSwitchOverlayHoldMs } from "../utils/workspace-switch-overlay";

const WORKSPACE_SWITCH_OVERLAY_DELAY_MS = 250;
const WORKSPACE_SWITCH_OVERLAY_MIN_VISIBLE_MS = 350;

type WorkspaceSwitchOverlayStateOptions = {
  booting: () => boolean;
  blockingWorkspaceId: () => string | null | undefined;
  activeWorkspaceDisplay: () => WorkspaceDisplay;
  workspaces: () => WorkspaceDisplay[];
  busy: () => boolean;
  busyLabel: () => string | null | undefined;
  now?: () => number;
};

export function resolveWorkspaceSwitchOverlayWorkspace(input: {
  booting: boolean;
  blockingWorkspaceId?: string | null;
  activeWorkspace: WorkspaceDisplay;
  workspaces: WorkspaceDisplay[];
}): WorkspaceDisplay | null {
  if (input.booting) return null;
  const switchingId = input.blockingWorkspaceId?.trim() ?? "";
  if (switchingId) {
    return input.workspaces.find((ws) => ws.id === switchingId) ?? input.activeWorkspace;
  }
  return input.activeWorkspace;
}

export function resolveWorkspaceSwitchOverlayOpen(input: {
  booting: boolean;
  blockingWorkspaceId?: string | null;
  switchDelayElapsed: boolean;
  holdOpen: boolean;
  busy: boolean;
  busyLabel?: string | null;
}): boolean {
  if (input.booting) return true;
  if (input.holdOpen) return true;
  if (input.blockingWorkspaceId) {
    return input.switchDelayElapsed;
  }
  if (!input.busy || !input.busyLabel) return false;
  return false;
}

export function resolveWorkspaceSwitchOverlayStatusKey(input: {
  busyLabel?: string | null;
  blockingWorkspaceId?: string | null;
  booting: boolean;
}) {
  const label = input.busyLabel;
  if (label === "status.connecting") return "workspace.switching_status_connecting";
  if (label === "status.starting_engine" || label === "status.restarting_engine") {
    return "workspace.switching_status_preparing";
  }
  if (label === "status.loading_session") return "workspace.switching_status_loading";
  if (input.blockingWorkspaceId) return "workspace.switching_status_loading";
  if (input.booting) return "workspace.switching_status_preparing";
  return "workspace.switching_status_preparing";
}

export function createWorkspaceSwitchOverlayState(options: WorkspaceSwitchOverlayStateOptions) {
  const now = options.now ?? (() => Date.now());
  const [switchDelayElapsed, setSwitchDelayElapsed] = createSignal(false);
  const [visibleSinceMs, setVisibleSinceMs] = createSignal<number | null>(null);
  const [holdOpen, setHoldOpen] = createSignal(false);

  const workspaceSwitchWorkspace = createMemo(() =>
    resolveWorkspaceSwitchOverlayWorkspace({
      booting: options.booting(),
      blockingWorkspaceId: options.blockingWorkspaceId() ?? null,
      activeWorkspace: options.activeWorkspaceDisplay(),
      workspaces: options.workspaces(),
    }),
  );

  createEffect(() => {
    if (typeof window === "undefined") return;
    const switchingId = options.blockingWorkspaceId();
    if (!switchingId) {
      setSwitchDelayElapsed(false);
      return;
    }

    setSwitchDelayElapsed(false);
    const timer = window.setTimeout(
      () => setSwitchDelayElapsed(true),
      WORKSPACE_SWITCH_OVERLAY_DELAY_MS,
    );
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const shouldShowForSwitch = Boolean(options.blockingWorkspaceId()) && switchDelayElapsed();
    const previousVisibleSinceMs = untrack(visibleSinceMs);

    if (shouldShowForSwitch) {
      setHoldOpen(false);
      if (previousVisibleSinceMs === null) {
        setVisibleSinceMs(now());
      }
      return;
    }

    if (previousVisibleSinceMs === null) return;
    setVisibleSinceMs(null);

    const holdMs = computeWorkspaceSwitchOverlayHoldMs({
      visibleSinceMs: previousVisibleSinceMs,
      nowMs: now(),
      minVisibleMs: WORKSPACE_SWITCH_OVERLAY_MIN_VISIBLE_MS,
    });
    if (holdMs <= 0) {
      setHoldOpen(false);
      return;
    }

    setHoldOpen(true);
    const timer = window.setTimeout(() => {
      setHoldOpen(false);
    }, holdMs);
    onCleanup(() => window.clearTimeout(timer));
  });

  const workspaceSwitchOpen = createMemo(() =>
    resolveWorkspaceSwitchOverlayOpen({
      booting: options.booting(),
      blockingWorkspaceId: options.blockingWorkspaceId() ?? null,
      switchDelayElapsed: switchDelayElapsed(),
      holdOpen: holdOpen(),
      busy: options.busy(),
      busyLabel: options.busyLabel() ?? null,
    }),
  );

  const workspaceSwitchStatusKey = createMemo(() =>
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: options.busyLabel() ?? null,
      blockingWorkspaceId: options.blockingWorkspaceId() ?? null,
      booting: options.booting(),
    }),
  );

  let lastLoggedOpen = false;
  let openLoggedAt: number | null = null;
  createEffect(() => {
    const open = workspaceSwitchOpen();
    const workspace = workspaceSwitchWorkspace();
    const nowMs = now();
    if (open === lastLoggedOpen) return;
    if (open) {
      openLoggedAt = nowMs;
      recordPerfLog(true, "workspace.overlay", "open", {
        workspaceId: workspace?.id ?? null,
        blockingWorkspaceId: options.blockingWorkspaceId() ?? null,
        busy: options.busy(),
        busyLabel: options.busyLabel() ?? null,
        statusKey: workspaceSwitchStatusKey(),
      });
    } else {
      recordPerfLog(true, "workspace.overlay", "close", {
        workspaceId: workspace?.id ?? null,
        blockingWorkspaceId: options.blockingWorkspaceId() ?? null,
        busy: options.busy(),
        busyLabel: options.busyLabel() ?? null,
        ms: openLoggedAt === null ? null : Math.max(0, Math.round(nowMs - openLoggedAt)),
      });
      openLoggedAt = null;
    }
    lastLoggedOpen = open;
  });

  return {
    workspaceSwitchWorkspace,
    workspaceSwitchOpen,
    workspaceSwitchStatusKey,
  };
}
