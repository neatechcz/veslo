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
      <div class="space-y-2" role="list" aria-label={tr("session.server_queue_readonly_label")}>
        <For each={props.items}>
          {(item) => (
            <div
              role="listitem"
              class={`flex items-start gap-3 rounded-xl border bg-gray-1 px-3 py-2.5 text-gray-12 shadow-[0_1px_2px_rgba(17,24,39,0.08)] ${
                item.status === "failed"
                  ? "border-red-7/35 bg-red-2/20"
                  : item.status === "starting"
                    ? "border-blue-7/40 bg-blue-2/20"
                    : "border-gray-6/80"
              }`}
            >
              <div
                class={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                  item.status === "failed"
                    ? "border-red-7/35 bg-red-3/35 text-red-11"
                    : item.status === "starting"
                      ? "border-blue-7/35 bg-blue-3/45 text-blue-11"
                      : "border-gray-6 bg-gray-2 text-gray-10"
                }`}
                aria-hidden="true"
              >
                <Show
                  when={item.status === "failed"}
                  fallback={
                    <Show when={item.status === "starting"} fallback={<Clock3 size={15} />}>
                      <Loader2 size={15} class="animate-spin" />
                    </Show>
                  }
                >
                  <CircleAlert size={15} />
                </Show>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <div class="truncate font-product type-ui-xs font-medium text-gray-12">{serverQueuedRunLabel(item.kind)}</div>
                  <Show when={item.status === "starting"}>
                    <span class="shrink-0 rounded-md border border-blue-7/30 bg-blue-3/40 px-1.5 py-0.5 font-product text-[10px] font-medium text-blue-11">
                      {tr("session.run_sending")}
                    </span>
                  </Show>
                  <Show when={item.status === "failed"}>
                    <span class="shrink-0 rounded-md border border-red-7/30 bg-red-3/35 px-1.5 py-0.5 font-product text-[10px] font-medium text-red-11">
                      {tr("session.pending_submit_failed")}
                    </span>
                  </Show>
                </div>
                <Show when={item.status === "failed" && item.error}>
                  <div class="mt-1 truncate text-[11px] leading-4 text-red-11" title={item.error ?? undefined}>
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
