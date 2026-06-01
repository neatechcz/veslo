# VSLO-195 Pending Session Submit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make first-message Composer submit into a pending session behave like a committed timeline message while session materialization continues in the background.

**Architecture:** `SessionView` owns pending submitted-message state and queue remapping because it already owns rendered messages, run UI, and queue state. `Composer` only snapshots and clears a submitted draft; it must not lock the editor for the whole async handoff or restore failed sends automatically. A small pending-submit model keeps message conversion and edit-state rules testable outside the component.

**Tech Stack:** SolidJS, TypeScript, OpenCode SDK message/part shapes, Node test runner with `tsx/esm`, WebdriverIO desktop E2E for final runtime verification.

---

### Task 1: Add Pending Submit Model Tests

**Files:**
- Create: `packages/app/src/app/components/session/pending-submit-model.ts`
- Create: `packages/app/src/app/components/session/pending-submit-model.test.ts`

**Step 1: Write the failing tests**

Create tests for a pending submitted draft model:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingSubmittedDraft,
  markPendingSubmittedFailed,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
  remapPendingSubmittedSession,
} from "./pending-submit-model.js";
import type { ComposerDraft } from "../../types";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("pending submit creates a user message before a real session id exists", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });

  const message = pendingSubmittedDraftToMessage(pending, "/tmp/workspace");

  assert.equal(message.info.id, "pending-submit-1");
  assert.equal(message.info.role, "user");
  assert.equal(message.info.sessionID, "");
  assert.equal(message.parts[0]?.type, "text");
});

test("pending submit failure preserves the message as editable state", () => {
  const pending = markPendingSubmittedFailed(
    createPendingSubmittedDraft({
      id: "pending-submit-1",
      sessionKey: "pending-draft:abc",
      sessionId: null,
      createdAt: 10,
      draft: draft("hello"),
    }),
    "Session failed",
  );

  assert.equal(pending.state, "error");
  assert.equal(pending.error, "Session failed");
  assert.deepEqual(pendingSubmittedDraftToEditable(pending), {
    messageId: "pending-submit-1",
    draft: draft("hello"),
  });
});

test("pending submit can be remapped to the real session id", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });

  const remapped = remapPendingSubmittedSession(pending, "session-123");

  assert.equal(remapped.sessionId, "session-123");
  assert.equal(pendingSubmittedDraftToMessage(remapped, "/tmp/workspace").info.sessionID, "session-123");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/pending-submit-model.test.ts
```

Expected: FAIL because `pending-submit-model.ts` does not exist.

**Step 3: Implement the model**

Add the model with these exported shapes and helpers:

```ts
import type { Part } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, MessageWithParts } from "../../types";
import type { EditableUserMessageDraft } from "./message-editability";

export type PendingSubmittedDraftState = "sending" | "error";

export type PendingSubmittedDraft = {
  id: string;
  sessionKey: string;
  sessionId: string | null;
  createdAt: number;
  draft: ComposerDraft;
  state: PendingSubmittedDraftState;
  error?: string;
};

export function createPendingSubmittedDraft(input: {
  id: string;
  sessionKey: string;
  sessionId: string | null;
  createdAt: number;
  draft: ComposerDraft;
}): PendingSubmittedDraft {
  return { ...input, state: "sending" };
}

export function markPendingSubmittedFailed(
  pending: PendingSubmittedDraft,
  error: string,
): PendingSubmittedDraft {
  return { ...pending, state: "error", error };
}

export function remapPendingSubmittedSession(
  pending: PendingSubmittedDraft,
  sessionId: string,
): PendingSubmittedDraft {
  return { ...pending, sessionId };
}

export function pendingSubmittedDraftToEditable(
  pending: PendingSubmittedDraft,
): EditableUserMessageDraft | null {
  if (pending.state !== "error") return null;
  return { messageId: pending.id, draft: pending.draft };
}

export function pendingSubmittedDraftToMessage(
  pending: PendingSubmittedDraft,
  workspaceRoot: string,
): MessageWithParts {
  const sessionID = pending.sessionId ?? "";
  const text = (pending.draft.resolvedText ?? pending.draft.text).trim();
  const parts: Part[] = [];
  if (text) {
    parts.push({
      id: `${pending.id}:text`,
      sessionID,
      messageID: pending.id,
      type: "text",
      text,
    } as Part);
  }
  pending.draft.attachments.forEach((attachment, index) => {
    parts.push({
      id: `${pending.id}:attachment:${index}`,
      sessionID,
      messageID: pending.id,
      type: "file",
      url: attachment.dataUrl,
      filename: attachment.name,
      mime: attachment.mimeType,
    } as Part);
  });

  return {
    info: {
      id: pending.id,
      sessionID,
      role: "user",
      time: { created: pending.createdAt },
      parentID: "",
      model: "",
      modelID: "",
      providerID: "",
      mode: pending.draft.mode,
      agent: "",
      path: { cwd: workspaceRoot, root: workspaceRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as MessageWithParts["info"],
    parts,
  };
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/pending-submit-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/pending-submit-model.ts packages/app/src/app/components/session/pending-submit-model.test.ts
git commit -m "test: model pending submitted messages"
```

### Task 2: Update Composer Submit Semantics

**Files:**
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Modify: `packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts`
- Modify: `packages/app/src/app/components/session/composer-busy-send-disabled.test.ts`

**Step 1: Write failing tests**

Change the existing Composer source tests so they assert the new contract:

- `sendDisabled` blocks global busy only when the parent is not in streaming/run-indicator mode.
- `contentEditable` is no longer tied to the async `sending()` state.
- failed `onSend` does not call `restoreSubmittedDraft`.
- `sendDraft` clears the editor, emits draft change, starts `onSend`, then releases the local sending flag before awaiting the handoff.

Use source assertions like:

```ts
assert.match(
  composerSource,
  /const sendDisabled = createMemo\(\(\) => !hasDraftContent\(\) \|\| \(props\.busy && !props\.isStreaming\)\);/,
);

assert.doesNotMatch(
  composerSource,
  /restoreSubmittedDraft\(submittedDraft\)/,
);

assert.match(
  composerSource,
  /const sendPromise = props\.onSend\(submittedDraft, options\);[\s\S]*setSending\(false\);[\s\S]*sent = await sendPromise;/,
);
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/composer-screenshot-staging-regression.test.ts src/app/components/session/composer-busy-send-disabled.test.ts
```

Expected: FAIL because current Composer still locks/restores the submitted draft.

**Step 3: Implement minimal Composer changes**

In `composer.tsx`:

- remove `submitLocked`
- change `sendDisabled`
- keep a short `sending` guard only to prevent same-tick duplicate submit
- clear editor and attachments immediately
- emit the empty draft immediately
- do not restore on `sent === false`

The core `sendDraft` shape should be:

```ts
const sendDisabled = createMemo(() => !hasDraftContent() || (props.busy && !props.isStreaming));

const sendDraft = async (options: ComposerSendOptions = {}) => {
  if (sending()) return;
  if (options.sendNow && sendNowPending()) return;

  flushDraftChange();
  if (!editorRef) return;

  const parts = buildPartsFromEditor(editorRef, pasteTextById);
  const text = normalizeText(partsToText(parts));
  const resolvedText = normalizeText(partsToResolvedText(parts));
  const submittedDraft: ComposerDraft = { mode: mode(), parts, attachments: attachments(), text, resolvedText };

  // Preserve existing slash command detection here.

  recordHistory(submittedDraft);
  setSending(true);
  if (options.sendNow) setSendNowPending(true);
  setSlashOpen(false);
  setSlashQuery("");
  setMentionOpen(false);
  setMentionQuery("");
  setAttachments([]);
  setEditorText("");
  props.onDraftChange(emptyDraftForMode(submittedDraft.mode));

  const sendPromise = props.onSend(submittedDraft, options);
  setSending(false);
  queueMicrotask(() => focusEditorEnd());

  let sent = false;
  try {
    sent = await sendPromise;
  } catch (error) {
    recordSendTrace("sendDraft:onSend:error", {
      message: error instanceof Error ? error.message : String(error),
      sendNow: options.sendNow,
      source: options.source,
    });
  } finally {
    if (options.sendNow) setSendNowPending(false);
  }

  recordSendTrace("sendDraft:onSend:result", {
    sent,
    busy: props.busy,
    streaming: props.isStreaming,
    sendNow: options.sendNow,
    source: options.source,
  });
};
```

Add a local helper if needed:

```ts
const emptyDraftForMode = (draftMode: ComposerDraft["mode"]): ComposerDraft => ({
  mode: draftMode,
  parts: [],
  attachments: [],
  text: "",
  resolvedText: "",
});
```

Update JSX guards:

- `contentEditable={true}` or remove the prop binding entirely.
- attachment remove/add guards should no longer reference `submitLocked`.
- readonly toggle should use `disabled={props.busy && !props.isStreaming}` if it must remain guarded.
- send button click should block only `sending()` and `props.busy && !props.isStreaming`.

**Step 4: Run tests to verify pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/composer-screenshot-staging-regression.test.ts src/app/components/session/composer-busy-send-disabled.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/composer.tsx packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts packages/app/src/app/components/session/composer-busy-send-disabled.test.ts
git commit -m "fix: release composer after pending submit"
```

### Task 3: Wire Pending Submitted Messages Into SessionView

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-scroll-behavior.test.ts`

**Step 1: Write failing tests**

Update `session-scroll-behavior.test.ts` to assert:

- optimistic submit uses `createPendingSubmittedDraft`.
- failure marks pending submitted message failed instead of clearing it.
- failure does not call `props.setComposerDraft(draft)`.
- `renderedMessages` appends `pendingSubmittedDraftToMessage(...)`.
- failed pending submitted message contributes an editable pencil draft.

Use source assertions like:

```ts
assert.match(source, /createPendingSubmittedDraft\(\{/);
assert.match(source, /markPendingSubmittedFailed\(/);
assert.doesNotMatch(source, /if \(!accepted\) \{[\s\S]*props\.setComposerDraft\(draft\);/);
assert.match(source, /pendingSubmittedDraftToMessage\(submitted, props\.activeWorkspaceRoot\)/);
assert.match(source, /pendingSubmittedDraftToEditable\(submitted\)/);
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-scroll-behavior.test.ts
```

Expected: FAIL because current failure path clears the optimistic message and restores Composer.

**Step 3: Implement SessionView changes**

In `session.tsx`:

- import pending-submit helpers
- replace local `OptimisticSubmittedDraft` type with `PendingSubmittedDraft`
- store pending submitted draft with a `sessionKey`
- convert it to a message through `pendingSubmittedDraftToMessage`
- on failed handoff, call `markPendingSubmittedFailed`
- reset the run state after pre-commit failure so the pencil can be used
- do not call `props.setComposerDraft(draft)` automatically

Add a helper near run state:

```ts
const resetRunState = () => {
  setRunStartedAt(null);
  setRunHasBegun(false);
  setRunLastProgressAt(null);
  setRunBaseline({ assistantId: null, partCount: 0 });
};
```

Use it from existing reset sites and from the failed pre-commit branch.

The failure branch inside `sendPromptImmediate` should look like:

```ts
if (!accepted) {
  if (showOptimisticSubmit) {
    const message = props.error ?? tr("session.connect_server_to_attach");
    setOptimisticSubmittedDraft((current) =>
      current?.id === pendingSubmitId ? markPendingSubmittedFailed(current, message) : current,
    );
    resetRunState();
  }
  setToastMessage(props.error ?? tr("session.connect_server_to_attach"));
  return false;
}
```

The accepted branch should still clear the pending submitted message when the real transcript owns the display:

```ts
if (accepted) {
  setOptimisticSubmittedDraft(null);
}
```

Update editable selection:

```ts
const pendingEditableUserMessage = createMemo(() => {
  const submitted = optimisticSubmittedDraft();
  if (!submitted) return null;
  if (!isComposerDraftEmpty(props.composerDraft)) return null;
  if (queuedDrafts().length > 0) return null;
  return pendingSubmittedDraftToEditable(submitted);
});

const editableUserMessage = createMemo(() =>
  pendingEditableUserMessage() ??
  getEditableUserMessageDraft({
    messages: props.messages,
    sessionIdle: !showRunIndicator(),
    queueEmpty: queuedDrafts().length === 0,
    composerEmpty: isComposerDraftEmpty(props.composerDraft),
  }),
);
```

Update `handleEditUserMessage` so a failed pending message is edited by explicit user action:

```ts
const handleEditUserMessage = (editable: EditableUserMessageDraft) => {
  const submitted = optimisticSubmittedDraft();
  if (submitted?.id === editable.messageId && submitted.state === "error") {
    setOptimisticSubmittedDraft(null);
    props.setComposerDraft(editable.draft);
    return;
  }

  if (editableUserMessage()?.messageId !== editable.messageId) return;
  setEditingTranscriptMessageId(editable.messageId);
  props.setComposerDraft(editable.draft);
};
```

**Step 4: Run test to verify pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-scroll-behavior.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-scroll-behavior.test.ts
git commit -m "fix: keep failed pending submit in timeline"
```

### Task 4: Use Durable Pending Session Queue Keys

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Modify: `packages/app/src/app/pages/session-scroll-behavior.test.ts`

**Step 1: Write failing tests**

Add source tests proving:

- `App` passes `activePendingDraftKey()` into `SessionView`.
- `SessionView` keys a no-session queue by the active pending draft key, not only workspace id.
- when a real `selectedSessionId` appears, pending queue state can move from the pending key to the real session key.

Assertions:

```ts
assert.match(appSource, /activePendingDraftKey: activePendingDraftKey\(\),/);
assert.match(sessionSource, /activePendingDraftKey: string \| null;/);
assert.match(sessionSource, /`pending-draft:\$\{props\.activePendingDraftKey\}`/);
assert.match(sessionSource, /remapPendingQueueToSession/);
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts src/app/pages/session-scroll-behavior.test.ts
```

Expected: FAIL because queue keys currently fall back to `pending:${activeWorkspaceId}`.

**Step 3: Implement queue key remapping**

In `SessionProps`, add:

```ts
activePendingDraftKey: string | null;
```

In `app.tsx` session props, pass:

```ts
activePendingDraftKey: activePendingDraftKey(),
```

Replace queue key logic:

```ts
const pendingSessionQueueKey = () => {
  const pendingDraftKey = props.activePendingDraftKey?.trim();
  if (pendingDraftKey) return `pending-draft:${pendingDraftKey}`;
  return `pending-workspace:${props.activeWorkspaceId || "default"}`;
};

const sessionQueueKeyForSessionId = (sessionId: string | null | undefined) =>
  sessionId?.trim() || pendingSessionQueueKey();
```

Add a remap helper:

```ts
const remapPendingQueueToSession = (pendingKey: string, sessionId: string) => {
  if (!pendingKey.startsWith("pending-")) return;
  const realKey = sessionQueueKeyForSessionId(sessionId);
  setQueuedDraftsBySessionKey((current) => {
    const pendingQueue = current[pendingKey] ?? [];
    if (!pendingQueue.length) return current;
    const realQueue = current[realKey] ?? [];
    const next = { ...current, [realKey]: [...realQueue, ...pendingQueue] };
    delete next[pendingKey];
    return next;
  });
  setQueuePausedAfterStopBySessionKey((current) => {
    if (!(pendingKey in current)) return current;
    const next = { ...current };
    next[realKey] = Boolean(next[realKey]) || Boolean(next[pendingKey]);
    delete next[pendingKey];
    return next;
  });
  setOptimisticSubmittedDraft((current) =>
    current?.sessionKey === pendingKey ? remapPendingSubmittedSession(current, sessionId) : current,
  );
};
```

Track the pending key captured at submit:

```ts
const pendingKey = currentSessionQueueKey();
const pendingSubmitId = `optimistic-submit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
```

After accepted first submit, if `pendingKey` is pending and `props.selectedSessionId` is now real, remap:

```ts
const materializedSessionId = props.selectedSessionId?.trim();
if (materializedSessionId) {
  remapPendingQueueToSession(pendingKey, materializedSessionId);
}
```

If selection updates after the promise resolves, add a guarded `createEffect` that remaps when `optimisticSubmittedDraft()?.sessionKey` is pending and `props.selectedSessionId` becomes non-empty.

**Step 4: Run tests to verify pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts src/app/pages/session-scroll-behavior.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-navigation.test.ts packages/app/src/app/pages/session-scroll-behavior.test.ts
git commit -m "fix: key pending queues by draft identity"
```

### Task 5: Show Pending Failure State In The Message List

**Files:**
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/components/session/message-list-edit-user-message.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write failing tests**

Extend `message-list-edit-user-message.test.ts` to assert:

- `MessageListProps` accepts `pendingMessageStateById?: Record<string, { state: "sending" | "error"; error?: string }>`
- user messages with pending state render a small status line/chip
- failed pending messages still show the pencil when `editableUserMessage` matches
- i18n includes labels for sending and failed pending messages

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-edit-user-message.test.ts
```

Expected: FAIL because no pending status prop exists.

**Step 3: Implement status rendering**

Add prop:

```ts
pendingMessageStateById?: Record<string, { state: "sending" | "error"; error?: string }>;
```

Inside message block rendering:

```ts
const pendingState = () => props.pendingMessageStateById?.[block.messageId] ?? null;
```

Render under user text:

```tsx
<Show when={block.isUser && pendingState()}>
  {(state) => (
    <div class={`mt-2 text-[11px] ${state().state === "error" ? "text-red-11" : "text-gray-10"}`}>
      {state().state === "error"
        ? state().error || tr("session.pending_submit_failed")
        : tr("session.pending_submit_sending")}
    </div>
  )}
</Show>
```

Add locale keys:

```ts
"session.pending_submit_sending": "Sending...",
"session.pending_submit_failed": "Could not send. Edit the message and try again.",
```

Use natural equivalents in Czech and Chinese.

Pass the prop from `SessionView`:

```tsx
pendingMessageStateById={pendingMessageStateById()}
```

where:

```ts
const pendingMessageStateById = createMemo(() => {
  const submitted = optimisticSubmittedDraft();
  if (!submitted) return {};
  return { [submitted.id]: { state: submitted.state, error: submitted.error } };
});
```

**Step 4: Run test to verify pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-edit-user-message.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/message-list.tsx packages/app/src/app/components/session/message-list-edit-user-message.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: show pending submit status"
```

### Task 6: Update Durable Docs

**Files:**
- Modify: `docs/features/session-runtime.md`

**Step 1: Update docs**

Replace the old Composer submit bullets that say failed handoff restores the original draft with the new committed pending-message behavior:

```md
- a submitted draft is rendered immediately as a pending user message while workspace/session/message handoff is pending
- Composer clears immediately and remains available for a separate next draft
- if handoff fails before a real message exists, the pending message stays in the timeline with a failed state and can be explicitly edited from that message
- Composer is never used as an automatic rollback buffer after submit
- once a real message exists, later model or run failures stay in the transcript and use the normal message editing, retry, and resend flows
```

**Step 2: Commit**

```bash
git add docs/features/session-runtime.md
git commit -m "docs: update pending submit behavior"
```

### Task 7: Verify App Checks

**Files:**
- No edits unless verification finds a real issue.

**Step 1: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/pending-submit-model.test.ts \
  src/app/components/session/composer-screenshot-staging-regression.test.ts \
  src/app/components/session/composer-busy-send-disabled.test.ts \
  src/app/components/session/message-list-edit-user-message.test.ts \
  src/app/pages/session-scroll-behavior.test.ts \
  src/app/pages/session-navigation.test.ts
```

Expected: PASS.

**Step 2: Run package checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm typecheck
```

Expected: PASS.

**Step 3: Commit any verification fixes**

If verification required code/test changes:

```bash
git add <changed-files>
git commit -m "fix: stabilize pending submit flow"
```

### Task 8: Verify Real Desktop Runtime

**Files:**
- Prefer modifying or adding to `packages/e2e/specs/composer.spec.ts` if an automated E2E assertion is practical.

**Step 1: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: final `pgrep` has no internally started Veslo dev/test process.

**Step 2: Build the desktop E2E binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: PASS.

**Step 3: Run Composer E2E**

Run:

```bash
cd ../e2e
pnpm test --spec ./specs/composer.spec.ts
```

Expected: PASS.

If no existing E2E path covers pending session creation, add the smallest practical Composer spec that sends a first message into a new pending draft and asserts the Composer textbox is editable again before the first handoff completes.
