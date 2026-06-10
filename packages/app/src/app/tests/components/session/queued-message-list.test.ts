import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import type { ComposerDraft } from "../../../types";
import type { QueuedDraft } from "../../../components/session/session-queue-model.js";
import { isQueuedMessageMovable, movableQueueTargetIndex } from "../../../components/session/queued-message-list-model.js";

const componentUrl = new URL("../../../components/session/queued-message-list.tsx", import.meta.url);
const source = existsSync(componentUrl) ? readFileSync(componentUrl, "utf8") : "";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

const item = (id: string, state: QueuedDraft["state"], text = id): QueuedDraft => ({
  id,
  draft: draft(text),
  createdAt: 100,
  updatedAt: 100,
  state,
});

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
    /import \{ isQueuedMessageMovable, movableQueueTargetIndex \} from "\.\/queued-message-list-model\.js";/,
    "component should align movable rows with the queue model's drain-eligible states",
  );

  assert.match(
    source,
    /draggable=\{isQueuedMessageMovable\(item\)\}/,
    "only movable rows should be draggable",
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
    /onDrop=\{\(event\) => handleDrop\(event, item\)\}/,
    "rows should pass the target row to the drop handler",
  );

  assert.match(
    source,
    /const targetIndex = movableTargetIndex\(target\);[\s\S]*if \(targetIndex === -1\) return;[\s\S]*props\.onMove\(draggedId, targetIndex\);/,
    "drop handler should convert the visual target row into a movable subset target index",
  );
});

test("queued message list computes drop target index in the movable subset", () => {
  const items = [
    item("sending", "sending"),
    item("first", "queued"),
    item("editing", "editing"),
    item("second", "queued"),
    item("failed", "error"),
  ];

  assert.equal(movableQueueTargetIndex(items, "first"), 0);
  assert.equal(movableQueueTargetIndex(items, "second"), 1);
  assert.equal(movableQueueTargetIndex(items, "failed"), 2);
  assert.equal(movableQueueTargetIndex(items, "sending"), -1);
  assert.equal(movableQueueTargetIndex(items, "editing"), -1);
  assert.equal(isQueuedMessageMovable(items[1]!), true);
  assert.equal(isQueuedMessageMovable(items[2]!), false);
});

test("queued message list exposes keyboard reordering on the drag handle", () => {
  assert.match(
    source,
    /const handleMoveKeyDown = \(event: KeyboardEvent, item: QueuedDraft\) => \{/,
    "component should handle keyboard reordering from the drag handle",
  );

  assert.match(
    source,
    /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/,
    "keyboard reordering should use arrow keys",
  );

  assert.match(
    source,
    /const targetIndex = currentIndex \+ \(event\.key === "ArrowUp" \? -1 : 1\);[\s\S]*props\.onMove\(item\.id, targetIndex\);/,
    "keyboard reordering should move within the movable subset",
  );

  assert.match(
    source,
    /<button[\s\S]*onKeyDown=\{\(event\) => handleMoveKeyDown\(event, item\)\}[\s\S]*aria-label=\{tr\("session\.reorder_queued_message"\)\}/,
    "drag handle should be keyboard-focusable and labelled",
  );
});
