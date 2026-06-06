# Sidebar Chat Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the collapsed Chats area expose a compact `+ Chat` button that creates and reveals a chat, and make project plus actions look like real buttons.

**Architecture:** Keep this as a local Solid sidebar presentation change. Add a small compact-height helper in the existing sidebar windowing module, then update the existing `WorkspaceSessionList` rendering without changing session creation, workspace activation, or data loading.

**Tech Stack:** SolidJS, Tailwind utility classes, lucide-solid icons, Node test runner with `tsx/esm`, Veslo desktop/Tauri for final runtime verification.

---

Use @test-driven-development for implementation and @verification-before-completion before final completion. The current worktree has unrelated dirty files; stage and commit only the files named in each task.

### Task 1: Compact Chats Expansion Height

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-windowing.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-windowing.test.ts`

**Step 1: Write the failing test**

Update the import list in `workspace-session-list-windowing.test.ts`:

```ts
import {
  CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX,
  CHAT_SIDEBAR_COMPACT_HEIGHT_PX,
  CHAT_SIDEBAR_DEFAULT_HEIGHT_PX,
  CHAT_SIDEBAR_MAX_HEIGHT_PX,
  CHAT_SIDEBAR_MIN_HEIGHT_PX,
  compactChatSidebarHeight,
  // existing imports...
} from "./workspace-session-list-windowing.js";
```

Extend the defaults test:

```ts
assert.equal(CHAT_SIDEBAR_COMPACT_HEIGHT_PX, 120);
```

Add this test near the existing chat sidebar height tests:

```ts
test("compact chat sidebar height shows at most about three rows", () => {
  assert.equal(compactChatSidebarHeight(600), CHAT_SIDEBAR_COMPACT_HEIGHT_PX);
  assert.equal(compactChatSidebarHeight(120), 78);
  assert.equal(compactChatSidebarHeight(40), CHAT_SIDEBAR_MIN_HEIGHT_PX);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: FAIL because `CHAT_SIDEBAR_COMPACT_HEIGHT_PX` and `compactChatSidebarHeight` are not exported.

**Step 3: Write minimal implementation**

In `workspace-session-list-windowing.ts`, add the compact default beside the existing chat constants:

```ts
export const CHAT_SIDEBAR_COMPACT_HEIGHT_PX = RECENT_ESTIMATED_ROW_HEIGHT * 3;
```

Add this helper after `clampChatSidebarHeight`:

```ts
export const compactChatSidebarHeight = (
  containerHeight?: number,
) => clampChatSidebarHeight(CHAT_SIDEBAR_COMPACT_HEIGHT_PX, containerHeight);
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-windowing.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-windowing.ts \
  packages/app/src/app/components/session/workspace-session-list-windowing.test.ts
git commit -m "test(app): cover compact chat sidebar expansion"
```

### Task 2: Sidebar Markup Tests For Collapsed Chats And Project Plus Buttons

**Files:**
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write the failing tests**

In the existing `by-project sidebar renders private chats as a bottom section` test, replace the collapsed Chats expectations with assertions that require separate `+ Chat` and expand controls:

```ts
assert.match(
  source,
  /data-sidebar-chat-collapsed="true"[\s\S]*data-tooltip=\{tr\("sidebar\.new_chat"\)\}[\s\S]*onClick=\{startQuickChatFromCollapsed\}[\s\S]*<Plus size=\{12\} \/>[\s\S]*<span>\{tr\("sidebar\.chat"\)\}<\/span>/,
  "collapsed Chats should expose a compact + Chat button",
);
assert.match(
  source,
  /data-sidebar-chat-expand-button="true"[\s\S]*data-sidebar-chat-collapsed-resize-handle="true"[\s\S]*onPointerDown=\{handleChatSidebarResizeStart\}[\s\S]*onClick=\{expandChatSidebar\}[\s\S]*<ChevronUp size=\{11\} \/>/,
  "collapsed Chats should keep a separate expand button on the right",
);
assert.doesNotMatch(
  source,
  /data-sidebar-chat-collapsed="true"[\s\S]*<span class="truncate">\{tr\("sidebar\.chats"\)\}<\/span>/,
  "collapsed Chats should not show the old Chats label in place of + Chat",
);
assert.match(source, /compactChatSidebarHeight\(chatSidebarAvailableHeight\(\)\)/);
```

Add a separate test below it for project plus button chrome:

```ts
test("project create-session actions use visible button chrome", () => {
  assert.match(
    source,
    /const projectCreateSessionButtonClass =[\s\S]*h-7 w-7[\s\S]*rounded-full[\s\S]*border border-gray-6[\s\S]*bg-gray-1[\s\S]*shadow-sm/,
    "project plus actions should use a shared button-like class",
  );
  assert.match(
    source,
    /class=\{projectCreateSessionButtonClass\}[\s\S]*aria-label=\{tr\("sidebar\.create_session_in_project"\)\}[\s\S]*<Plus size=\{14\} \/>/,
    "project plus actions should render as the shared button",
  );
  assert.doesNotMatch(
    source,
    /class="p-1 rounded-md text-gray-8 hover:text-gray-11 hover:bg-gray-3"[\s\S]*<Plus size=\{14\} \/>/,
    "project plus actions should not remain bare p-1 icon buttons",
  );
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because the collapsed markup and shared project plus class do not exist yet.

**Step 3: Do not commit yet**

Leave these failing tests uncommitted until Task 3 implements the behavior.

### Task 3: Implement Sidebar Controls

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Import the compact height helper**

In `workspace-session-list.tsx`, extend the existing import from `workspace-session-list-windowing`:

```ts
import {
  // existing imports...
  CHAT_SIDEBAR_COLLAPSE_THRESHOLD_PX,
  compactChatSidebarHeight,
  computeInitialRecentVisibleCount,
  // existing imports...
} from "./workspace-session-list-windowing";
```

**Step 2: Add shared project button chrome**

Near `topRailButtonClass` and `compactTopRailButtonClass`, add:

```ts
const projectCreateSessionButtonClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:border-gray-7 hover:bg-gray-2 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]";
```

Replace both existing project plus button classes:

```tsx
class="p-1 rounded-md text-gray-8 hover:text-gray-11 hover:bg-gray-3"
```

with:

```tsx
class={projectCreateSessionButtonClass}
```

Do this in both places in `workspace-session-list.tsx`:

- the recent empty-project fallback plus action
- the normal by-project header plus action

**Step 3: Add the collapsed quick-chat handler**

Keep the expanded-state `startQuickChat` unchanged:

```ts
const startQuickChat = () => {
  props.onQuickNewSession?.();
};
```

Add this helper immediately after it:

```ts
const startQuickChatFromCollapsed = () => {
  applyResolvedChatSidebarResize(compactChatSidebarHeight(chatSidebarAvailableHeight()), false, true);
  startQuickChat();
};
```

This limits the automatic expansion to about three rows and persists that compact height only when the user triggers `+ Chat` from the collapsed state.

**Step 4: Replace the collapsed Chats fallback markup**

Replace the current single collapsed button fallback:

```tsx
<button
  type="button"
  data-sidebar-chat-collapsed="true"
  data-sidebar-chat-collapsed-resize-handle="true"
  class="mt-2 flex h-9 w-full shrink-0 cursor-ns-resize items-center justify-between border-t border-gray-6/70 px-1.5 pt-2 text-[12px] font-semibold text-gray-10 transition-colors hover:text-gray-12"
  style={{ cursor: "ns-resize" }}
  onPointerDown={handleChatSidebarResizeStart}
  onClick={expandChatSidebar}
  aria-label={tr("sidebar.chats")}
  title={tr("sidebar.chats")}
>
  <span class="truncate">{tr("sidebar.chats")}</span>
  <ChevronUp size={11} />
</button>
```

with:

```tsx
<div
  data-sidebar-chat-collapsed="true"
  class="mt-2 flex h-9 w-full shrink-0 items-center justify-between gap-2 border-t border-gray-6/70 px-1.5 pt-2"
>
  <button
    type="button"
    class={`inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full border border-gray-6 bg-gray-1 px-2 text-[11px] font-medium text-gray-11 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-60 ${sidebarControlTooltipClass}`}
    data-tooltip={tr("sidebar.new_chat")}
    onClick={startQuickChatFromCollapsed}
    disabled={!props.onQuickNewSession}
    aria-label={tr("sidebar.new_chat")}
    title={tr("sidebar.new_chat")}
  >
    <Plus size={12} />
    <span>{tr("sidebar.chat")}</span>
  </button>
  <button
    type="button"
    data-sidebar-chat-expand-button="true"
    data-sidebar-chat-collapsed-resize-handle="true"
    class="inline-flex h-8 w-8 shrink-0 cursor-ns-resize items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]"
    style={{ cursor: "ns-resize" }}
    onPointerDown={handleChatSidebarResizeStart}
    onClick={expandChatSidebar}
    aria-label={tr("sidebar.chats")}
    title={tr("sidebar.chats")}
  >
    <ChevronUp size={11} />
  </button>
</div>
```

**Step 5: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-windowing.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "fix(app): surface collapsed chat action"
```

### Task 4: Broader Verification

**Files:**
- No expected file changes.

**Step 1: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS. If unrelated dirty files cause failures, isolate whether the failure touches the sidebar files before changing anything.

**Step 2: Verify in the desktop runtime**

Follow the repository preflight before launching desktop runtime:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the matches are internally started dev/test runtime processes from this repo, stop them and verify no relevant process remains:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Then launch through the desktop runtime, not raw Vite:

```bash
pnpm dev
```

Expected visual checks:

- collapsed Chats shows `+ Chat` in a visible button
- the right-side expand button is still present
- clicking `+ Chat` creates a chat and expands the Chats area
- the expanded Chats area opens to about three rows, not half the sidebar
- project/workspace plus controls look like small real buttons

**Step 3: Final status**

If verification passes and no additional changes are needed, report the commands run and their results. Do not stage unrelated dirty files.
