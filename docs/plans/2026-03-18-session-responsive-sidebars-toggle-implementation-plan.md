# Session Responsive Sidebars Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add top-fixed left/right sidebar toggle controls to Session view with message-width-driven responsive behavior, including narrow-mode overlay sidebars and one-overlay-only interaction rules.

**Architecture:** Extract the responsive sidebar behavior into a small pure layout model so width hysteresis and toggle rules are unit-tested independently from Solid rendering. Keep `session.tsx` as the integration point that renders docked sidebars or overlay sidebars based on model state, with persisted docked preferences in local storage. Add lightweight custom inline SVG icons that match existing Lucide-like visual weight.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test`), Tailwind utility classes, pnpm

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Follow `@solidjs-patterns` guidance from `.opencode/skills/solidjs-patterns/SKILL.md` for state/reactivity updates in `session.tsx`.
- Execute in a dedicated worktree before touching feature code.

### Task 1: Prepare isolated workspace and baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repositories/submodules to current remotes**

Run:

```bash
git submodule update --init --recursive
git fetch --all --prune
```

Expected: completes without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/session-responsive-sidebars -b codex/session-responsive-sidebars
cd .worktrees/codex/session-responsive-sidebars
```

Expected: new worktree exists and branch is checked out.

**Step 3: Capture baseline verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS before feature edits.

**Step 4: Commit prep checkpoint (optional if no file changes)**

Only if any project files were touched during setup.

### Task 2: Add failing unit tests for sidebar layout behavior

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-layout-model.test.ts`
- Test: `packages/app/src/app/components/session/sidebar-layout-model.test.ts`

**Step 1: Write failing tests for hysteresis thresholds**

Add tests that enforce:
- enter narrow mode when available chat width is `< 760`
- remain narrow between `760` and `783`
- return to wide only when available width `>= 784`

**Step 2: Write failing tests for narrow-mode toggle rules**

Add tests that enforce:
- only one overlay can be open in narrow mode
- clicking opposite side while one overlay is open is a no-op
- clicking the active side toggles it closed

**Step 3: Write failing tests for wide-mode docked toggles**

Add tests that enforce:
- wide mode toggles left/right docked visibility independently
- narrow entry hides docked sidebars without deleting stored preference
- wide re-entry restores stored docked preference

**Step 4: Run targeted tests to confirm failures**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-layout-model.test.ts
```

Expected: FAIL due missing model implementation.

**Step 5: Commit failing tests**

```bash
git add packages/app/src/app/components/session/sidebar-layout-model.test.ts
git commit -m "test: add session sidebar layout model specs"
```

### Task 3: Implement the sidebar layout model to satisfy tests

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-layout-model.ts`
- Modify: `packages/app/src/app/components/session/sidebar-layout-model.test.ts` (only if assertions need adjustment)
- Test: `packages/app/src/app/components/session/sidebar-layout-model.test.ts`

**Step 1: Implement model types and constants**

Include explicit constants:
- `SESSION_CHAT_MIN_WIDTH = 760`
- `SESSION_CHAT_MIN_WIDTH_EXIT = 784`

Include types for mode, docked state, overlay side, and transition inputs/outputs.

**Step 2: Implement pure reducers/helpers**

Implement pure functions for:
- mode derivation with hysteresis
- resize transition handling
- left/right toggle actions in wide mode
- left/right toggle actions in narrow mode with opposite-side no-op rule

**Step 3: Keep the model side-effect free**

No DOM, no local storage, no Solid signals in this file.

**Step 4: Re-run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-layout-model.test.ts
```

Expected: PASS.

**Step 5: Commit model implementation**

```bash
git add packages/app/src/app/components/session/sidebar-layout-model.ts packages/app/src/app/components/session/sidebar-layout-model.test.ts
git commit -m "feat: add session sidebar layout state model"
```

### Task 4: Add top-fixed custom SVG toggle icons and controls shell

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-toggle-icons.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/components/session/composer-controls-layout.test.ts` (update if needed for layout assertions)

**Step 1: Add icon components matching existing style**

Create two exported icon components:
- `LeftSidebarToggleIcon`
- `RightSidebarToggleIcon`

Both should use:
- `viewBox="0 0 24 24"`
- `fill="none"`
- rounded stroke joins/caps
- rounded outer rectangle + side-specific inner vertical line

**Step 2: Add top-fixed control container to Session view**

In `session.tsx`, add fixed top controls with:
- left toggle button (`aria-label`/`title`)
- right toggle button (`aria-label`/`title`)
- active/hover/focus states aligned with existing button style

**Step 3: Keep controls always visible while scrolling**

Use fixed or sticky positioning anchored to the top window region (as approved).

**Step 4: Run typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit icon/control shell**

```bash
git add packages/app/src/app/components/session/sidebar-toggle-icons.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/composer-controls-layout.test.ts
git commit -m "feat: add top-fixed session sidebar toggle controls"
```

### Task 5: Integrate responsive mode + docked/overlay rendering in Session view

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/sidebar-layout-model.ts` (if integration gaps are found)
- Test: `packages/app/src/app/components/session/sidebar-layout-model.test.ts`

**Step 1: Wire layout model state into `session.tsx`**

Add integration state for:
- measured layout width source
- current mode (`wide`/`narrow`)
- docked visibility state
- overlay open side (`null | left | right`)

**Step 2: Add width measurement with `ResizeObserver`**

Observe the session layout container and calculate available chat width.

Apply hysteresis through model functions.

**Step 3: Render sidebars by mode**

- Wide mode: render docked sidebars based on docked visibility state.
- Narrow mode: hide docked sidebars and render overlay sidebars when toggled.

**Step 4: Enforce narrow interaction contract**

- only one overlay active
- opposite-button click no-op
- same-button click closes active overlay

**Step 5: Run targeted model tests + typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-layout-model.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit responsive integration**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/sidebar-layout-model.ts packages/app/src/app/components/session/sidebar-layout-model.test.ts
git commit -m "feat: add responsive session sidebars with overlay mode"
```

### Task 6: Add persistence + accessibility + close behaviors

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/components/session/sidebar-layout-model.test.ts` (for restore behavior)

**Step 1: Persist docked visibility for wide mode**

Implement safe local storage integration using key:
- `veslo.session.sidebar.docked.v1`

Persist only wide-mode docked visibility (`{ left, right }`).

**Step 2: Add overlay dismissal controls**

In narrow mode overlay:
- close on backdrop click
- close on `Escape`
- close from same toggle button

**Step 3: Validate accessibility attributes**

Ensure toggle and overlay controls include:
- `aria-label`
- keyboard operation via native button semantics
- visible focus ring consistent with app styles

**Step 4: Run tests and typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/sidebar-layout-model.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit persistence + a11y updates**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/sidebar-layout-model.test.ts
git commit -m "feat: persist docked sidebar state and add overlay a11y controls"
```

### Task 7: Run full verification and end-to-end UI gate with Docker + Chrome MCP

**Files:**
- Modify: none expected (verification + evidence)

**Step 1: Run required local verification suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Start Veslo dev stack via Docker (required gate)**

From repo root run:

```bash
packaging/docker/dev-up.sh
```

Expected: local dev stack starts successfully.

**Step 3: Execute UI validation with Chrome MCP skill**

Use:

```text
.opencode/skills/openwork-docker-chrome-mcp/SKILL.md
```

Validate:
- top-fixed toggles visible
- narrow auto-hide triggers by message-width behavior
- one-overlay-only rule
- opposite-button no-op rule
- return-to-wide restoration behavior

**Step 4: Capture evidence**

Save screenshots in repo (for example under `evidence/` or `docs/`) showing:
- wide mode with both docked sidebars
- narrow mode with no docked sidebars
- left overlay open
- right overlay open
- opposite-button no-op state

**Step 5: If Docker or Chrome MCP cannot run**

Document explicitly:
- which step failed
- why it failed
- what was verified instead
- exact commands reviewer should run to complete the gate

**Step 6: Commit final verification artifacts (if any)**

```bash
git add evidence docs
# if evidence files were added
# git commit -m "test: verify responsive session sidebar toggle flow"
```
