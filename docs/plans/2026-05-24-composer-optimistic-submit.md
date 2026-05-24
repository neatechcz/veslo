# Composer Optimistic Submit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a submitted Composer draft in the session timeline immediately and prevent editing it while the workspace/session/message handoff is still pending.

**Architecture:** Session view owns a temporary optimistic submitted draft because it already composes the message list and run indicator. Composer owns only the local in-flight lock and clears/restores its editor based on the `onSend` result. The real server transcript remains authoritative after `sendPromptAsync` succeeds.

**Tech Stack:** SolidJS, TypeScript, OpenCode SDK message shapes, Node test runner, WebdriverIO desktop E2E where practical.

---

### Task 1: Add Source-Level Contract Tests

**Files:**
- Modify: `packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts`
- Modify: `packages/app/src/app/pages/session-scroll-behavior.test.ts`

**Step 1: Write failing tests**

Add assertions that:

- `Composer` derives a submit lock from `sending()` and uses it for editor `contentEditable`, action buttons, paste/drop/input/key guards, and send button disabled state.
- `SessionView` stores an optimistic submitted draft before awaiting `props.sendPromptAsync(draft)`.
- `SessionView` starts the run indicator before awaiting `props.sendPromptAsync(draft)`.
- `SessionView` appends a synthetic user message to rendered messages while the optimistic draft is present.
- Failure clears the optimistic message and restores the draft; success clears the optimistic message and lets the real transcript own display.

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- composer-screenshot-staging-regression session-scroll-behavior
```

Expected: FAIL because the source does not yet contain the submit lock or optimistic submitted draft flow.

### Task 2: Implement Composer Submit Lock

**Files:**
- Modify: `packages/app/src/app/components/session/composer.tsx`

**Step 1: Implement minimal code**

- Add `submitLocked = createMemo(() => sending())`.
- Guard input, paste, drop, slash/mention selection, attachment addition/removal, folder selection, agent toggle, and Enter submit while locked.
- Set `contentEditable={!submitLocked()}` plus `aria-disabled={submitLocked()}` on the editor.
- Include `submitLocked()` in `sendDisabled`.
- On successful `onSend`, clear draft and attachments.
- On failed `onSend`, unlock without changing the submitted draft.

**Step 2: Run focused tests**

Run the same focused unit command. Expected: composer lock assertions pass; Session view assertions still fail until Task 3.

### Task 3: Implement Session Optimistic Submitted Message

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`

**Step 1: Implement minimal code**

- Add `optimisticSubmittedDraft` signal with id, timestamp, and `ComposerDraft`.
- In `handleSendPrompt`, set the optimistic draft and call `startRun()` before awaiting `props.sendPromptAsync(draft)`.
- Build a synthetic user `MessageWithParts` from the optimistic draft.
- Append it to `effectiveRenderedMessages()` while no real message has replaced it.
- On accepted send, clear the optimistic draft.
- On failed send or caught error, clear the optimistic draft and call `props.setComposerDraft(draft)`.
- Keep later runtime/model failures untouched because those have real server messages.

**Step 2: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- composer-screenshot-staging-regression session-scroll-behavior
```

Expected: PASS.

### Task 4: Update Durable Behavior Docs

**Files:**
- Modify: `docs/features/session-runtime.md`

**Step 1: Document shipped behavior**

Add a short Composer paragraph describing optimistic submit, lock semantics, and the failure boundary between local handoff failure and real message/run failure.

### Task 5: Verify

**Files:**
- No edits unless failures require focused fixes.

**Step 1: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Run desktop E2E if practical**

Follow `docs/dev/testing-playbook.md` preflight before launching the desktop runtime:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
cd ../e2e
pnpm test --spec ./specs/composer.spec.ts
```

Expected: PASS, or report the exact blocker if the desktop E2E run is not practical.
