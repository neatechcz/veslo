import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";

import type { WorkspaceDisplay } from "../types";
import { computeWorkspaceSwitchOverlayHoldMs } from "../utils/workspace-switch-overlay";

export const WORKSPACE_SWITCH_OVERLAY_DELAY_MS = 250;
export const WORKSPACE_SWITCH_OVERLAY_MIN_VISIBLE_MS = 350;

type WorkspaceSwitchOverlayStateOptions = {
  booting: () => boolean;
  connectingWorkspaceId: () => string | null | undefined;
  activeWorkspaceDisplay: () => WorkspaceDisplay;
  workspaces: () => WorkspaceDisplay[];
  busy: () => boolean;
  busyLabel: () => string | null | undefined;
  now?: () => number;
};

export function resolveWorkspaceSwitchOverlayWorkspace(input: {
  booting: boolean;
  connectingWorkspaceId?: string | null;
  activeWorkspace: WorkspaceDisplay;
  workspaces: WorkspaceDisplay[];
}): WorkspaceDisplay | null {
  if (input.booting) return null;
  const switchingId = input.connectingWorkspaceId?.trim() ?? "";
  if (switchingId) {
    return input.workspaces.find((ws) => ws.id === switchingId) ?? input.activeWorkspace;
  }
  return input.activeWorkspace;
}

export function resolveWorkspaceSwitchOverlayOpen(input: {
  booting: boolean;
  connectingWorkspaceId?: string | null;
  switchDelayElapsed: boolean;
  holdOpen: boolean;
  busy: boolean;
  busyLabel?: string | null;
}): boolean {
  if (input.booting) return true;
  if (input.connectingWorkspaceId) return input.switchDelayElapsed;
  if (input.holdOpen) return true;
  if (!input.busy || !input.busyLabel) return false;
  return input.busyLabel === "status.starting_engine" || input.busyLabel === "status.restarting_engine";
}

export function resolveWorkspaceSwitchOverlayStatusKey(input: {
  busyLabel?: string | null;
  connectingWorkspaceId?: string | null;
  booting: boolean;
}) {
  const label = input.busyLabel;
  if (label === "status.connecting") return "workspace.switching_status_connecting";
  if (label === "status.starting_engine" || label === "status.restarting_engine") {
    return "workspace.switching_status_preparing";
  }
  if (label === "status.loading_session") return "workspace.switching_status_loading";
  if (input.connectingWorkspaceId) return "workspace.switching_status_loading";
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
      connectingWorkspaceId: options.connectingWorkspaceId() ?? null,
      activeWorkspace: options.activeWorkspaceDisplay(),
      workspaces: options.workspaces(),
    }),
  );

  createEffect(() => {
    if (typeof window === "undefined") return;
    const switchingId = options.connectingWorkspaceId();
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
    const connecting = Boolean(options.connectingWorkspaceId());
    const shouldShowForSwitch = connecting && switchDelayElapsed();
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
      connectingWorkspaceId: options.connectingWorkspaceId() ?? null,
      switchDelayElapsed: switchDelayElapsed(),
      holdOpen: holdOpen(),
      busy: options.busy(),
      busyLabel: options.busyLabel() ?? null,
    }),
  );

  const workspaceSwitchStatusKey = createMemo(() =>
    resolveWorkspaceSwitchOverlayStatusKey({
      busyLabel: options.busyLabel() ?? null,
      connectingWorkspaceId: options.connectingWorkspaceId() ?? null,
      booting: options.booting(),
    }),
  );

  return {
    workspaceSwitchWorkspace,
    workspaceSwitchOpen,
    workspaceSwitchStatusKey,
  };
}
