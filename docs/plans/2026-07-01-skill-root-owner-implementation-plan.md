---
title: Skill Root Owner Implementation Plan
date: 2026-07-01
status: implemented
done: true
---

# Skill Root Owner Implementation Plan

## Goal

Create one narrow server-side owner for skill filesystem root contracts so
materialization, listing, mutation, deletion, and restore code stop duplicating
slightly different path rules.

The immediate bug class is:

```text
write-side root != read-side root
```

The concrete regression already found was that personal-global managed skills
could be materialized under `XDG_CONFIG_HOME/opencode/skills/veslo-managed`
while `listSkills(... includeGlobal)` only read `$HOME/.config/opencode/skills`.
That made core platform skills such as `veslo-docx` exist on disk but disappear
from server/app inventory in XDG-based environments.

## KISS Boundary

This plan creates a path-contract owner only. It must not become a broad skills
controller.

Move only root/path helpers and direct callers:

- workspace skill roots
- user-global skill roots
- managed skill roots
- skill root mutation/read/delete allow-lists
- small path predicates that are purely about owned root boundaries

Do not move:

- registry client behavior
- package downloading
- package validation
- materialization manifest logic
- disabled/enabled policy logic
- app inventory UI state
- OpenCode runtime start behavior
- Tauri/Rust skill implementation

## Existing State

Current root ownership is split:

- `packages/server/src/workspace-files.ts`
  - owns `projectSkillsDir(workspaceRoot)`.
- `packages/server/src/skill-materializer.ts`
  - owns `workspaceManagedSkillsRoot(workspaceRoot)`.
  - owns `personalGlobalManagedSkillsRoot(globalSkillsRoot?)`.
- `packages/server/src/skills.ts`
  - owns local `userHomeDir()` and `userConfigHomeDir()`.
  - owns `workspaceSkillRootsForMutation(workspaceRoot)`.
  - owns `userGlobalSkillRootsForMutation()`.
  - uses its own global listing root composition.
- `packages/server/src/user-skill-store.ts`
  - imports `SKILL_ENTRYPOINT` and `workspaceSkillRootsForMutation()` from
    `skills.ts`.
  - owns `userGlobalMaterializedSkillsRoot(workspaceRoot)` for the
    workspace-local `veslo-user` category.
- `packages/server/src/skill-removal-journal.ts`
  - validates restore against roots passed by callers.
- `packages/desktop/src-tauri/src/commands/skills.rs`
  - has separate desktop-side root discovery and should be audited later, not
    folded into the server refactor.

## Target Shape

Add:

```text
packages/server/src/skill-roots.ts
```

The module should own:

```ts
export const SKILL_ENTRYPOINT = "SKILL.md";
export const VESLO_MANAGED_SKILL_CATEGORY = "veslo-managed";

export function userHomeDir(): string;
export function userConfigHomeDir(): string;
export function workspaceSkillsRoot(workspaceRoot: string): string;
export function workspaceSkillRootsForMutation(workspaceRoot: string): Promise<string[]>;
export function userGlobalSkillRoots(): string[];
export function userGlobalSkillRootsForMutation(): string[];
export function workspaceManagedSkillsRoot(workspaceRoot: string): string;
export function personalGlobalManagedSkillsRoot(globalSkillsRoot?: string): string;
export function isVesloManagedSkillRelativePath(relativeToRoot: string): boolean;
```

Naming can be adjusted during implementation if nearby code suggests clearer
repo-local names. Keep the module focused on path contracts.

`projectSkillsDir(workspaceRoot)` should stay in `workspace-files.ts`. The new
owner may call it or re-export a narrower skill-root helper, but this plan should
not absorb general workspace file helpers.

## Implementation Steps

### Step 1: Add Owner Tests First

Add:

```text
packages/server/src/tests/skill-roots.test.ts
```

Cover:

- user-global roots include `XDG_CONFIG_HOME/opencode/skills` before
  `$HOME/.config/opencode/skills`.
- user-global roots fall back to `USERPROFILE/.config/opencode/skills` on
  Windows-style environments when `HOME` is absent.
- duplicate user-global roots are de-duped.
- `personalGlobalManagedSkillsRoot()` uses the same first user-global OpenCode
  root as listing and mutation.
- `workspaceManagedSkillsRoot(workspaceRoot)` resolves under
  `.opencode/skills/veslo-managed`.
- `workspaceSkillRootsForMutation()` includes `.opencode/skills` and
  `.claude/skills` for the workspace root chain.
- managed path predicate treats `veslo-managed/<name>/SKILL.md` and nested
  managed paths as managed.
- follow-up hardening also covers empty/whitespace env values, explicit managed
  root override trimming, mutation roots matching listing roots, `findWorkspaceRoots`
  chain output, path-inside sibling-prefix escapes, and negative
  `veslo-managed-*` predicate cases.

Expected first run: tests may fail because the module does not exist.

Focused command:

```bash
pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts
```

### Step 2: Create `skill-roots.ts`

Move or reimplement only the existing path helpers:

- `userHomeDir`
- `userConfigHomeDir`
- `workspaceManagedSkillsRoot`
- `personalGlobalManagedSkillsRoot`
- `workspaceSkillRootsForMutation`
- `userGlobalSkillRootsForMutation`

Prefer moving existing logic over inventing new semantics.

Important contract:

```text
personalGlobalManagedSkillsRoot() must be derived from userGlobalSkillRoots()[0].
```

This makes write-side and read-side roots share one source of truth.

### Step 3: Retarget Existing Server Callers

Update imports and call sites in:

- `packages/server/src/skills.ts`
- `packages/server/src/skill-materializer.ts`
- `packages/server/src/server.ts`
- `packages/server/src/routes/skill-materialization.ts`
- `packages/server/src/routes/skill-removals.ts`
- `packages/server/src/user-skill-store.ts`
- any route file currently importing root helpers from `skills.ts` or
  `skill-materializer.ts`

Keep compatibility exports if needed to minimize blast radius, but prefer
importing root helpers from `skill-roots.ts` in newly touched code.

Do not retarget unrelated helpers from `workspace-files.ts` unless needed.

`SKILL_ENTRYPOINT` should also move to `skill-roots.ts`, and package/store/
materializer modules should import it from there. Avoid keeping new imports from
the broad `skills.ts` module just to access the entrypoint constant.

### Step 4: Preserve Existing Behavior Tests

Keep the regression tests added for the original bug:

- `packages/server/src/tests/skills.test.ts`
  - XDG materialized `veslo-docx` is discoverable through
    `listSkills(... includeGlobal)`.
- `packages/server/src/tests/skill-resolver.test.ts`
  - `MS Word` wording resolves to `veslo-docx`.

These are behavior tests, not source-placement tests.

### Step 5: Run Focused Verification

Run:

```bash
pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts src/tests/skills.test.ts src/tests/skill-materializer.test.ts src/tests/skill-resolver.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.skill-materialization.test.ts src/tests/server.skill-materialization-routes.test.ts src/tests/server.workspace-skills-routes.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/extensions-skill-inventory.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-inventory.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Optional but valuable if desktop artifacts are available:

```bash
pnpm --filter @neatech/veslo-e2e test:pilot:core-platform-skills
```

If the pilot E2E leaves Windows runtime temp directories locked, clean only
verified E2E-owned PIDs and temp roots.

## Acceptance Criteria

- One server module owns skill root path contracts.
- `listSkills`, mutation helpers, materialization helpers, and restore routes
  use the same user-global root source.
- XDG and HOME fallback behavior are covered by focused tests.
- USERPROFILE fallback behavior is covered so Windows user-global skills keep a
  defined root when HOME is absent.
- `veslo-docx` remains discoverable and resolvable from MS Word wording.
- Core platform skills still materialize without legacy internal delegation
  artifacts.
- No registry, package, app UI, or OpenCode runtime behavior is refactored.

## Progress Log

### 2026-07-01 Implementation Complete

Implemented `packages/server/src/skill-roots.ts` and retargeted server-side
skill listing, mutation, materialization, restore, user-skill store, package
entrypoint validation, skill hub install path, and route/server callers to use
the shared root owner.

Verification:

- `pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts src/tests/skills.test.ts src/tests/skill-materializer.test.ts src/tests/skill-resolver.test.ts`
  - Passed: 27 tests.
- `pnpm --filter veslo-server exec bun test src/tests/server.skill-materialization.test.ts src/tests/server.skill-materialization-routes.test.ts src/tests/server.workspace-skills-routes.test.ts src/tests/skill-removal-journal.test.ts`
  - Passed: 43 tests.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/extensions-skill-inventory.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-inventory.test.ts`
  - Passed: 119 tests.
- `pnpm --filter veslo-server typecheck`
  - Passed.
- `git diff --check`
  - Passed with only LF/CRLF working-copy warnings.
- `pnpm --filter @neatech/veslo-e2e test:pilot:core-platform-skills`
  - Attempted twice. First run hit a UI navigation timeout waiting for
    `[data-testid="skills-page"]`; second run hit the command timeout.
  - Direct post-run filesystem verification confirmed core platform skills were
    materialized under the XDG OpenCode root with `personal-global`,
    `platform`, and `locked` marker metadata, and without legacy internal
    routing artifacts.

### 2026-07-01 Robustness Follow-Up

Added additional `skill-roots.test.ts` boundary coverage for whitespace env
fallbacks, explicit managed root override trimming, listing/mutation root
equivalence, workspace root chain output, sibling-prefix path escapes, and
negative managed-path predicate cases.

Verification:

- `pnpm --filter veslo-server exec bun test src/tests/skill-roots.test.ts`
  - Passed: 7 tests, 29 assertions.
- Explicit PowerShell-expanded run of all server `*skill*.test.ts` files:
  `pnpm --filter veslo-server exec bun test @files`
  - Passed: 182 tests, 697 assertions.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/extensions-skill-inventory.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/skill-inventory.test.ts`
  - Passed: 119 tests.
- `pnpm --filter veslo-server typecheck`
  - Passed.

## Follow-Up Audit

After the server owner lands, audit but do not automatically refactor:

- `packages/desktop/src-tauri/src/commands/skills.rs`
- `packages/desktop/src-tauri/src/paths.rs`
- `packages/desktop/src-tauri/src/engine/spawn.rs`

The follow-up question: does desktop-side skill discovery use the same root
contract and pass `HOME`/`XDG_CONFIG_HOME` consistently to OpenCode?

Keep that as a separate change unless a direct breakage is found during this
plan's verification.
