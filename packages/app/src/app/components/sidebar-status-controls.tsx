import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Cpu, Server, Settings } from "lucide-solid";

import type { VesloServerStatus } from "../lib/veslo-server";

type SidebarStatusControlsProps = {
  clientConnected: boolean;
  vesloServerStatus: VesloServerStatus;
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

  const opencodeStatusMeta = createMemo(() =>
    props.clientConnected
      ? { text: "text-green-11", label: "Connected" }
      : { text: "text-gray-10", label: "Offline" },
  );

  const vesloStatusMeta = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return { text: "text-green-11", label: "Connected" };
      case "limited":
        return { text: "text-amber-11", label: "Limited" };
      default:
        return { text: "text-gray-10", label: "Unavailable" };
    }
  });

  const unifiedStatusMeta = createMemo(() =>
    props.clientConnected && props.vesloServerStatus === "connected"
      ? { dot: "bg-green-9", text: "text-green-11", label: "Ready" }
      : { dot: "bg-red-9", text: "text-red-11", label: "Unavailable" },
  );

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

        <div class="relative min-w-0 flex-1" ref={(el) => (statusControlRef = el)}>
          <button
            type="button"
            class="w-full inline-flex items-center gap-2 rounded-lg border border-gray-6 bg-gray-1 px-2.5 py-1.5 text-xs transition-colors hover:bg-gray-2"
            onClick={toggleStatusDetail}
            title="Connection status"
            aria-label="Connection status"
          >
            <span class={`h-2 w-2 rounded-full ${unifiedStatusMeta().dot}`} />
            <span class={`font-medium ${unifiedStatusMeta().text}`}>{unifiedStatusMeta().label}</span>
          </button>

          <Show when={statusDetailOpen()}>
            <div
              ref={statusPopoverRef}
              class="absolute bottom-full left-0 mb-2 z-[120] w-56 rounded-xl border border-gray-6 bg-gray-2 shadow-xl p-3 space-y-2"
            >
              <div class="text-[11px] font-medium text-gray-11 uppercase tracking-wider">
                Service status
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center gap-1.5 text-xs text-gray-10">
                  <Cpu size={12} class="text-gray-9" />
                  <span>OpenCode</span>
                  <span class={`ml-auto ${opencodeStatusMeta().text}`}>{opencodeStatusMeta().label}</span>
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
      </div>
    </div>
  );
}
