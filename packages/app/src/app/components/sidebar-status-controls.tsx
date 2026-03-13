import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Server, Settings, User } from "lucide-solid";

import type { VesloServerStatus } from "../lib/veslo-server";
import {
  formatConnectedUserLabel,
  getUnifiedStatusMeta,
  getVesloStatusMeta,
} from "./sidebar-status-controls.model";

type SidebarStatusControlsProps = {
  clientConnected: boolean;
  vesloServerStatus: VesloServerStatus;
  authenticatedUser?: string | null;
  onOpenSettings: () => void;
};

export default function SidebarStatusControls(props: SidebarStatusControlsProps) {
  const [statusDetailOpen, setStatusDetailOpen] = createSignal(false);
  let statusControlRef: HTMLDivElement | undefined;
  let statusPopoverRef: HTMLDivElement | undefined;

  const toggleStatusDetail = () => setStatusDetailOpen((prev) => !prev);
  const closeStatusDetail = () => setStatusDetailOpen(false);

  createEffect(() => {
    if (!statusDetailOpen()) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (statusControlRef?.contains(target)) return;
      if (statusPopoverRef?.contains(event.target as Node)) return;
      closeStatusDetail();
    };
    window.addEventListener("click", onClick, true);
    onCleanup(() => window.removeEventListener("click", onClick, true));
  });

  const vesloStatusMeta = createMemo(() => getVesloStatusMeta(props.vesloServerStatus));

  const unifiedStatusMeta = createMemo(() => getUnifiedStatusMeta(props.clientConnected, props.vesloServerStatus));
  const authenticatedUserLabel = createMemo(() => formatConnectedUserLabel(props.authenticatedUser));

  return (
    <div class="mt-3 border-t border-gray-6/70 pt-3">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-gray-6 bg-gray-1 text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-11"
          onClick={props.onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={14} />
        </button>

        <div class="relative" ref={(el) => (statusControlRef = el)}>
          <button
            type="button"
            class="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-gray-6 bg-gray-1 transition-colors hover:bg-gray-2"
            onClick={toggleStatusDetail}
            title="Connection status"
            aria-label="Connection status"
          >
            <span class={`h-2 w-2 rounded-full ${unifiedStatusMeta().dot}`} />
          </button>

          <Show when={statusDetailOpen()}>
            <div
              ref={statusPopoverRef}
              class="absolute bottom-full left-0 mb-2 z-[120] w-64 rounded-xl border border-gray-6 bg-gray-2 shadow-xl p-3 space-y-2"
            >
              <div class="text-[11px] font-medium text-gray-11 uppercase tracking-wider">
                Service status
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center gap-1.5 text-xs text-gray-10">
                  <User size={12} class="text-gray-9" />
                  <span>Logged in</span>
                  <span class="ml-auto max-w-[12.5rem] truncate text-right text-gray-11" title={authenticatedUserLabel()}>
                    {authenticatedUserLabel()}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 text-xs text-gray-10">
                  <Server size={12} class="text-gray-9" />
                  <span>Server</span>
                  <span class={`ml-auto ${vesloStatusMeta().text}`}>{vesloStatusMeta().label}</span>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <div
          class="min-w-0 flex-1 inline-flex items-center gap-1.5 rounded-lg border border-gray-6 bg-gray-1 px-2.5 py-1.5 text-xs text-gray-11"
          title={`Logged in user: ${authenticatedUserLabel()}`}
          aria-label={`Logged in user: ${authenticatedUserLabel()}`}
        >
          <User size={12} class="text-gray-9 shrink-0" />
          <span class="truncate">{authenticatedUserLabel()}</span>
        </div>
      </div>
    </div>
  );
}
