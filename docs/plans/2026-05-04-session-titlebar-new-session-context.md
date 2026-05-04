# Session Titlebar New Session Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show `New session` plus the active directory in the centered chat titlebar before the first message exists.

**Architecture:** Keep the behavior in the Solid session page. Extract a small titlebar context model so tests can verify state composition without rendering the full page, then render the model in the existing `TitlebarMenuToggles` center slot.

**Tech Stack:** SolidJS, TypeScript, node:test, existing Veslo app i18n and Tailwind classes.

---

### Task 1: Add A Titlebar Context Model

**Files:**
- Create: `packages/app/src/app/pages/session-titlebar-context.ts`
- Test: `packages/app/src/app/pages/session-titlebar-context.test.ts`

**Step 1: Write the failing test**

Create tests for these cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionTitlebarContext } from "./session-titlebar-context.js";

test("empty local chat shows new-session state and directory", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 0,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/projects/veslo",
    localWorkspaceLabel: "Veslo",
    remoteWorkspaceLabel: "Remote workspace",
  });

  assert.equal(context?.stateLabel, "New session");
  assert.equal(context?.locationLabel, "veslo");
  assert.equal(context?.locationTitle, "/Users/example/projects/veslo");
});

test("existing chat with messages keeps directory-only context", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_123",
    messageCount: 3,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/projects/veslo",
    localWorkspaceLabel: "Veslo",
    remoteWorkspaceLabel: "Remote workspace",
  });

  assert.equal(context?.stateLabel, null);
  assert.equal(context?.locationLabel, "veslo");
});

test("new chat without a known directory still shows the state", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 0,
    workspaceType: "local",
    activeWorkspaceRoot: "",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
  });

  assert.equal(context?.stateLabel, "New session");
  assert.equal(context?.locationLabel, null);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- src/app/pages/session-titlebar-context.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Implement `resolveSessionTitlebarContext(input)` with a plain data return shape:

```ts
type SessionTitlebarContext = {
  stateLabel: string | null;
  locationLabel: string | null;
  locationTitle: string | null;
  locationUsePathStyle: boolean;
};
```

Use existing `resolveComposerWorkspaceLabel` for location label derivation. Compute `stateLabel` as `New session` when there is no selected session id or the message count is zero.

**Step 4: Run test to verify it passes**

Run the same focused test command. Expected: PASS.

### Task 2: Render The Split Titlebar Label

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-titlebar-layout.test.ts`

**Step 1: Write the failing source-level test**

Update `session-titlebar-layout.test.ts` so it expects:

- `resolveSessionTitlebarContext` import/use.
- no `props.messages.length === 0` early return in titlebar context.
- rendering of a `New session` state span plus separator when a location exists.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- src/app/pages/session-titlebar-layout.test.ts
```

Expected: FAIL on the old empty-chat titlebar guard.

**Step 3: Write minimal implementation**

Replace the inline `sessionTitlebarLabel`/`sessionTitlebarContext` logic with the new model. Render:

- state span when `stateLabel` exists,
- dot separator only when both state and location exist,
- location span when `locationLabel` exists,
- full location path in `title`.

Keep the existing `TitlebarMenuToggles centerContent={sessionTitlebarContext()}` wiring.

**Step 4: Run test to verify it passes**

Run the same focused titlebar layout test. Expected: PASS.

### Task 3: Localization And Verification

**Files:**
- Modify only if needed: `packages/app/src/i18n/*` or existing translation source for `session.new_session_label`.
- Read: `docs/dev/testing-playbook.md`

**Step 1: Reuse existing copy if available**

Prefer the existing `session.new_session_label` translation. If the model cannot call `t(...)` cleanly, pass the translated label from `session.tsx` into the model.

**Step 2: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- src/app/pages/session-titlebar-context.test.ts src/app/pages/session-titlebar-layout.test.ts
```

Expected: PASS.

**Step 3: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: both commands exit 0.

**Step 4: Review docs impact**

The durable behavior is user-visible session runtime context. If implementation changes more than titlebar display, update `docs/features/session-runtime.md`; otherwise the design and implementation plan are enough historical context.
