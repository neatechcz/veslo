# Sidebar Collapse Animation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add smooth left-sidebar expand/collapse animation for project sections and session/subagent branches without changing sidebar navigation or persisted state.

**Architecture:** Keep the existing sidebar state model as the source of truth. Add small pure row-grouping helpers for animated branch rendering, then add a local SolidJS collapse wrapper that measures content height and keeps the last rendered branch mounted until exit completes. Wire that wrapper into by-project project content, by-project session branches, recent session branches, and the Chaty session list.

**Tech Stack:** SolidJS, TypeScript, Tailwind CSS classes, `node:test`, Tauri desktop runtime, WebdriverIO for real-runtime smoke when needed.

---

### Task 1: Add Session Branch Grouping Helpers

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`

**Step 1: Write the failing tests**

Add imports:

```ts
import {
  directChildRowsForParent,
  descendantRowsForParent,
  rootRowsForSessionTree,
} from "./workspace-session-list-model.js";
```

Add tests near the existing hierarchy tests:

```ts
test("session tree helpers expose roots, direct children, and descendants in row order", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const rows = buildRecentRows([
    {
      workspace,
      sessions: [
        { id: "root-a", title: "root-a", time: { created: 100, updated: 100 } },
        { id: "child-a", title: "child-a", parentID: "root-a", time: { created: 110, updated: 110 } },
        { id: "grandchild-a", title: "grandchild-a", parentID: "child-a", time: { created: 120, updated: 120 } },
        { id: "child-b", title: "child-b", parentID: "root-a", time: { created: 130, updated: 130 } },
        { id: "root-b", title: "root-b", time: { created: 90, updated: 90 } },
      ],
      status: "ready",
    },
  ]);

  assert.deepEqual(rootRowsForSessionTree(rows).map((row) => row.session.id), ["root-a", "root-b"]);
  assert.deepEqual(directChildRowsForParent(rows, "root-a").map((row) => row.session.id), ["child-a", "child-b"]);
  assert.deepEqual(descendantRowsForParent(rows, "root-a").map((row) => row.session.id), [
    "child-a",
    "grandchild-a",
    "child-b",
  ]);
});

test("session tree helpers treat rows whose parent is missing from the slice as roots", () => {
  const workspace = {
    id: "workspace-1",
    name: "workspace-1",
    path: "/tmp/workspace-1",
    preset: "starter",
    workspaceType: "local" as const,
  };

  const rows = buildRecentRows([
    {
      workspace,
      sessions: [
        { id: "root-a", title: "root-a", time: { created: 100, updated: 100 } },
        { id: "child-a", title: "child-a", parentID: "root-a", time: { created: 110, updated: 110 } },
      ],
      status: "ready",
    },
  ]);

  const sliced = rows.slice(1);

  assert.deepEqual(rootRowsForSessionTree(sliced).map((row) => row.session.id), ["child-a"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-model.test.ts
```

Expected: FAIL because the new helper exports do not exist.

**Step 3: Write minimal implementation**

Add to `workspace-session-list-model.ts` near `buildRowHierarchyLookup`:

```ts
export const rootRowsForSessionTree = (rows: FlatSessionRow[]): FlatSessionRow[] => {
  const ids = new Set(rows.map((row) => row.session.id));
  return rows.filter((row) => !row.parentSessionId || !ids.has(row.parentSessionId));
};

export const directChildRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const id = parentSessionId.trim();
  if (!id) return [];
  return rows.filter((row) => row.parentSessionId === id);
};

export const descendantRowsForParent = (
  rows: FlatSessionRow[],
  parentSessionId: string,
): FlatSessionRow[] => {
  const id = parentSessionId.trim();
  if (!id) return [];

  const parentIndex = rows.findIndex((row) => row.session.id === id);
  if (parentIndex < 0) return [];

  const parentLevel = rows[parentIndex].nestingLevel;
  const descendants: FlatSessionRow[] = [];

  for (let index = parentIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.nestingLevel <= parentLevel) break;
    descendants.push(row);
  }

  return descendants;
};
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-model.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "test: cover sidebar session branch grouping"
```

### Task 2: Add Local Collapse Animation Primitives

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Write the failing source-level tests**

Add tests:

```ts
test("workspace session sidebar defines local collapse animation primitives", () => {
  assert.match(source, /const SIDEBAR_COLLAPSE_DURATION_MS = 160;/);
  assert.match(source, /const AnimatedCollapse = \(props: AnimatedCollapseProps\) =>/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /onTransitionEnd=\{handleTransitionEnd\}/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because `AnimatedCollapse` does not exist yet.

**Step 3: Write minimal implementation**

Add a type import:

```ts
import type { JSX } from "solid-js";
```

Add constants and component above `WorkspaceSessionList`:

```tsx
const SIDEBAR_COLLAPSE_DURATION_MS = 160;
const SIDEBAR_COLLAPSE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

type AnimatedCollapseProps = {
  open: boolean;
  region: "project" | "session-branch";
  class?: string;
  innerClass?: string;
  children: JSX.Element;
  onExitComplete?: () => void;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const AnimatedCollapse = (props: AnimatedCollapseProps) => {
  const [rendered, setRendered] = createSignal(props.open);
  const [style, setStyle] = createSignal<JSX.CSSProperties>({
    height: props.open ? "auto" : "0px",
    opacity: props.open ? 1 : 0,
    overflow: "hidden",
    transform: props.open ? "translateY(0)" : "translateY(-2px)",
    transition: `height ${SIDEBAR_COLLAPSE_DURATION_MS}ms ${SIDEBAR_COLLAPSE_EASING}, opacity ${SIDEBAR_COLLAPSE_DURATION_MS}ms ${SIDEBAR_COLLAPSE_EASING}, transform ${SIDEBAR_COLLAPSE_DURATION_MS}ms ${SIDEBAR_COLLAPSE_EASING}`,
  });
  let outerRef: HTMLDivElement | undefined;
  let innerRef: HTMLDivElement | undefined;
  let frame = 0;

  const cancelFrame = () => {
    if (!frame || typeof window === "undefined") return;
    window.cancelAnimationFrame(frame);
    frame = 0;
  };

  const measuredHeight = () => innerRef?.scrollHeight ?? 0;

  createEffect(() => {
    const open = props.open;
    cancelFrame();

    if (prefersReducedMotion()) {
      setRendered(open);
      setStyle((current) => ({
        ...current,
        height: open ? "auto" : "0px",
        opacity: open ? 1 : 0,
        transform: "translateY(0)",
        transition: "none",
      }));
      if (!open) props.onExitComplete?.();
      return;
    }

    if (open) {
      setRendered(true);
      setStyle((current) => ({
        ...current,
        height: "0px",
        opacity: 0,
        transform: "translateY(-2px)",
      }));
      frame = window.requestAnimationFrame(() => {
        setStyle((current) => ({
          ...current,
          height: `${measuredHeight()}px`,
          opacity: 1,
          transform: "translateY(0)",
        }));
      });
      return;
    }

    if (!rendered()) return;

    setStyle((current) => ({
      ...current,
      height: `${measuredHeight()}px`,
      opacity: 1,
      transform: "translateY(0)",
    }));
    frame = window.requestAnimationFrame(() => {
      setStyle((current) => ({
        ...current,
        height: "0px",
        opacity: 0,
        transform: "translateY(-2px)",
      }));
    });
  });

  onCleanup(cancelFrame);

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target !== outerRef || event.propertyName !== "height") return;
    if (props.open) {
      setStyle((current) => ({ ...current, height: "auto" }));
      return;
    }
    setRendered(false);
    props.onExitComplete?.();
  };

  return (
    <div
      ref={(el) => (outerRef = el)}
      data-sidebar-collapse-region={props.region}
      class={props.class}
      style={style()}
      onTransitionEnd={handleTransitionEnd}
    >
      <Show when={rendered()}>
        <div ref={(el) => (innerRef = el)} class={props.innerClass}>
          {props.children}
        </div>
      </Show>
    </div>
  );
};
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "feat: add sidebar collapse animation primitive"
```

### Task 3: Render Session/Subagent Branches Through Animated Containers

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write the failing source-level tests**

Add tests:

```ts
test("session and subagent branches render through animated branch containers", () => {
  assert.match(source, /const AnimatedSessionBranch = \(props: AnimatedSessionBranchProps\) =>/);
  assert.match(source, /data-sidebar-collapse-region=\{props\.region\}/);
  assert.match(source, /descendantRowsForParent\(props\.rows, row\.session\.id\)/);
  assert.match(source, /directChildRowsForParent\(props\.rows, props\.parentSessionId\)/);
});

test("recent and by-project session lists use the animated session tree renderer", () => {
  assert.match(source, /renderSessionTreeRows\(\s*recentRowsVisible\(\),/s);
  assert.match(source, /renderSessionTreeRows\(\s*visibleRows\(\),/s);
  assert.match(source, /renderSessionTreeRows\(\s*chatRows\(\),/s);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: FAIL because the animated branch renderer does not exist.

**Step 3: Write minimal implementation**

Import the helpers from the model:

```ts
directChildRowsForParent,
descendantRowsForParent,
rootRowsForSessionTree,
```

Add local renderer types:

```ts
type SessionRowRenderOptions = {
  anchorPrefix: string;
  label?: (row: FlatSessionRow) => string;
  showWorkspaceMenu?: boolean;
  soulEnabled?: () => boolean;
  canRecover?: () => boolean;
  isConnectionActionBusy?: () => boolean;
};

type AnimatedSessionBranchProps = {
  parentSessionId: string;
  rows: FlatSessionRow[];
  open: boolean;
  hasChildren: (sessionId: string) => boolean;
  options: SessionRowRenderOptions;
};
```

Add these functions inside `WorkspaceSessionList`, after `projectSessionRow` so the renderer can reuse it:

```tsx
  const renderSingleSessionRow = (
    row: FlatSessionRow,
    hasChildren: (sessionId: string) => boolean,
    options: SessionRowRenderOptions,
  ) =>
    projectSessionRow(row, hasChildren, {
      anchorKey: `${options.anchorPrefix}:${row.rowKey}`,
      label: options.label ? () => options.label?.(row) ?? "" : undefined,
      showWorkspaceMenu: options.showWorkspaceMenu,
      soulEnabled: options.soulEnabled,
      canRecover: options.canRecover,
      isConnectionActionBusy: options.isConnectionActionBusy,
    });

  const renderSessionTreeRows = (
    rows: FlatSessionRow[],
    hasChildren: (sessionId: string) => boolean,
    options: SessionRowRenderOptions,
    parentSessionId?: string,
  ) => {
    const branchRows = parentSessionId
      ? directChildRowsForParent(rows, parentSessionId)
      : rootRowsForSessionTree(rows);

    return (
      <For each={branchRows}>
        {(row) => (
          <>
            {renderSingleSessionRow(row, hasChildren, options)}
            <Show when={hasChildren(row.session.id)}>
              <AnimatedSessionBranch
                parentSessionId={row.session.id}
                rows={descendantRowsForParent(rows, row.session.id)}
                open={expandedParentSessionIds().has(row.session.id)}
                hasChildren={hasChildren}
                options={options}
              />
            </Show>
          </>
        )}
      </For>
    );
  };

  const AnimatedSessionBranch = (props: AnimatedSessionBranchProps) => {
    const [renderedRows, setRenderedRows] = createSignal<FlatSessionRow[]>(props.open ? props.rows : []);

    createEffect(() => {
      if (props.open || props.rows.length > 0) {
        setRenderedRows(props.rows);
      }
    });

    return (
      <AnimatedCollapse
        open={props.open}
        region="session-branch"
        innerClass="space-y-0"
        onExitComplete={() => {
          if (!props.open) setRenderedRows([]);
        }}
      >
        {renderSessionTreeRows(
          renderedRows(),
          props.hasChildren,
          props.options,
          props.parentSessionId,
        )}
      </AnimatedCollapse>
    );
  };
```

If Solid reports that `AnimatedSessionBranch` is used before declaration, move the component and renderer above the first call while keeping access to `projectSessionRow`.

**Step 4: Replace flat row loops**

Recent mode:

```tsx
{renderSessionTreeRows(recentRowsVisible(), hasChildren, {
  anchorPrefix: "recent",
  soulEnabled,
  canRecover,
  isConnectionActionBusy,
})}
```

Project mode:

```tsx
{renderSessionTreeRows(visibleRows(), hasChildren, {
  anchorPrefix: "project-session",
  soulEnabled,
  canRecover,
  isConnectionActionBusy,
})}
```

Chaty:

```tsx
{renderSessionTreeRows(chatRows(), hasChildren, {
  anchorPrefix: "chat-session",
  label: (row) => sessionChatLabel(row.session, tr("session.chat_label")),
  showWorkspaceMenu: false,
})}
```

**Step 5: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "feat: animate sidebar session branches"
```

### Task 4: Animate By-Project Project Collapse

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write the failing source-level test**

Add:

```ts
test("by-project project contents use the animated project collapse region", () => {
  assert.match(
    source,
    /<AnimatedCollapse\s+open=\{!collapsed\(\)\}\s+region="project"[\s\S]*innerClass="pl-5 pt-0\.5 space-y-0"/,
  );

  assert.doesNotMatch(
    source,
    /<Show when=\{!collapsed\(\)\}>\s*<div class="pl-5 pt-0\.5 space-y-0">/,
    "project collapse should not instantly unmount project rows",
  );
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: FAIL because project collapse still uses `Show`.

**Step 3: Write minimal implementation**

Replace:

```tsx
<Show when={!collapsed()}>
  <div class="pl-5 pt-0.5 space-y-0">
    ...
  </div>
</Show>
```

with:

```tsx
<AnimatedCollapse open={!collapsed()} region="project" innerClass="pl-5 pt-0.5 space-y-0">
  <>
    {renderSessionTreeRows(visibleRows(), hasChildren, {
      anchorPrefix: "project-session",
      soulEnabled,
      canRecover,
      isConnectionActionBusy,
    })}
    ...
  </>
</AnimatedCollapse>
```

Keep the existing load-more and show-less buttons inside the project collapse region so the whole project content animates as one block.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "feat: animate sidebar project collapse"
```

### Task 5: Run App Checks

**Files:**
- Verify only.

**Step 1: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 2: Run unit tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Commit any fixes**

If either command fails, fix only the relevant failure and commit:

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/*.test.ts
git commit -m "fix: stabilize sidebar collapse animation checks"
```

### Task 6: Verify In The Real Desktop Runtime

**Files:**
- Verify only.

**Step 1: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If matches are internally started Veslo dev/test processes from this repo, stop them:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Verify no relevant process remains:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no output.

**Step 2: Start the desktop runtime**

Run:

```bash
pnpm dev
```

Expected: Veslo desktop opens from `packages/desktop`.

**Step 3: Manual desktop smoke**

In the desktop app:

- Switch the left menu to by-project mode.
- Collapse and expand a project; the whole project content should animate.
- Open a parent session that has subagent sessions, click the selected parent again, and confirm its subagent branch animates.
- Switch to recent mode and repeat the parent/subagent branch collapse/expand.
- Enable reduced motion at OS/browser level if practical and confirm the sidebar does not animate.

**Step 4: Stop the desktop runtime**

Stop the `pnpm dev` process before finishing.

**Step 5: Commit verification-only fixes if needed**

If desktop verification exposes a bug, fix only the sidebar behavior and commit:

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/*.test.ts
git commit -m "fix: correct sidebar collapse animation behavior"
```

### Task 7: Final Review

**Files:**
- Verify only.

**Step 1: Review the final diff**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: only intentional changes remain, and recent commits are scoped to the sidebar animation work.

**Step 2: Summarize verification**

Record:

- typecheck result
- unit test result
- real desktop runtime result
- any skipped E2E or reduced-motion checks, with reason
