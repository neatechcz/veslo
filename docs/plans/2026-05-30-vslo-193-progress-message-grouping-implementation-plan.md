# VSLO-193 Progress Message Grouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render one expandable progress group between a user message and the final agent answer, while preserving intermediate agent comments and limiting `showThinking` to model reasoning.

**Architecture:** Add a testable transcript-level grouping model for the session message list. The model derives render blocks from ordered `MessageWithParts` records and session streaming state, then `MessageList` renders those blocks through the existing text renderer and timeline container. Existing OpenCode session data stays unchanged.

**Tech Stack:** SolidJS, TypeScript, OpenCode SDK `Part` types, node:test unit tests, WebdriverIO desktop E2E.

---

### Task 1: Add A Testable Progress Grouping Model

**Files:**
- Create: `packages/app/src/app/components/session/progress-grouping-model.ts`
- Create: `packages/app/src/app/components/session/progress-grouping-model.test.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing tests**

Create `progress-grouping-model.test.ts` with fixtures that build `MessageWithParts` objects:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { buildProgressRenderBlocks } from "./progress-grouping-model.js";
import type { MessageWithParts } from "../../types";

function message(id: string, role: "user" | "assistant", parts: Part[]): MessageWithParts {
  return {
    info: {
      id,
      role,
      sessionID: "session-1",
      time: { created: Date.now() },
    } as any,
    parts: parts.map((part, index) => ({
      id: `${id}-part-${index}`,
      sessionID: "session-1",
      messageID: id,
      ...part,
    }) as Part),
  };
}

test("collapses completed intermediate assistant activity between user and final answer", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "I found the issue." } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "edit", state: { input: { filePath: "README.md" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "Done." } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), ["message", "progress-group", "message"]);
  const group = blocks[1];
  assert.equal(group.kind, "progress-group");
  assert.deepEqual(group.messageIds, ["a1", "a2", "a3"]);
  assert.equal(group.items.length, 3);
  assert.equal(group.items[1]?.kind, "comment");
});

test("keeps the latest assistant text live while streaming", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "I am still checking." } as any]),
    ],
    isStreaming: true,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), ["message", "progress-group", "message"]);
  assert.equal(blocks[2].kind, "message");
});

test("showThinking hides reasoning but keeps comments and action details", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "reasoning", text: "Need inspect files" } as any]),
      message("a2", "assistant", [{ type: "text", text: "I will inspect files." } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "Done." } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  const group = blocks[1];
  assert.equal(group.kind, "progress-group");
  assert.deepEqual(group.items.map((item) => item.kind), ["comment", "steps"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/components/session/progress-grouping-model.test.ts
```

Expected: FAIL because `progress-grouping-model.ts` does not exist.

**Step 3: Add the model types**

In `packages/app/src/app/types.ts`, extend the render-level types without changing stored session types:

```ts
export type ProgressGroupItem =
  | { kind: "steps"; id: string; parts: Part[]; mode: StepGroupMode; messageId: string }
  | { kind: "comment"; id: string; part: Part; messageId: string };
```

**Step 4: Implement minimal grouping**

In `progress-grouping-model.ts`, export:

```ts
export type ProgressRenderBlock =
  | { kind: "message"; message: MessageWithParts; renderableParts: Part[]; groups: MessageGroup[]; isUser: boolean; messageId: string }
  | { kind: "progress-group"; id: string; items: ProgressGroupItem[]; messageIds: string[]; isUser: false };

export function buildProgressRenderBlocks(input: {
  messages: MessageWithParts[];
  isStreaming: boolean;
  developerMode: boolean;
  showThinking: boolean;
}): ProgressRenderBlock[] {
  // Walk messages in order.
  // A user message flushes any open turn and renders normally.
  // For each assistant turn, keep the final assistant text message as the final answer.
  // Everything before that final answer becomes one progress-group.
  // If isStreaming is true, treat the latest assistant text as live and render it normally.
  // Use existing groupMessageParts for tool/reasoning grouping.
}
```

Use the existing `isUserVisiblePart` and `groupMessageParts` helpers so current synthetic/ignored/handoff filtering stays intact.

**Step 5: Run model tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/components/session/progress-grouping-model.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/progress-grouping-model.ts packages/app/src/app/components/session/progress-grouping-model.test.ts packages/app/src/app/types.ts
git commit -m "test: model VSLO-193 progress grouping"
```

### Task 2: Render Progress Groups In MessageList

**Files:**
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts`

**Step 1: Write failing source/behavior assertions**

Update `message-list-hybrid-timeline.test.ts` so it asserts `MessageList` imports and uses `buildProgressRenderBlocks`, and no longer owns the old step-only-only clustering as the primary grouping path.

Add assertions for:

```ts
assert.match(source, /buildProgressRenderBlocks/);
assert.match(source, /block\.kind === "progress-group"/);
assert.match(source, /ProgressComment/);
```

Expected: FAIL before wiring.

**Step 2: Replace local `messageBlocks` derivation**

In `message-list.tsx`:

- import `buildProgressRenderBlocks`;
- remove or narrow the local `StepClusterBlock` construction from `messageBlocks`;
- derive blocks by calling:

```ts
buildProgressRenderBlocks({
  messages: props.messages,
  isStreaming: Boolean(props.isStreaming),
  developerMode: props.developerMode,
  showThinking: props.showThinking,
})
```

Keep the existing performance logging if useful, but count render blocks from the new model.

**Step 3: Add comment rendering inside expanded progress detail**

Inside `StepsContainer`, accept mixed `ProgressGroupItem[]` or add a sibling `ProgressGroupContainer` that:

- builds timeline sections from all `steps` items;
- renders `comment` items in original order;
- uses `PartView` for comment text with `renderMarkdown={true}`;
- keeps comments inside the expanded detail, not the collapsed main transcript.

Prefer a new `ProgressGroupContainer` if that keeps the existing `StepsContainer` behavior smaller.

**Step 4: Fix technical detail gating**

Replace:

```tsx
<Show when={props.showThinking && row.technicalDetail}>
```

with a predicate that hides technical detail only for reasoning rows when `showThinking=false`:

```ts
const canShowTimelineTechnicalDetail = (entry: TimelineRowView) =>
  Boolean(entry.row.technicalDetail) && (entry.part?.type !== "reasoning" || props.showThinking);
```

Then render:

```tsx
<Show when={canShowTimelineTechnicalDetail(entry)}>
```

**Step 5: Run UI unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts packages/app/src/app/components/session/progress-grouping-model.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/message-list.tsx packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts
git commit -m "feat: render turn-scoped progress groups"
```

### Task 3: Update Durable Session Runtime Documentation

**Files:**
- Modify: `docs/features/session-runtime.md`

**Step 1: Add session transcript behavior**

In the "Main Session Surface" or a new "Progress Grouping" subsection, document:

- grouping is per user-to-final-agent turn;
- intermediate assistant comments are ordinary agent text in the expanded group;
- `showThinking` hides model reasoning only;
- after completion, intermediate work collapses behind one progress group.

**Step 2: Commit**

```bash
git add docs/features/session-runtime.md
git commit -m "docs: describe session progress grouping"
```

### Task 4: Add Desktop E2E Coverage

**Files:**
- Create: `packages/e2e/specs/session-progress-grouping.spec.ts`
- Modify if needed: `packages/e2e/package.json`

**Step 1: Write failing E2E spec**

Use the desktop runtime and seed a session through the active OpenCode client or local fixture path. The spec should:

1. create/open a session with one user prompt;
2. ensure the rendered transcript has one user message, one collapsed progress group, and one final assistant message;
3. expand the progress group;
4. assert an intermediate comment and at least one action row are visible in order.

Add stable selectors in `message-list.tsx` if the spec needs them:

```tsx
data-testid="session-progress-group"
data-testid="session-progress-comment"
data-testid="session-progress-row"
```

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If these are internally started Veslo dev/test processes from this repo, stop them, then verify the check is empty.

**Step 3: Build E2E desktop binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: PASS.

**Step 4: Run focused E2E**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/session-progress-grouping.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/session-progress-grouping.spec.ts packages/app/src/app/components/session/message-list.tsx packages/e2e/package.json
git commit -m "test: cover progress grouping in desktop runtime"
```

### Task 5: Final Verification

**Files:**
- No planned source edits.

**Step 1: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Run focused desktop E2E again**

Run the desktop preflight, then:

```bash
cd packages/e2e
pnpm test --spec ./specs/session-progress-grouping.spec.ts
```

Expected: PASS.

**Step 3: Report verification**

Final response must include exact commands run, pass/fail status, and any gaps.
