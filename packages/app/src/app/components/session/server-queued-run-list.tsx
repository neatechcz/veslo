import { For, Show, createMemo } from "solid-js";
import { CircleAlert, Clock3, Loader2 } from "lucide-solid";

import { t as tr } from "../../../i18n";
import type { ServerQueuedRunProjection } from "./server-queue-projection-model.js";

export type ServerQueuedRunListProps = {
  items: ServerQueuedRunProjection[];
};

const serverQueuedRunLabel = (kind: ServerQueuedRunProjection["kind"]) => {
  switch (kind) {
    case "shell":
      return tr("session.server_queue_shell_label");
    case "command":
      return tr("session.server_queue_command_label");
    case "summarize":
      return tr("session.server_queue_summary_label");
    case "prompt_async":
    default:
      return tr("session.server_queue_prompt_label");
  }
};

export default function ServerQueuedRunList(props: ServerQueuedRunListProps) {
  const hasItems = createMemo(() => props.items.length > 0);

  return (
    <Show when={hasItems()}>
      <div class="space-y-1" aria-label={tr("session.server_queue_readonly_label")}>
        <For each={props.items}>
          {(item) => (
            <div class="flex items-center gap-2 rounded-lg border border-blue-6/30 bg-blue-2/30 px-2 py-1.5 text-gray-11">
              <Show
                when={item.status === "failed"}
                fallback={
                  <Show when={item.status === "starting"} fallback={<Clock3 size={14} class="text-blue-10" />}>
                    <Loader2 size={14} class="animate-spin text-blue-10" />
                  </Show>
                }
              >
                <CircleAlert size={14} class="text-red-10" />
              </Show>
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs leading-5 text-gray-11">{serverQueuedRunLabel(item.kind)}</div>
                <Show when={item.status === "failed" && item.error}>
                  <div class="truncate text-[11px] leading-4 text-red-11" title={item.error ?? undefined}>
                    {item.error}
                  </div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
