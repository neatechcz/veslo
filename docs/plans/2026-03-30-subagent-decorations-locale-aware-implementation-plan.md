# Locale-Aware Subagent Decorations In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep subagent sessions nested under their parent session in the left sidebar, and add persistent, locale-aware decorative labels (first names) and colors for subagents with AI-first role mapping and deterministic fallback.

**Architecture:** Keep session hierarchy in existing sidebar model (`parentID`), remove hard-hiding of subagent sessions in sidebar data flow, and layer decorations through a new UI persistence registry keyed per workspace in localStorage. Resolve subagent role via AI-first classifier with short timeout, then fallback to deterministic keyword mapping; map each role to stable first names by locale (`cs`/`en`) and unique colors per parent session.

**Tech Stack:** SolidJS, TypeScript, Node test runner (`node --test --import=tsx/esm`), pnpm, Tauri desktop app, Docker dev stack, Chrome MCP

---

## Prerequisites

- Use `@superpowers:test-driven-development` while implementing every task.
- Execute in a dedicated worktree (do not implement on a dirty shared tree).
- Never run `packages/web` (Next.js rule from AGENTS); run desktop via Tauri command.
- Required end-to-end gate: `packaging/docker/dev-up.sh` + `@.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

### Task 1: Prepare isolated branch and baseline

**Files:**
- Modify: none (environment only)

**Step 1: Sync remotes and submodules**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: both commands succeed without errors.

**Step 2: Create and enter worktree**

Run:

```bash
git worktree add .worktrees/codex/subagent-decorations-locale -b codex/subagent-decorations-locale origin/main
cd .worktrees/codex/subagent-decorations-locale
```

Expected: clean worktree on new branch.

**Step 3: Install deps**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: install succeeds.

**Step 4: Run baseline tests for current sidebar model/layout**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-model.test.ts \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts
```

Expected: PASS baseline.

**Step 5: Commit prep marker**

```bash
git commit --allow-empty -m "chore: start locale-aware subagent decorations worktree"
```

### Task 2: Add failing tests for subagent decoration persistence format

**Files:**
- Create: `packages/app/src/app/lib/subagent-decorations-persistence.test.ts`
- Test: `packages/app/src/app/lib/subagent-decorations-persistence.test.ts`

**Step 1: Write failing tests**

Create tests covering:

```ts
test("parse returns empty state on null/invalid payload", () => { /* ... */ });
test("parse keeps only valid role and session records", () => { /* ... */ });
test("serialize returns null for empty state", () => { /* ... */ });
test("serialize+parse roundtrip preserves locale names and color tokens", () => { /* ... */ });
```

Include fixtures for:
- `roleRegistry[roleKey].firstNameByLocale.cs/en`
- `sessionDecorations[sessionId].colorToken`
- version mismatch fallback.

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-decorations-persistence.test.ts
```

Expected: FAIL because module does not exist.

**Step 3: Commit failing test**

```bash
git add packages/app/src/app/lib/subagent-decorations-persistence.test.ts
git commit -m "test: specify subagent decorations persistence format"
```

### Task 3: Implement persistence module and pass tests

**Files:**
- Create: `packages/app/src/app/lib/subagent-decorations-persistence.ts`
- Modify: `packages/app/src/app/lib/subagent-decorations-persistence.test.ts`

**Step 1: Implement minimal persistence schema**

Create module with:

```ts
export const SUBAGENT_DECORATIONS_SCHEMA_VERSION = 1;
export type RoleRegistryEntry = {
  displayByLocale: Record<string, string>;
  firstNameByLocale: Record<string, string>;
};
export type SessionDecorationEntry = {
  parentSessionId: string;
  roleKey: string;
  baseFirstName: string;
  colorToken: string;
  indexInParentRole: number;
};
export type SubagentDecorationsState = {
  version: number;
  roleRegistry: Record<string, RoleRegistryEntry>;
  sessionDecorations: Record<string, SessionDecorationEntry>;
};
```

And helpers:

```ts
export function parseSubagentDecorations(raw: string | null): SubagentDecorationsState { /* ... */ }
export function serializeSubagentDecorations(state: SubagentDecorationsState): string | null { /* ... */ }
export function emptySubagentDecorationsState(): SubagentDecorationsState { /* ... */ }
```

**Step 2: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-decorations-persistence.test.ts
```

Expected: PASS.

**Step 3: Commit implementation**

```bash
git add \
  packages/app/src/app/lib/subagent-decorations-persistence.ts \
  packages/app/src/app/lib/subagent-decorations-persistence.test.ts
git commit -m "feat: add persistent subagent decorations state schema"
```

### Task 4: Add failing tests for locale-aware role/name/color allocation

**Files:**
- Create: `packages/app/src/app/lib/subagent-decoration-model.test.ts`
- Test: `packages/app/src/app/lib/subagent-decoration-model.test.ts`

**Step 1: Write failing tests**

Cover these contracts:

```ts
test("same role keeps same first name by locale across sessions", () => { /* cs/en */ });
test("duplicate same-role children in one parent use suffix index", () => { /* Jan, Jan #2 */ });
test("duplicate same-role children in one parent use distinct colors", () => { /* unique per parent */ });
test("switching locale uses locale-specific first name", () => { /* cs -> en */ });
test("fallback classifier resolves role when AI output missing", () => { /* keyword map */ });
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-decoration-model.test.ts
```

Expected: FAIL because model module does not exist.

**Step 3: Commit failing tests**

```bash
git add packages/app/src/app/lib/subagent-decoration-model.test.ts
git commit -m "test: specify locale-aware subagent decoration allocation"
```

### Task 5: Implement decoration model (deterministic core + fallback classifier)

**Files:**
- Create: `packages/app/src/app/lib/subagent-decoration-model.ts`
- Modify: `packages/app/src/app/lib/subagent-decoration-model.test.ts`

**Step 1: Implement deterministic core**

Implement:

```ts
export type DecorationLocale = "cs" | "en";
export type RoleProfile = { roleKey: string; roleDisplay: string; suggestedFirstName: string };
export function classifyRoleDeterministic(input: { description?: string; subagentType?: string; locale: DecorationLocale }): RoleProfile { /* ... */ }
export function allocateDecorationForSession(/* state, parentSessionId, sessionId, roleProfile, locale */) { /* ... */ }
export function buildDecoratedLabel(baseFirstName: string, indexInParentRole: number): string { /* Jan / Jan #2 */ }
```

Use fixed color palette and ensure parent-level uniqueness before reuse.

**Step 2: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-decoration-model.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add \
  packages/app/src/app/lib/subagent-decoration-model.ts \
  packages/app/src/app/lib/subagent-decoration-model.test.ts
git commit -m "feat: add locale-aware subagent decoration allocator"
```

### Task 6: Add failing tests for AI-first role resolver with timeout fallback

**Files:**
- Create: `packages/app/src/app/lib/subagent-role-resolver.test.ts`
- Test: `packages/app/src/app/lib/subagent-role-resolver.test.ts`

**Step 1: Write failing tests**

Define tests for:

```ts
test("uses AI result when valid JSON profile arrives before timeout", async () => { /* ... */ });
test("falls back to deterministic classifier on timeout", async () => { /* ... */ });
test("falls back to deterministic classifier on malformed AI output", async () => { /* ... */ });
```

Mock resolver input and parser; keep it side-effect free.

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-role-resolver.test.ts
```

Expected: FAIL because resolver module does not exist.

**Step 3: Commit failing tests**

```bash
git add packages/app/src/app/lib/subagent-role-resolver.test.ts
git commit -m "test: specify ai-first subagent role resolution fallback"
```

### Task 7: Implement AI-first role resolver

**Files:**
- Create: `packages/app/src/app/lib/subagent-role-resolver.ts`
- Modify: `packages/app/src/app/lib/subagent-role-resolver.test.ts`

**Step 1: Implement resolver abstraction**

Implement:

```ts
export type ResolveRoleInput = {
  locale: "cs" | "en";
  description?: string;
  subagentType?: string;
};
export type ResolveRoleDeps = {
  runAiClassifier: (input: ResolveRoleInput) => Promise<string>;
  classifyDeterministic: (input: ResolveRoleInput) => RoleProfile;
  timeoutMs?: number;
};
export async function resolveRoleProfile(input: ResolveRoleInput, deps: ResolveRoleDeps): Promise<RoleProfile> { /* ... */ }
```

AI parser contract: JSON with `role_key`, `role_label`, `first_name`.

**Step 2: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-role-resolver.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add \
  packages/app/src/app/lib/subagent-role-resolver.ts \
  packages/app/src/app/lib/subagent-role-resolver.test.ts
git commit -m "feat: add ai-first role resolver with deterministic fallback"
```

### Task 8: Add failing sidebar interaction/render contract tests

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.test.ts`

**Step 1: Extend tests**

Add assertions for:

- selected parent click toggles expansion (pattern-level source contract),
- child rows render decorated label path (not raw title only),
- child label color class/style hook present,
- hover title includes full label context,
- model preserves completed child rows and orphan fallback.

Example assertion:

```ts
assert.match(source, /selectedParentHasChildren[\s\S]*toggleExpandedParent/);
assert.match(source, /title=\{sessionTitleTooltip\(/);
```

**Step 2: Run targeted tests (expect FAIL)**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts \
  src/app/components/session/workspace-session-list-model.test.ts
```

Expected: FAIL on new assertions.

**Step 3: Commit failing tests**

```bash
git add \
  packages/app/src/app/components/session/workspace-session-list-interactions.test.ts \
  packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts \
  packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "test: define nested subagent decoration sidebar behavior"
```

### Task 9: Implement session data flow + decoration persistence wiring

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/types.ts`
- Create: `packages/app/src/app/lib/subagent-decoration-storage.ts`
- Create: `packages/app/src/app/lib/subagent-decoration-storage.test.ts`

**Step 1: Implement storage key + load/save helpers**

Add workspace-scoped key helper:

```ts
export const subagentDecorationsKey = (workspaceId: string) =>
  `veslo.subagent-decorations.v1.${workspaceId.trim()}`;
```

Implement read/write wrappers around persistence parser.

**Step 2: Integrate in `app.tsx`**

- Add signal for decoration state.
- Hydrate on active workspace change.
- Persist on state changes.
- Stop hard-filtering child sessions out of sidebar rows.

**Step 3: Integrate role/decorator assignment**

- On new child session discovery, resolve role profile (AI-first + fallback) and allocate decoration.
- Store decoration by `sessionId`.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-decorations-persistence.test.ts \
  src/app/lib/subagent-decoration-model.test.ts \
  src/app/lib/subagent-role-resolver.test.ts \
  src/app/lib/subagent-decoration-storage.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/context/session.ts \
  packages/app/src/app/app.tsx \
  packages/app/src/app/types.ts \
  packages/app/src/app/lib/subagent-decoration-storage.ts \
  packages/app/src/app/lib/subagent-decoration-storage.test.ts
git commit -m "feat: wire persistent subagent decoration state into app flow"
```

### Task 10: Implement sidebar rendering + interactions in both modes

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list-model.ts`

**Step 1: Add expand/collapse state and click logic**

Implement logic:

```ts
if (!isSelected()) onOpenSession(...)
else if (hasChildren(row.session.id)) toggleExpandedParent(row.session.id)
```

**Step 2: Apply child visibility filter**

- Parent rows always visible.
- Child rows visible only when parent expanded.
- Orphan child visible fallback.

**Step 3: Render decorated labels + color**

- For child rows use decoration label (`Jan`, `Jan #2`) and color class/style.
- Add full hover title for both modes.

**Step 4: Run sidebar tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/components/session/workspace-session-list-interactions.test.ts \
  src/app/components/session/workspace-session-list-recent-layout.test.ts \
  src/app/components/session/workspace-session-list-model.test.ts \
  src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/components/session/workspace-session-list.tsx \
  packages/app/src/app/components/session/workspace-session-list-model.ts \
  packages/app/src/app/components/session/workspace-session-list-interactions.test.ts \
  packages/app/src/app/components/session/workspace-session-list-recent-layout.test.ts \
  packages/app/src/app/components/session/workspace-session-list-model.test.ts
git commit -m "feat: render locale-aware decorated subagent rows in sidebar"
```

### Task 11: Full targeted verification and static checks

**Files:**
- Modify: none (verification only)

**Step 1: Run unit subset**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/subagent-*.test.ts \
  src/app/components/session/workspace-session-list*.test.ts
```

Expected: PASS.

**Step 2: Run typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 3: Commit verification note**

```bash
git commit --allow-empty -m "chore: verify subagent decorations test and typecheck suite"
```

### Task 12: Required E2E gate (Docker + Chrome MCP + screenshots)

**Files:**
- Create: `evidence/2026-03-30-subagent-decorations/` (screenshots)
- Modify: `evidence/2026-03-30-subagent-decorations/README.md` (steps + observed behavior)

**Step 1: Start dev stack via Docker**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: printed Web UI URL, token path, and stop command.

**Step 2: Run desktop app (for native verification)**

Run:

```bash
pnpm --filter @neatech/veslo dev
```

Expected: Tauri desktop launches.

**Step 3: Verify real flow via Chrome MCP**

Minimum flow:
- open printed Web UI URL,
- create/open parent session,
- trigger two same-role subagents (e.g. excel twice),
- verify labels `Name`, `Name #2`, different colors, nested under parent,
- switch app language (`cs`/`en`) and verify localized first names.

Expected: full user flow succeeds.

**Step 4: Capture screenshots in repo**

Save at least:
- `evidence/2026-03-30-subagent-decorations/01-parent-collapsed.png`
- `evidence/2026-03-30-subagent-decorations/02-parent-expanded.png`
- `evidence/2026-03-30-subagent-decorations/03-duplicate-role-suffix-and-color.png`
- `evidence/2026-03-30-subagent-decorations/04-locale-cs.png`
- `evidence/2026-03-30-subagent-decorations/05-locale-en.png`

**Step 5: Stop stack with printed compose command**

Expected: containers stopped cleanly.

**Step 6: Commit evidence**

```bash
git add evidence/2026-03-30-subagent-decorations
git commit -m "test: add e2e evidence for locale-aware subagent decorations"
```

### Task 13: Final branch status and reviewer handoff note

**Files:**
- Modify: `docs/plans/2026-03-30-subagent-decorations-locale-aware-implementation-plan.md` (mark done checklist)

**Step 1: Record executed commands and results**

Add a final section with:
- exact commands run,
- pass/fail status,
- any deviations.

**Step 2: Verify git status clean**

Run:

```bash
git status --short
```

Expected: no uncommitted tracked changes.

**Step 3: Commit plan execution notes**

```bash
git add docs/plans/2026-03-30-subagent-decorations-locale-aware-implementation-plan.md
git commit -m "docs: record verification checklist for subagent decorations"
```

