# Clickable File Path Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make assistant-rendered file path lines clickable even when the path contains spaces.

**Architecture:** Extend the session text renderer in `packages/app/src/app/components/part-view.tsx` so it can detect standalone file-path lines before whitespace tokenization. Keep the existing link opener pipeline and add targeted coverage for the new detection helpers.

**Tech Stack:** SolidJS, TypeScript, `marked`, pnpm workspace scripts

---

### Task 1: Add failing coverage for standalone file-path lines

**Files:**
- Create: `packages/app/src/app/components/part-view.path-links.test.ts`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

Add focused tests for helper-level rendering behavior:

- absolute POSIX path with spaces
- workspace-relative path with spaces
- ordinary URL
- ordinary prose that should remain plain text

The tests should assert the generated segments or HTML contain a file anchor only for the path cases.

**Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test packages/app/src/app/components/part-view.path-links.test.ts`

Expected: FAIL because the current renderer splits space-containing paths and does not expose a helper that can link them.

**Step 3: Write minimal implementation**

Export a small set of pure helpers from `part-view.tsx` or a nearby helper module so the tests can exercise line detection without mounting the full component.

**Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test packages/app/src/app/components/part-view.path-links.test.ts`

Expected: PASS

### Task 2: Implement standalone path-line auto-linking

**Files:**
- Modify: `packages/app/src/app/components/part-view.tsx`

**Step 1: Write the failing test**

Add or extend a case that covers multi-line assistant text, where the line after `Soubor je tady:` is a path with spaces and should render as a file link.

**Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test packages/app/src/app/components/part-view.path-links.test.ts`

Expected: FAIL because the current line rendering still treats the path as plain text.

**Step 3: Write minimal implementation**

- Introduce standalone-line detection before `splitTextTokens`.
- Reuse `parseLinkFromToken` and existing path normalization where possible.
- Apply the same pre-processing to markdown text rendering for paragraph text, without changing code block rendering.

**Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test packages/app/src/app/components/part-view.path-links.test.ts`

Expected: PASS

### Task 3: Verify the app surface stays healthy

**Files:**
- Modify: `packages/app/src/app/components/part-view.tsx`
- Test: `packages/app/src/app/components/part-view.path-links.test.ts`

**Step 1: Run targeted verification**

Run:

```bash
pnpm exec tsx --test packages/app/src/app/components/part-view.path-links.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: both commands pass.

**Step 2: Run the closest existing UI regression check if relevant**

Run: `pnpm --filter @neatech/veslo-ui test:local-file-path`

Expected: PASS, or document why the existing script does not cover this renderer path.

**Step 3: Summarize validation gaps**

Document whether Docker dev stack, Chrome MCP validation, and screenshots were run. If not, explain why and list the exact commands for the user to run.
