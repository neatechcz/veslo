import { createMemo } from "solid-js";
import { Cpu, Server, Settings } from "lucide-solid";

import type { VesloServerStatus } from "../lib/veslo-server";

type SidebarStatusControlsProps = {
  clientConnected: boolean;
  vesloServerStatus: VesloServerStatus;
  onOpenSettings: () => void;
};

export default function SidebarStatusControls(props: SidebarStatusControlsProps) {
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
      <div class="rounded-xl border border-gray-6 bg-gray-2/40 px-3 py-2">
        <div class="flex items-center gap-2">
          <span class={`h-2 w-2 rounded-full ${unifiedStatusMeta().dot}`} />
          <span class="text-xs font-medium text-gray-11">Connection</span>
          <span class={`ml-auto text-xs font-medium ${unifiedStatusMeta().text}`}>
            {unifiedStatusMeta().label}
          </span>
        </div>
        <div class="mt-1.5 space-y-1">
          <div class="flex items-center gap-1.5 text-[11px] text-gray-10">
            <Cpu size={12} class="text-gray-9" />
            <span>OpenCode</span>
            <span class={`ml-auto ${opencodeStatusMeta().text}`}>{opencodeStatusMeta().label}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[11px] text-gray-10">
            <Server size={12} class="text-gray-9" />
            <span>Server</span>
            <span class={`ml-auto ${vesloStatusMeta().text}`}>{vesloStatusMeta().label}</span>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-6 bg-gray-1 px-2 py-2 text-xs font-medium text-gray-11 transition-colors hover:bg-gray-2"
        onClick={props.onOpenSettings}
      >
        <Settings size={13} />
        Settings
      </button>
    </div>
  );
}
