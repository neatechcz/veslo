# Session Branch Toggle Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the inline session branch toggle with a centered overlay chevron below the session title, and make session branch expansion explicit-only with no implicit auto-expand.

**Architecture:** Keep `expandedParentSessionIds` as the only branch-visibility state in `WorkspaceSessionList`, but mutate it only from the dedicated branch toggle. Remove the selected-session auto-expand synchronization path and render a visual toggle overlay that does not participate in title-row layout flow. Reuse existing hierarchy lookups, row click behavior, and localized expand/collapse labels.

**Tech Stack:** SolidJS, `lucide-solid`, Tailwind utility classes, Node test runner via `node --test --import=tsx/esm`.

---

### Task 1: Remove Implicit Session Branch Expansion

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write the failing tests for the new expansion contract**

Update tests so they assert the new product rule:

- selected sessions do not auto-expand parent branches
- newly visible child sessions do not auto-expand parent branches
- no code path in `workspace-session-list.tsx` derives expanded parents from `selectedSessionId`

Replace the old assertions with checks along these lines:

```ts
assert.doesNotMatch(source, /deriveExpandedParentSessionIds/);
assert.doesNotMatch(
  source,
  /setExpandedParentSessionIds\(\(current\) => deriveExpandedParentSessionIds\(/
);
```

and remove the `deriveExpandedParentSessionIds(...)` behavioral test from `workspace-session-list-model.test.ts`.

**Step 2: Run targeted tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts src/app/components/session/workspace-session-list-interactions.test.ts
```

Expected: FAIL because the old auto-expand helper and selected-session wiring still exist.

**Step 3: Remove the implicit expansion code**

In `workspace-session-list.tsx`:

- delete the `createEffect(...)` block that reads `props.selectedSessionId` and calls `deriveExpandedParentSessionIds(...)`
- remove `deriveExpandedParentSessionIds` from the import list

In `workspace-session-list-model.ts`:

- delete the `deriveExpandedParentSessionIds(...)` export
- delete any helper that becomes dead code only because of that removal
- keep `buildRowHierarchyLookup`, `rowVisibleByExpansion`, and `requiredVisibleCountForExpandedSession` intact

The intended end state is:

```ts
const [expandedParentSessionIds, setExpandedParentSessionIds] = createSignal<Set<string>>(new Set());

// expandedParentSessionIds changes only from explicit toggle actions
const toggleExpandedParentSession = (sessionId: string) =>
  setExpandedParentSessionIds((current) => {
    const next = new Set(current);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  });
```

**Step 4: Re-run targeted tests and confirm GREEN**

Run the command from Step 2 again.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-model.ts packages/app/src/app/components/session/workspace-session-list-model.test.ts packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "refactor(sidebar): make session branch expansion manual only"
```

### Task 2: Replace the Inline Toggle with a Centered Overlay Chevron

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`

**Step 1: Write the failing UI/layout tests first**

Add assertions for all of these:

- the old inline text toggle (`"v"` / `">"`) is gone
- parent session rows still wire the dedicated `handleSessionExpandToggle(...)`
- rows with children render a circular chevron button instead of the text glyph
- the overlay toggle is centered under the title/content column, not rendered inline before the title
- row spacing still uses the existing compact `py-1` / `space-y-0` contract

Useful source assertions:

```ts
assert.doesNotMatch(source, /\{isParentExpanded\(session\(\)\.id\) \? "v" : ">"\}/);
assert.match(source, /ChevronRight/);
assert.match(source, /ChevronDown/);
assert.match(source, /absolute left-1\/2 .* -translate-x-1\/2/);
```

Keep the existing assertion that the branch toggle handler stops propagation and only toggles expansion.

**Step 2: Run targeted UI tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-interactions.test.ts src/app/components/session/workspace-session-list-recent-layout.test.ts
```

Expected: FAIL because the current markup still renders the inline text toggle in both row variants.

**Step 3: Implement the overlay toggle**

In `workspace-session-list.tsx`:

- import `ChevronDown` and `ChevronRight` from `lucide-solid`
- remove the inline toggle button from the title-row flex content in both recent and by-project session render paths
- make the content region `relative`
- add a shared toggle button markup block that is rendered only when `hasChildren(sessionId)` is true
- style it to match the small circular dashboard-nav toggle chrome while keeping branch-direction icons

Use a shared button shape like:

```tsx
<button
  type="button"
  class="absolute left-1/2 inline-flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-10 shadow-sm transition-colors hover:bg-gray-2 hover:text-gray-11 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-7"
  aria-label={sessionBranchToggleLabel(sessionId)}
  title={sessionBranchToggleLabel(sessionId)}
  onClick={(event) => handleSessionExpandToggle(event, sessionId)}
>
  <Show when={isParentExpanded(sessionId)} fallback={<ChevronRight size={11} />}>
    <ChevronDown size={11} />
  </Show>
</button>
```

Placement rules:

- recent rows: place the button between the title line and metadata line, centered in the text column
- by-project rows: place the button centered just below the title line inside the existing row bounds
- do not add a new block row for the button
- do not change `py-1`, `space-y-0`, or the existing right-side timestamp/archive rail

Keep `rowIndentStyle(row)` unchanged so child rows stay nested; only remove the extra left offset created by the inline toggle slot.

**Step 4: Re-run targeted UI tests and confirm GREEN**

Run the command from Step 2 again.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts
git commit -m "feat(sidebar): center session branch toggle below titles"
```

### Task 3: Verify the Sidebar Contract End-to-End at the Unit Level

**Files:**
- No source changes required unless verification exposes a regression

**Step 1: Run the complete sidebar-focused test set**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-model.test.ts src/app/components/session/workspace-session-list-interactions.test.ts src/app/components/session/workspace-session-list-recent-layout.test.ts src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS.

**Step 2: Run the full unit suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Optional desktop visual smoke-check**

If you want a live visual confirmation in the real desktop runtime without creating a new E2E spec, run:

```bash
cd packages/desktop
pnpm tauri dev
```

Verify manually:

- parent session titles align with sibling rows at the same nesting level
- child rows remain indented
- no parent branch auto-expands when a new subagent appears
- clicking the centered chevron toggles only branch visibility
- row click behavior still opens/selects sessions

**Step 4: Commit only if verification required follow-up fixes**

If no verification fixes were needed, do not create an extra commit.
