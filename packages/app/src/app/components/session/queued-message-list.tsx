import { For, Show, createMemo, createSignal } from "solid-js";
import {
  GripVertical,
  Loader2,
  Pencil,
  X,
} from "lucide-solid";

import { t as tr } from "../../../i18n";
import type { QueuedDraft } from "./session-queue-model.js";

export type QueuedMessageListProps = {
  items: QueuedDraft[];
  onEdit: (id: string) => void;
  onCancel: (id: string) => void;
  onMove: (id: string, targetIndex: number) => void;
};

const isSending = (item: QueuedDraft) => item.state === "sending";
const isMovable = (item: QueuedDraft) => item.state === "queued" || item.state === "error";

const draftPreview = (item: QueuedDraft) => {
  const text = item.draft.text.trim();
  return text.length > 0 ? text : tr("session.queue_message_label");
};

export default function QueuedMessageList(props: QueuedMessageListProps) {
  const [draggedItemId, setDraggedItemId] = createSignal<string | null>(null);
  const hasItems = createMemo(() => props.items.length > 0);
  const movableItems = createMemo(() => props.items.filter(isMovable));

  const movableTargetIndex = (target: QueuedDraft) => {
    if (!isMovable(target)) return -1;
    return movableItems().findIndex((item) => item.id === target.id);
  };

  const handleDragStart = (event: DragEvent, item: QueuedDraft) => {
    if (!isMovable(item)) {
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
      <div class="space-y-1" aria-label={tr("session.queue_message_label")}>
        <For each={props.items}>
          {(item, index) => (
            <div
              class={`group flex items-center gap-2 rounded-lg border border-gray-5/70 bg-gray-2/60 px-2 py-1.5 text-gray-11 transition-colors ${
                isSending(item) ? "opacity-80" : "hover:border-gray-6 hover:bg-gray-2"
              }`}
              draggable={isMovable(item)}
              onDragStart={(event) => handleDragStart(event, item)}
              onDragOver={handleDragOver}
              onDrop={(event) => handleDrop(event, item)}
              onDragEnd={() => setDraggedItemId(null)}
            >
              <div
                class={`shrink-0 rounded-md p-1 text-gray-9 ${
                  isMovable(item) ? "cursor-grab active:cursor-grabbing" : "cursor-default"
                }`}
                title={tr("session.queue_message_label")}
                aria-label={tr("session.queue_message_label")}
              >
                <GripVertical size={14} />
              </div>

              <div class="min-w-0 flex-1 truncate text-xs leading-5 text-gray-11" title={draftPreview(item)}>
                {draftPreview(item)}
              </div>

              <Show
                when={isSending(item)}
                fallback={
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      class="rounded-full p-1 text-gray-10 transition-colors hover:bg-gray-4 hover:text-gray-12"
                      title={tr("common.edit")}
                      aria-label={tr("common.edit")}
                      disabled={isSending(item)}
                      onClick={() => {
                        if (isSending(item)) return;
                        props.onEdit(item.id);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      class="rounded-full p-1 text-gray-10 transition-colors hover:bg-gray-4 hover:text-gray-12"
                      title={tr("session.cancel")}
                      aria-label={tr("session.cancel")}
                      disabled={isSending(item)}
                      onClick={() => {
                        if (isSending(item)) return;
                        props.onCancel(item.id);
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                }
              >
                <div
                  class="shrink-0 rounded-full p-1 text-gray-10"
                  title={tr("session.run_sending")}
                  aria-label={tr("session.run_sending")}
                >
                  <Loader2 size={14} class="animate-spin text-gray-10" />
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
