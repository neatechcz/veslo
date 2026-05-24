import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const componentUrl = new URL("./queued-message-list.tsx", import.meta.url);
const source = existsSync(componentUrl) ? readFileSync(componentUrl, "utf8") : "";

test("queued message list exposes the queue component contract and visible draft preview", () => {
  assert.match(
    source,
    /import type \{ QueuedDraft \} from "\.\/session-queue-model\.js";/,
    "component should consume QueuedDraft from the queue model",
  );

  assert.match(
    source,
    /export type QueuedMessageListProps = \{\s*items: QueuedDraft\[\];\s*onEdit: \(id: string\) => void;\s*onCancel: \(id: string\) => void;\s*onMove: \(id: string, targetIndex: number\) => void;\s*\};/,
    "component should expose the requested prop contract",
  );

  assert.match(
    source,
    /export default function QueuedMessageList\(props: QueuedMessageListProps\)/,
    "component should export QueuedMessageList as the default component",
  );

  assert.match(
    source,
    /const draftPreview = \(item: QueuedDraft\) =>[\s\S]*item\.draft\.text\.trim\(\)/,
    "rows should derive a visible preview from draft text",
  );

  assert.match(
    source,
    /title=\{draftPreview\(item\)\}[\s\S]*\{draftPreview\(item\)\}/,
    "rows should render the preview text visibly and expose it as a title",
  );
});

test("queued message list renders compact icon controls and sending state", () => {
  assert.match(
    source,
    /import \{[\s\S]*GripVertical,[\s\S]*Loader2,[\s\S]*Pencil,[\s\S]*X,[\s\S]*\} from "lucide-solid";/,
    "component should use the requested lucide icons",
  );

  assert.match(source, /<GripVertical size=\{14\}/, "drag handle should use GripVertical");
  assert.match(source, /<Pencil size=\{14\}/, "edit control should use Pencil");
  assert.match(source, /<X size=\{14\}/, "cancel control should use X");
  assert.match(
    source,
    /<Loader2 size=\{14\} class="animate-spin/,
    "sending state should use an animated Loader2",
  );

  assert.match(
    source,
    /title=\{tr\("common\.edit"\)\}[\s\S]*aria-label=\{tr\("common\.edit"\)\}/,
    "edit button should expose matching title and aria-label",
  );

  assert.match(
    source,
    /title=\{tr\("session\.cancel"\)\}[\s\S]*aria-label=\{tr\("session\.cancel"\)\}/,
    "cancel button should expose matching title and aria-label",
  );
});

test("queued message list guards sending items and wires drag/drop callbacks", () => {
  assert.match(
    source,
    /const isSending = \(item: QueuedDraft\) => item\.state === "sending";/,
    "component should derive sending state from the queue item",
  );

  assert.match(
    source,
    /draggable=\{!isSending\(item\)\}/,
    "sending rows should not be draggable",
  );

  assert.match(
    source,
    /if \(isSending\(item\)\) return;[\s\S]*props\.onEdit\(item\.id\);/,
    "edit handler should not invoke onEdit for sending items",
  );

  assert.match(
    source,
    /if \(isSending\(item\)\) return;[\s\S]*props\.onCancel\(item\.id\);/,
    "cancel handler should not invoke onCancel for sending items",
  );

  assert.match(
    source,
    /onDragStart=\{\(event\) => handleDragStart\(event, item\)\}/,
    "rows should wire drag start through the drag handler",
  );

  assert.match(
    source,
    /onDragOver=\{handleDragOver\}/,
    "rows should allow HTML drag-over drops",
  );

  assert.match(
    source,
    /onDrop=\{\(event\) => handleDrop\(event, index\(\)\)\}/,
    "rows should pass the target row index to the drop handler",
  );

  assert.match(
    source,
    /props\.onMove\(draggedId, targetIndex\);/,
    "drop handler should delegate reordering to the parent with the target index",
  );
});
