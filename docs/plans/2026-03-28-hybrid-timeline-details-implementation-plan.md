# Hybrid Timeline Details Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the approved hybrid timeline detail UI in Session so collapsed execution blocks stay compact while expanded details are grouped into collapsible sections with clearer human-readable event rows.

**Architecture:** Extract the section-derivation and human-summary logic into a new pure helper module so it can be unit tested independently of the SolidJS view. Then update `message-list.tsx` to render the new outer collapse, inner section collapses, section summaries, event row hierarchy, and secondary technical disclosures while preserving existing streaming/running behavior.

**Tech Stack:** SolidJS, TypeScript, Lucide icons, existing Veslo i18n locale files, Node test runner (`node --test` via `tsx/esm`), pnpm

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Run implementation in a dedicated worktree before touching feature code.
- Keep scope limited to Session timeline detail UI; do not redesign the whole chat surface.

### Task 1: Create worktree and capture baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repository state**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: completes without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/hybrid-timeline-details -b codex/hybrid-timeline-details
cd .worktrees/codex/hybrid-timeline-details
```

Expected: new worktree is created and branch is checked out.

**Step 3: Capture baseline verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS before feature edits.

### Task 2: Add failing tests for section derivation and collapsed summary copy

**Files:**
- Create: `packages/app/src/app/components/session/timeline-detail-model.test.ts`
- Test: `packages/app/src/app/components/session/timeline-detail-model.test.ts`

**Step 1: Add tests for derived section classification**

Cover cases for:

- `Explore` from exploration tools
- `Action` from edit/write/bash/task/skill
- `Plan` only when explicit planning content exists
- `Issues` from error and synthetic session error inputs
- multiple runs of the same section type becoming separate sections when interrupted

**Step 2: Add tests for collapsed summary generation**

Assert examples such as:

```ts
assert.equal(buildCollapsedSummary(model), "Prozkoumáno 3 soubory · 2 akce · ověření OK");
assert.equal(buildCollapsedSummary(model), "2 akce · poslední: typecheck");
```

**Step 3: Add tests for event row copy**

Assert primary/secondary copy examples such as:

```ts
assert.equal(row.primary, "Načetl message-list.tsx");
assert.equal(row.secondary, "řádky 640-1040 · timeline labels a summary");
```

**Step 4: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
```

Expected: FAIL because helper module does not exist yet.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/components/session/timeline-detail-model.test.ts
git commit -m "test: add hybrid timeline detail model specs"
```

### Task 3: Implement pure timeline detail helper

**Files:**
- Create: `packages/app/src/app/components/session/timeline-detail-model.ts`
- Modify: `packages/app/src/app/utils/messages.ts` (only if a small export/helper is needed)
- Modify: `packages/app/src/app/utils/tools.ts` (only if a small helper export is needed)
- Test: `packages/app/src/app/components/session/timeline-detail-model.test.ts`

**Step 1: Define helper types**

Create types for:

```ts
type TimelineSectionKind = "plan" | "explore" | "action" | "verify" | "issues";
type TimelineRowModel = {
  kind: TimelineSectionKind;
  primary: string;
  secondary?: string;
  status?: "done" | "running" | "error" | "pass";
  technicalDetail?: string;
};
type TimelineSectionModel = {
  kind: TimelineSectionKind;
  title: string;
  summary: string;
  rows: TimelineRowModel[];
  status?: "done" | "running" | "error" | "pass";
};
```

**Step 2: Implement classification and grouping**

Implement pure helpers that:

- classify parts into section kinds
- merge consecutive parts of the same section kind
- emit `Plan` only when planning content exists
- promote errors to `Issues`

**Step 3: Implement human-readable row copy**

Requirements:

- tool-centric data becomes human row copy
- raw commands are preserved only as `technicalDetail`
- secondary text reflects outcome, not command syntax

**Step 4: Implement collapsed summary builder**

Generate the approved human summary line without exposing raw tool names.

**Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
```

Expected: PASS.

**Step 6: Commit helper implementation**

```bash
git add packages/app/src/app/components/session/timeline-detail-model.ts packages/app/src/app/components/session/timeline-detail-model.test.ts packages/app/src/app/utils/messages.ts packages/app/src/app/utils/tools.ts
git commit -m "feat: add hybrid timeline detail model"
```

### Task 4: Add failing view-layer specs for nested collapse state

**Files:**
- Create: `packages/app/src/app/components/session/timeline-detail-state.test.ts`
- Test: `packages/app/src/app/components/session/timeline-detail-state.test.ts`

**Step 1: Add tests for outer block collapse state**

Assert:

- timeline block starts collapsed
- toggling the outer block expands/collapses the whole detail area

**Step 2: Add tests for section collapse behavior**

Assert:

- sections can expand independently
- multiple sections can remain open
- toggling one section does not close other open sections
- running/active section can auto-open when model marks it running

**Step 3: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-state.test.ts
```

Expected: FAIL because state helper does not exist yet.

**Step 4: Commit failing tests**

```bash
git add packages/app/src/app/components/session/timeline-detail-state.test.ts
git commit -m "test: add hybrid timeline collapse state specs"
```

### Task 5: Implement nested collapse state helper

**Files:**
- Create: `packages/app/src/app/components/session/timeline-detail-state.ts`
- Test: `packages/app/src/app/components/session/timeline-detail-state.test.ts`

**Step 1: Implement outer and inner state helpers**

Implement pure functions for:

- default outer collapsed state
- default section states
- independent section toggles
- optional auto-open for running section

**Step 2: Keep behavior simple**

Do not add persistence in this feature. State may remain ephemeral per rendered message list.

**Step 3: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-state.test.ts
```

Expected: PASS.

**Step 4: Commit state helper**

```bash
git add packages/app/src/app/components/session/timeline-detail-state.ts packages/app/src/app/components/session/timeline-detail-state.test.ts
git commit -m "feat: add hybrid timeline collapse state helper"
```

### Task 6: Wire the hybrid timeline UI into `message-list.tsx`

**Files:**
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Test: `packages/app/src/app/components/session/timeline-detail-model.test.ts`
- Test: `packages/app/src/app/components/session/timeline-detail-state.test.ts`

**Step 1: Replace flat expanded step rendering with section rendering**

Use the new model helper to render:

- outer collapsed summary
- inner sections stacked vertically
- independent section toggles
- running status indicators

**Step 2: Replace current flat step row hierarchy**

Render event rows with:

- leading icon
- primary line
- secondary line
- trailing status chip
- optional technical disclosure

**Step 3: Add new locale strings**

Add locale keys for:

- section titles
- collapsed summary fragments
- row detail disclosure label
- status chip copy

**Step 4: Preserve existing streaming behavior**

Keep current auto-updating/running feedback and avoid introducing scroll regressions.

**Step 5: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-state.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit UI wiring**

```bash
git add packages/app/src/app/components/session/message-list.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/app/components/session/timeline-detail-model.ts packages/app/src/app/components/session/timeline-detail-state.ts
git commit -m "feat: implement hybrid timeline detail ui"
```

### Task 7: Manual verification and finish

**Files:**
- Modify: none (verification only)

**Step 1: Launch the desktop app**

Run:

```bash
pnpm --filter @neatech/veslo-desktop tauri dev
```

Expected: Veslo desktop app starts locally.

**Step 2: Verify the timeline interaction manually**

Check:

- whole timeline is collapsed by default
- collapsed header summary is human-readable
- no tabs exist
- sections can be expanded/collapsed independently
- multiple sections can remain open
- raw command text is hidden behind secondary disclosure

**Step 3: Capture screenshots**

Save screenshots showing:

- collapsed timeline block
- expanded timeline with multiple sections open
- technical detail disclosure open on one row

**Step 4: Commit verification artifacts if they are intended to live in repo**

```bash
git add <relevant screenshot paths if kept in repo>
git commit -m "docs: add hybrid timeline verification captures"
```

Expected: only commit screenshots if the team wants them in-repo; otherwise keep them out of git.
