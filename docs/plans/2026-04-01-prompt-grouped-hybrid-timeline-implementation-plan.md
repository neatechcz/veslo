# Prompt-Grouped Hybrid Timeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render one collapsible timeline group per user prompt, with independently collapsible subgroups by operation type, including explicit context compaction subgroup.

**Architecture:** Introduce a pure timeline grouping view-model helper that transforms ordered messages/parts into `PromptGroup[]` + contiguous type-based `Subgroup[]`. Keep classification and grouping rules in the helper, then simplify `message-list.tsx` to render the helper output. Preserve existing row rendering, running indicators, and technical detail disclosure.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test` via `tsx/esm`), pnpm, existing Veslo i18n locale files

---

## Prerequisites

- Use `@superpowers:test-driven-development` while implementing each behavior.
- Run changes in a dedicated worktree.
- Keep scope limited to session timeline grouping/labels and tests.

### Task 1: Prepare worktree and baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repo and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: completes without errors.

**Step 2: Create worktree**

Run:

```bash
git worktree add .worktrees/codex/prompt-grouped-hybrid-timeline -b codex/prompt-grouped-hybrid-timeline
cd .worktrees/codex/prompt-grouped-hybrid-timeline
```

Expected: new worktree on new branch.

**Step 3: Baseline checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-hybrid-timeline.test.ts
```

Expected: PASS (baseline for target area).

### Task 2: Add failing model tests for prompt-grouped timeline

**Files:**
- Create: `packages/app/src/app/components/session/timeline-group-model.test.ts`
- Test: `packages/app/src/app/components/session/timeline-group-model.test.ts`

**Step 1: Add failing test for prompt boundary grouping**

Add test that builds synthetic stream with two user prompts and asserts exactly two `PromptGroup` outputs.

**Step 2: Add failing test for multi-message single prompt continuity**

Add test where one user prompt has multiple adjacent assistant messages; assert one `PromptGroup` contains all rows.

**Step 3: Add failing test for subgroup splitting by type**

Use sequence `thinking -> action -> thinking -> subagent -> action`; assert contiguous subgroup kinds in that order.

**Step 4: Add failing test for issues not splitting subgroup**

Inject issue row between action rows; assert still one action subgroup (issue represented as row/status, not boundary).

**Step 5: Add failing test for compaction subgroup**

Inject compaction part (`session.summarize`, `compact`, or existing compaction marker shape); assert subgroup kind `compaction` exists.

**Step 6: Run targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-group-model.test.ts
```

Expected: FAIL (helper not implemented yet).

**Step 7: Commit failing tests**

```bash
git add packages/app/src/app/components/session/timeline-group-model.test.ts
git commit -m "test: add prompt-grouped timeline model specs"
```

### Task 3: Implement pure prompt-grouped timeline helper

**Files:**
- Create: `packages/app/src/app/components/session/timeline-group-model.ts`
- Modify: `packages/app/src/app/components/session/timeline-detail-model.ts` (only if small helper exports are needed)
- Test: `packages/app/src/app/components/session/timeline-group-model.test.ts`

**Step 1: Define model types**

Implement exported types similar to:

```ts
type PromptGroup = {
  id: string;
  promptMessageId: string;
  summary: string;
  latestLabel?: string;
  status?: "done" | "running" | "error" | "pass";
  subgroups: Subgroup[];
};

type SubgroupKind = "thinking" | "subagent" | "action" | "mcp" | "compaction" | "other";

type Subgroup = {
  id: string;
  kind: SubgroupKind;
  titleKey: string;
  rows: TimelineRowModel[];
  status?: "done" | "running" | "error" | "pass";
};
```

**Step 2: Implement part classification function**

Implement deterministic classifier from part + task metadata to `SubgroupKind`:

- reasoning/note -> `thinking`
- external subagent task -> `subagent`
- MCP tool markers -> `mcp`
- compaction markers -> `compaction`
- default execution -> `action`
- fallback -> `other`

**Step 3: Implement prompt ownership mapping**

Assign each assistant part to nearest previous user message in ordered message stream.

**Step 4: Implement subgroup compaction by contiguous kind**

Within each prompt group, merge adjacent rows of same `SubgroupKind`.

**Step 5: Implement issues-in-place behavior**

Ensure issue rows inherit current subgroup context and never open new subgroup by themselves.

**Step 6: Compute summaries/statuses**

Build prompt-level summary and subgroup statuses from rows.

**Step 7: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-group-model.test.ts
```

Expected: PASS.

**Step 8: Commit helper implementation**

```bash
git add packages/app/src/app/components/session/timeline-group-model.ts packages/app/src/app/components/session/timeline-group-model.test.ts packages/app/src/app/components/session/timeline-detail-model.ts
git commit -m "feat: add prompt-grouped timeline model"
```

### Task 4: Add failing source-contract tests for new render structure

**Files:**
- Modify: `packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts`
- Test: `packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts`

**Step 1: Add failing assertions for outer prompt-group rendering**

Assert source contains prompt-group loop and outer collapse handler.

**Step 2: Add failing assertions for subgroup rendering from model**

Assert subgroup loop and subgroup toggle usage.

**Step 3: Add failing assertions for compaction and mcp labels**

Assert usage of keys:

- `session.timeline_section_compaction`
- `session.timeline_section_mcp`

**Step 4: Run targeted test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-hybrid-timeline.test.ts
```

Expected: FAIL until render refactor lands.

**Step 5: Commit failing test updates**

```bash
git add packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts
git commit -m "test: specify prompt-grouped timeline rendering"
```

### Task 5: Refactor `message-list.tsx` to render prompt groups + typed subgroups

**Files:**
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/components/session/timeline-detail-state.ts` (if state shape extension needed)
- Test: `packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts`

**Step 1: Replace section derivation source with new group model**

Wire `timeline-group-model` output into `StepsContainer`.

**Step 2: Implement outer group collapse state**

One toggle controls full run visibility per prompt group.

**Step 3: Keep inner subgroup collapse state**

Each subgroup has independent toggle and retained state.

**Step 4: Preserve row rendering contract**

Keep existing row layout (icon, primary, secondary, status chip, technical details).

**Step 5: Ensure issues remain inline**

Do not create separate issues subgroup; display issue rows in active subgroup.

**Step 6: Run targeted render tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-hybrid-timeline.test.ts
```

Expected: PASS.

**Step 7: Commit UI refactor**

```bash
git add packages/app/src/app/components/session/message-list.tsx packages/app/src/app/components/session/timeline-detail-state.ts packages/app/src/app/components/session/message-list-hybrid-timeline.test.ts
git commit -m "feat: render prompt-grouped timeline with typed subgroups"
```

### Task 6: Add locale keys for new subgroup headings

**Files:**
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`

**Step 1: Add subgroup title keys**

Add keys:

- `session.timeline_section_subagents`
- `session.timeline_section_mcp`
- `session.timeline_section_compaction`
- `session.timeline_section_other`

**Step 2: Verify no missing key usage**

Run quick grep:

```bash
rg -n "timeline_section_(subagents|mcp|compaction|other)" packages/app/src
```

Expected: all referenced keys exist in both locale files.

**Step 3: Commit locale updates**

```bash
git add packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/en.ts
git commit -m "feat: add timeline subgroup locale labels"
```

### Task 7: End-to-end verification for this feature slice

**Files:**
- Modify: none (verification)

**Step 1: Run focused tests**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-group-model.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-hybrid-timeline.test.ts
```

Expected: PASS.

**Step 2: Run broader unit health for session components (if available)**

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS or documented unrelated failures.

**Step 3: Typecheck**

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS or documented unrelated pre-existing failures.

**Step 4: Capture manual verification notes**

Verify in desktop app session view:

- one user prompt with fragmented assistant output renders one outer group
- subgroup sequence reflects type transitions
- issues do not force subgroup split
- compaction subgroup appears when compaction event exists
- outer and inner collapse states both function

**Step 5: Final commit for any verification docs/tests (if changed)**

```bash
git add -A
git commit -m "test: verify prompt-grouped timeline behavior"
```
