import { For, Show, createMemo, createSignal } from "solid-js";
import {
  CircleAlert,
  Clock3,
  GripVertical,
  Loader2,
  Pencil,
  RotateCcw,
  X,
} from "lucide-solid";

import { t as tr } from "../../../i18n";
import Button from "../button";
import type { QueuedDraft } from "./session-queue-model.js";
import {
  canReorderQueuedMessages,
  isQueuedMessageMovable,
  movableQueueTargetIndex,
} from "./queued-message-list-model.js";

export type QueuedMessageListProps = {
  items: QueuedDraft[];
  onEdit: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onMove: (id: string, targetIndex: number) => void;
};

const isSending = (item: QueuedDraft) => item.state === "sending";
const isRetryable = (item: QueuedDraft, index: number) => item.state === "error" && index === 0;

const draftPreview = (item: QueuedDraft) => {
  const text = item.draft.text.trim();
  return text.length > 0 ? text : tr("session.queue_message_label");
};

export default function QueuedMessageList(props: QueuedMessageListProps) {
  const [draggedItemId, setDraggedItemId] = createSignal<string | null>(null);
  const hasItems = createMemo(() => props.items.length > 0);
  const canReorder = createMemo(() => canReorderQueuedMessages(props.items));
  const movableItems = createMemo(() => props.items.filter(isQueuedMessageMovable));

  const movableTargetIndex = (target: QueuedDraft) => {
    return movableQueueTargetIndex(props.items, target.id);
  };

  const handleMoveKeyDown = (event: KeyboardEvent, item: QueuedDraft) => {
    if (!canReorder() || !isQueuedMessageMovable(item)) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    event.preventDefault();
    const currentIndex = movableQueueTargetIndex(props.items, item.id);
    if (currentIndex === -1) return;
    const targetIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= movableItems().length) return;
    props.onMove(item.id, targetIndex);
  };

  const handleDragStart = (event: DragEvent, item: QueuedDraft) => {
    if (!canReorder() || !isQueuedMessageMovable(item)) {
      event.preventDefault();
      return;
    }

    setDraggedItemId(item.id);
    event.dataTransfer?.setData("text/plain", item.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (event: DragEvent, target: QueuedDraft) => {
    event.preventDefault();
    const transferredId = event.dataTransfer?.getData("text/plain");
    const draggedId = transferredId && transferredId.length > 0 ? transferredId : draggedItemId();
    if (!draggedId) return;
    const targetIndex = movableTargetIndex(target);
    if (targetIndex === -1) return;

    setDraggedItemId(null);
    props.onMove(draggedId, targetIndex);
  };

  return (
    <Show when={hasItems()}>
      <div class="space-y-2" role="list" aria-label={tr("session.queued_message_title")}>
        <For each={props.items}>
          {(item, index) => (
            <div
              role="listitem"
              data-testid="session-local-queue-row"
              data-queue-owner="local"
              data-queue-item-id={item.id}
              data-client-message-id={item.clientMessageId}
              data-queue-state={item.state}
              class={`group flex items-start gap-3 rounded-xl border border-gray-6/80 bg-gray-1 px-3 py-2.5 text-gray-12 shadow-[0_1px_2px_rgba(17,24,39,0.08)] transition-colors ${
                isSending(item)
                  ? "border-blue-7/40 bg-blue-2/20"
                  : item.state === "error"
                    ? "border-red-7/35 bg-red-2/20"
                    : "hover:border-gray-7 hover:bg-gray-2/70"
              }`}
              draggable={canReorder() && isQueuedMessageMovable(item)}
              onDragStart={(event) => handleDragStart(event, item)}
              onDragOver={handleDragOver}
              onDrop={(event) => handleDrop(event, item)}
              onDragEnd={() => setDraggedItemId(null)}
            >
              <Button
                variant="ghost"
                disabled={!canReorder() || !isQueuedMessageMovable(item)}
                onKeyDown={(event) => handleMoveKeyDown(event, item)}
                class={`mt-0.5 h-7 w-7 shrink-0 rounded-md p-0 text-gray-9 ${
                  canReorder() && isQueuedMessageMovable(item)
                    ? "cursor-grab hover:bg-gray-3 active:cursor-grabbing"
                    : "cursor-default"
                }`}
                title={tr("session.reorder_queued_message")}
                aria-label={tr("session.reorder_queued_message")}
              >
                <GripVertical size={14} />
              </Button>

              <div
                class={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                  item.state === "error"
                    ? "border-red-7/35 bg-red-3/35 text-red-11"
                    : isSending(item)
                      ? "border-blue-7/35 bg-blue-3/45 text-blue-11"
                      : "border-gray-6 bg-gray-2 text-gray-10"
                }`}
                aria-hidden="true"
              >
                <Show
                  when={item.state === "error"}
                  fallback={
                    <Show when={isSending(item)} fallback={<Clock3 size={15} />}>
                      <Loader2 size={15} class="animate-spin" />
                    </Show>
                  }
                >
                  <CircleAlert size={15} />
                </Show>
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <div class="truncate font-product type-ui-xs font-medium text-gray-12">
                    {tr("session.queued_message_title")}
                  </div>
                  <Show when={isSending(item)}>
                    <span class="shrink-0 rounded-md border border-blue-7/30 bg-blue-3/40 px-1.5 py-0.5 font-product text-[10px] font-medium text-blue-11">
                      {tr("session.run_sending")}
                    </span>
                  </Show>
                  <Show when={item.state === "error"}>
                    <span class="shrink-0 rounded-md border border-red-7/30 bg-red-3/35 px-1.5 py-0.5 font-product text-[10px] font-medium text-red-11">
                      {tr("session.pending_submit_failed")}
                    </span>
                  </Show>
                </div>
                <div class="mt-0.5 truncate text-sm leading-5 text-gray-11" title={draftPreview(item)}>
                  {draftPreview(item)}
                </div>
                <Show when={item.state === "error" && item.error}>
                  <div class="mt-1 truncate text-[11px] leading-4 text-red-11" title={item.error}>
                    {item.error}
                  </div>
                </Show>
              </div>

              <Show
                when={isSending(item)}
                fallback={
                  <div class="flex shrink-0 items-center gap-1 pt-0.5">
                    <Show when={isRetryable(item, index())}>
                      <Button
                        variant="ghost"
                        class="h-7 w-7 p-0"
                        title={tr("common.retry")}
                        aria-label={tr("common.retry")}
                        onClick={() => props.onRetry(item.id)}
                      >
                        <RotateCcw size={14} />
                      </Button>
                    </Show>
                    <Button
                      variant="ghost"
                      class="h-7 w-7 p-0"
                      title={tr("common.edit")}
                      aria-label={tr("common.edit")}
                      disabled={isSending(item)}
                      onClick={() => {
                        if (isSending(item)) return;
                        props.onEdit(item.id);
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      class="h-7 w-7 p-0"
                      title={tr("session.cancel")}
                      aria-label={tr("session.cancel")}
                      disabled={isSending(item)}
                      onClick={() => {
                        if (isSending(item)) return;
                        props.onCancel(item.id);
                      }}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                }
              >
                <div
                  class="shrink-0 pt-1 text-blue-10"
                  title={tr("session.run_sending")}
                  aria-label={tr("session.run_sending")}
                >
                  <Loader2 size={15} class="animate-spin" />
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
