# Session Message Editing And Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe latest-message editing plus a session-local queued message flow where Enter queues during active runs and Ctrl+Enter sends immediately.

**Architecture:** Keep the runtime sequential by default. Put queue and transcript-replacement orchestration in the session page/app layer, keep pure decision logic in small tested helpers, and let message/composer components render actions from explicit props. Use OpenCode `session.revert` for transcript replacement rather than mutating stored message records.

**Tech Stack:** SolidJS signals and memos, TypeScript, OpenCode SDK session APIs, lucide-solid icons, node:test app tests, WebdriverIO desktop E2E in the real Tauri runtime.

---

## Required Skills And Docs

- Use `@solidjs-patterns` before editing SolidJS state or TSX.
- Use `@test-driven-development` for implementation tasks.
- Use `@systematic-debugging` if a test or runtime flow fails unexpectedly.
- Use `@verification-before-completion` before claiming completion.
- Follow `docs/dev/testing-playbook.md`; do not use raw Vite or `packages/web` as proof.

## Task 1: Queue Model Helper

**Files:**
- Create: `packages/app/src/app/components/session/session-queue-model.ts`
- Create: `packages/app/src/app/components/session/session-queue-model.test.ts`

**Step 1: Write the failing test**

Add tests for append, update, remove, reorder, sending, error, and drain eligibility.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ComposerDraft } from "../../types";
import {
  appendQueuedDraft,
  firstQueuedDraft,
  markQueuedDraftError,
  markQueuedDraftSending,
  moveQueuedDraft,
  removeQueuedDraft,
  updateQueuedDraft,
} from "./session-queue-model";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("queue model appends and returns the first non-sending item", () => {
  const queue = appendQueuedDraft([], draft("one"), 100);
  const next = appendQueuedDraft(queue, draft("two"), 200);
  assert.equal(next.length, 2);
  assert.equal(firstQueuedDraft(next)?.draft.text, "one");
});

test("queue model reorders only queued items", () => {
  const queue = [
    ...appendQueuedDraft([], draft("one"), 100),
    ...appendQueuedDraft([], draft("two"), 200),
  ];
  const moved = moveQueuedDraft(queue, queue[1]!.id, 0);
  assert.deepEqual(moved.map((item) => item.draft.text), ["two", "one"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/session-queue-model.test.ts
```

Expected: FAIL because `session-queue-model.ts` does not exist.

**Step 3: Write minimal implementation**

Implement a pure model with immutable updates.

```ts
import type { ComposerDraft } from "../../types";

export type QueuedDraftState = "queued" | "editing" | "sending" | "error";

export type QueuedDraft = {
  id: string;
  draft: ComposerDraft;
  createdAt: number;
  updatedAt: number;
  state: QueuedDraftState;
  error?: string;
};

const createQueueId = () => `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function appendQueuedDraft(queue: QueuedDraft[], draft: ComposerDraft, now = Date.now()): QueuedDraft[] {
  return [...queue, { id: createQueueId(), draft, createdAt: now, updatedAt: now, state: "queued" }];
}

export function firstQueuedDraft(queue: QueuedDraft[]): QueuedDraft | null {
  return queue.find((item) => item.state === "queued" || item.state === "error") ?? null;
}
```

Add the rest of the helpers used by the tests:

- `updateQueuedDraft(queue, id, draft, now)`
- `removeQueuedDraft(queue, id)`
- `moveQueuedDraft(queue, id, targetIndex)`
- `markQueuedDraftSending(queue, id)`
- `markQueuedDraftError(queue, id, error)`
- `markQueuedDraftQueued(queue, id)`

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/session-queue-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/session-queue-model.ts packages/app/src/app/components/session/session-queue-model.test.ts
git commit -m "test: add session queue model"
```

## Task 2: Transcript Editability Helper

**Files:**
- Create: `packages/app/src/app/components/session/message-editability.ts`
- Create: `packages/app/src/app/components/session/message-editability.test.ts`

**Step 1: Write the failing test**

Cover these cases:

- latest user message is editable when only reasoning/read/search/list activity follows
- visible assistant text blocks editing
- mutating tools block editing
- shell/terminal tools block editing by default
- older user messages are not editable
- unreconstructable attachments block editing

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Part } from "@opencode-ai/sdk/v2/client";
import type { MessageWithParts } from "../../types";
import { getEditableUserMessageDraft } from "./message-editability";

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}:text`,
  sessionID: "s1",
  messageID,
  type: "text",
  text,
} as Part);

const message = (id: string, role: "user" | "assistant", parts: Part[]): MessageWithParts => ({
  info: { id, role } as any,
  parts,
});

test("allows editing latest user message after read-only assistant activity", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [{ id: "p1", sessionID: "s1", messageID: "m2", type: "tool", tool: "read" } as any]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });
  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/message-editability.test.ts
```

Expected: FAIL because the helper does not exist.

**Step 3: Write minimal implementation**

Implement a conservative allowlist:

```ts
const READ_ONLY_TOOLS = new Set(["read", "list", "grep", "glob", "webfetch", "search"]);

function isAllowedPostUserPart(part: Part): boolean {
  if (part.type === "reasoning") return true;
  if (part.type !== "tool") return false;
  const tool = String((part as { tool?: string }).tool ?? "").toLowerCase();
  return READ_ONLY_TOOLS.has(tool);
}
```

Return `null` unless:

- `sessionIdle`, `queueEmpty`, and `composerEmpty` are true
- the target is the latest visible user message
- all following assistant parts pass the allowlist
- the target user message can be reconstructed into a `ComposerDraft`

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/message-editability.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/message-editability.ts packages/app/src/app/components/session/message-editability.test.ts
git commit -m "test: add transcript editability model"
```

## Task 3: Composer Send Intents

**Files:**
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Create or modify test: `packages/app/src/app/components/session/composer-send-intent.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write the failing test**

Use a source-level regression test to require:

- `onSend` receives an options object
- plain Enter uses `sendNow: false`
- Ctrl+Enter uses `sendNow: true`
- streaming UI keeps Stop and exposes a send-now affordance

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("composer distinguishes queued send from send-now steering", () => {
  assert.match(source, /onSend: \(draft: ComposerDraft, options\?: ComposerSendOptions\) => Promise<boolean>;/);
  assert.match(source, /sendDraft\(\{ sendNow: false/);
  assert.match(source, /sendDraft\(\{ sendNow: true/);
  assert.match(source, /event\.ctrlKey/);
  assert.match(source, /session\.send_now_label/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/composer-send-intent.test.ts
```

Expected: FAIL because the send options are not implemented.

**Step 3: Implement send options**

Add a local type:

```ts
export type ComposerSendOptions = {
  sendNow?: boolean;
  source?: "button" | "enter" | "ctrl-enter";
};
```

Update `ComposerProps.onSend`:

```ts
onSend: (draft: ComposerDraft, options?: ComposerSendOptions) => Promise<boolean>;
```

Update `sendDraft` to accept options and pass them through:

```ts
const sendDraft = async (options: ComposerSendOptions = {}) => {
  // existing draft construction
  const sent = await props.onSend(draft, options);
  // existing success/failure cleanup
};
```

Update key handling:

```ts
if (event.key === "Enter") {
  event.preventDefault();
  if (sending() || props.busy) return;
  void sendDraft({
    sendNow: event.ctrlKey || event.metaKey,
    source: event.ctrlKey || event.metaKey ? "ctrl-enter" : "enter",
  });
}
```

Keep Alt+Enter as newline before this branch.

When `props.isStreaming` is true, render Stop plus a small `Zap` button for `sendNow` when there is draft content. Use localized labels:

- `session.send_now_label`: "Send now" / "Poslat hned"
- `session.send_now_title`: "Steer agent now" / "Nasměrovat agenta teď"
- `session.queue_message_label`: "Queue message" / "Zařadit zprávu"

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/composer-send-intent.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/composer.tsx packages/app/src/app/components/session/composer-send-intent.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add composer send intents"
```

## Task 4: Queue UI Component

**Files:**
- Create: `packages/app/src/app/components/session/queued-message-list.tsx`
- Create: `packages/app/src/app/components/session/queued-message-list.test.ts`

**Step 1: Write the failing test**

Require the component to render drag, edit, cancel, and sending affordances.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./queued-message-list.tsx", import.meta.url), "utf8");

test("queued message list exposes edit cancel and drag controls", () => {
  assert.match(source, /GripVertical/);
  assert.match(source, /Pencil/);
  assert.match(source, /X/);
  assert.match(source, /Loader2/);
  assert.match(source, /draggable=\{item\.state !== "sending"\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/queued-message-list.test.ts
```

Expected: FAIL because the component does not exist.

**Step 3: Implement the component**

Props:

```ts
type QueuedMessageListProps = {
  items: QueuedDraft[];
  onEdit: (id: string) => void;
  onCancel: (id: string) => void;
  onMove: (id: string, targetIndex: number) => void;
};
```

Use HTML drag/drop for first version. Do not add a dependency.

**Step 4: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/queued-message-list.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/queued-message-list.tsx packages/app/src/app/components/session/queued-message-list.test.ts
git commit -m "feat: add queued message list"
```

## Task 5: Session Queue Orchestration

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-scroll-behavior.test.ts`
- Create: `packages/app/src/app/pages/session-message-queue.test.ts`

**Step 1: Write failing tests**

Add source-level tests that require:

- `handleSendPrompt` receives send options
- running + Enter queues instead of calling `sendPromptAsync`
- running + Ctrl+Enter sends immediately
- running-to-idle drains one item
- Stop marks queue paused
- paused + Enter appends and starts first queued item
- paused + Ctrl+Enter sends immediate draft and resumes queue after idle

**Step 2: Run tests to verify they fail**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-message-queue.test.ts
node --test --import=tsx/esm src/app/pages/session-scroll-behavior.test.ts
```

Expected: FAIL on the new queue expectations.

**Step 3: Implement session queue state**

In `session.tsx`, add:

```ts
const [queuedDraftsBySessionKey, setQueuedDraftsBySessionKey] = createSignal<Record<string, QueuedDraft[]>>({});
const [queuePausedAfterStopBySessionKey, setQueuePausedAfterStopBySessionKey] = createSignal<Record<string, boolean>>({});
const [editingQueuedDraftId, setEditingQueuedDraftId] = createSignal<string | null>(null);
```

Derive the key from selected session id or pending draft key if that is already available through props. If pending key is not passed, use selected session id for this first slice and keep pending-session queue as a follow-up.

Add helpers:

- `currentQueue()`
- `setCurrentQueue(updater)`
- `isQueuePausedAfterStop()`
- `setCurrentQueuePaused(value)`
- `sendQueuedDraftNow(item)`

**Step 4: Route sends by intent**

Update `handleSendPrompt(draft, options)`:

- If editing a queued item and `options.sendNow` is false, update the queue item and clear composer.
- If editing a queued item and `options.sendNow` is true, remove the item and send immediately.
- If `showRunIndicator()` is true and `options.sendNow` is false, append to queue and clear composer.
- If queue is paused after Stop and `options.sendNow` is false, append the current draft and send the first queued item.
- If `options.sendNow` is true, call the existing immediate send path.

Extract the existing body into:

```ts
const sendPromptImmediate = async (
  draft: ComposerDraft,
  options?: { reason?: "normal" | "queue-drain" | "send-now" | "replacement" },
) => {
  // existing sendPromptAsync call, toast, bottom pin, startRun
};
```

**Step 5: Drain only after idle**

Add an effect that watches previous and current `props.sessionStatus`.

Rules:

- only run when previous status was not idle and current status is idle
- if paused-after-stop is true, do nothing
- if the queue has a first queued item, mark it sending and call `sendPromptImmediate`
- after success, remove it
- after failure, keep it with error state

**Step 6: Wire queue UI**

Render `QueuedMessageList` above the composer when `currentQueue().length > 0`.

Handlers:

- edit: put the queued draft into composer and set `editingQueuedDraftId`
- cancel: remove the item unless it is sending
- move: call `moveQueuedDraft`

**Step 7: Run tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-message-queue.test.ts
node --test --import=tsx/esm src/app/pages/session-scroll-behavior.test.ts
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-message-queue.test.ts packages/app/src/app/pages/session-scroll-behavior.test.ts
git commit -m "feat: queue session messages"
```

## Task 6: Transcript Edit Pencil Wiring

**Files:**
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Create: `packages/app/src/app/components/session/message-list-edit-action.test.ts`

**Step 1: Write the failing test**

Require `MessageList` to accept an editable message id and render a pencil only for that id.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("message list renders edit action only for the editable message id", () => {
  assert.match(source, /editableUserMessageId\?: string \| null/);
  assert.match(source, /onEditUserMessage\?: \(messageId: string\) => void/);
  assert.match(source, /block\.isUser && props\.editableUserMessageId === block\.messageId/);
  assert.match(source, /title=\{tr\("session\.edit_message_label"\)\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/message-list-edit-action.test.ts
```

Expected: FAIL.

**Step 3: Implement message list props**

Add props:

```ts
editableUserMessageId?: string | null;
onEditUserMessage?: (messageId: string) => void;
```

In the action rail, render the pencil only when `block.isUser && props.editableUserMessageId === block.messageId`.

Localize:

- `session.edit_message_label`: "Edit message" / "Upravit zprávu"

**Step 4: Wire SessionView**

Use `getEditableUserMessageDraft` to derive the editable message.

Pass to `MessageList`:

```tsx
editableUserMessageId={editableUserMessage()?.messageId ?? null}
onEditUserMessage={beginTranscriptReplacement}
```

`beginTranscriptReplacement` sets the composer draft to the reconstructed draft and records replacement state.

**Step 5: Run test to verify it passes**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/message-list-edit-action.test.ts
node --test --import=tsx/esm src/app/components/session/message-editability.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/message-list.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/message-list-edit-action.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: show safe message edit action"
```

## Task 7: Transcript Replacement Send Path

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Create: `packages/app/src/app/pages/session-message-replacement.test.ts`

**Step 1: Write failing tests**

Require:

- replacement send revalidates editability
- replacement send calls `undoLastUserMessage` or a new revert callback before `sendPromptAsync`
- replacement state is cleared only after successful accepted send
- replacement state remains when validation or send fails

**Step 2: Run test to verify it fails**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-message-replacement.test.ts
```

Expected: FAIL.

**Step 3: Add a targeted revert callback**

Prefer a dedicated app-level prop over reusing generic undo:

```ts
revertToUserMessage: (messageId: string) => Promise<void>;
```

In `app.tsx`, implement it with:

- current client
- selected session id
- `abortSessionSafe`
- `revertSession(c, sessionID, messageId)`
- `upsertLocalSession(next)`

Do not restore the prompt in this callback; SessionView already owns the replacement draft.

**Step 4: Implement replacement send**

In `handleSendPrompt`, if replacement state is present:

1. Recompute `editableUserMessage()`.
2. Verify the ids still match.
3. Call `props.revertToUserMessage(messageId)`.
4. Call `sendPromptImmediate(draft, { reason: "replacement" })`.
5. Clear replacement state only when accepted.

**Step 5: Run tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/pages/session-message-replacement.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/app.tsx packages/app/src/app/pages/session-message-replacement.test.ts
git commit -m "feat: replace latest user message safely"
```

## Task 8: Durable Docs

**Files:**
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update feature semantics**

Add concise sections covering:

- queued messages during active runs
- Ctrl+Enter send-now steering
- Stop pausing queue drain
- queued item edit/cancel/reorder
- safe latest-message editing restrictions

**Step 2: Update state reference**

Document queued drafts as app/session UI state, not a server queue contract.

**Step 3: Run doc diff check**

Run:

```bash
git diff --check -- docs/features/session-runtime.md docs/dev/state-and-config-reference.md
```

Expected: exit 0.

**Step 4: Commit**

```bash
git add docs/features/session-runtime.md docs/dev/state-and-config-reference.md
git commit -m "docs: document session queue behavior"
```

## Task 9: Full App Verification

**Files:**
- No new files expected unless a test gap requires one.

**Step 1: Run focused app tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/session/session-queue-model.test.ts
node --test --import=tsx/esm src/app/components/session/message-editability.test.ts
node --test --import=tsx/esm src/app/components/session/composer-send-intent.test.ts
node --test --import=tsx/esm src/app/components/session/queued-message-list.test.ts
node --test --import=tsx/esm src/app/components/session/message-list-edit-action.test.ts
node --test --import=tsx/esm src/app/pages/session-message-queue.test.ts
node --test --import=tsx/esm src/app/pages/session-message-replacement.test.ts
```

Expected: PASS.

**Step 2: Run package tests**

Run from repo root:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Run desktop preflight**

Run from repo root before any desktop E2E:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: final `pgrep` prints no relevant processes. If a process looks user-owned, stop and ask before killing it.

**Step 4: Run desktop E2E**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/composer.spec.ts
```

Expected: PASS.

If the implementation adds a new E2E spec, run that exact spec instead of or in addition to `composer.spec.ts`.

**Step 5: Final commit if verification changes files**

If verification required test or doc follow-up edits:

```bash
git add <changed-files>
git commit -m "test: cover session message queue"
```
