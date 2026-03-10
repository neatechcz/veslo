# Sidebar Project Grouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add compact `By project` / `Recent` sidebar browsing, project-level session creation, and project-grouped session rendering in the Veslo left rail.

**Architecture:** Keep the sidebar data source in `packages/app/src/app/app.tsx` and derive both grouped and recent views inside `packages/app/src/app/components/session/workspace-session-list.tsx`. Reuse existing session-creation flows, add a persisted sidebar-mode preference, and replace the current flat-only sidebar assertions with checks that match the new grouped-plus-recent behavior.

**Tech Stack:** SolidJS, TypeScript, existing sidebar script checks under `packages/app/scripts`, pnpm

---

### Task 1: Replace the flat-only sidebar assertion with view-mode checks

**Files:**
- Modify: `packages/app/scripts/sidebar-flat-sessions.mjs`
- Test: `packages/app/scripts/sidebar-flat-sessions.mjs`

**Step 1: Write the failing test expectations**

Update the script so it stops asserting that the sidebar must always flatten `workspaceSessionGroups`. Assert the new expected markers instead:
- the component defines a persisted sidebar mode
- the component still supports a recent flat feed
- the component renders project-scoped create actions
- the component no longer renders per-session `+` controls

**Step 2: Run the script to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: FAIL because the current component still matches the old flat-only structure.

**Step 3: Keep the script narrow**

Only assert for durable structural markers that will survive class-name changes. Do not assert on cosmetic strings unless the behavior depends on them.

**Step 4: Re-run the script after the implementation work**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS with JSON output from the updated script.

**Step 5: Commit**

```bash
git add packages/app/scripts/sidebar-flat-sessions.mjs
git commit -m "test: update sidebar grouping assertions"
```

### Task 2: Add sidebar view-mode helpers and project label derivation

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write the failing type-level shape**

Add any small type aliases needed for sidebar mode and grouped/recent row derivation before writing the rendering changes.

**Step 2: Implement helper functions**

Add helpers for:
- `by-project | recent` mode
- project basename derivation from local `path` or remote `directory`
- empty-directory handling
- latest-activity sorting for project groups
- flattening grouped data into recent rows

**Step 3: Keep worker creation behavior intact**

Do not invent a new create-session path. Continue routing project `+` clicks through the existing page callback.

**Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/types.ts
git commit -m "refactor: add sidebar project grouping model"
```

### Task 3: Rebuild the sidebar UI for `By project` and `Recent`

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`

**Step 1: Add the compact mode toggle**

Render a compact icon toggle near the top of the sidebar list:
- folder icon with `aria-label="By project"`
- list icon with `aria-label="Recent"`
- default selected state is `by-project`

**Step 2: Implement `By project` rendering**

Render:
- project headers with muted basename label and small folder icon
- always-visible project-level `+`
- indented session rows beneath each header
- extra vertical spacing between project groups
- hidden empty projects

**Step 3: Implement `Recent` rendering**

Render:
- one flat feed sorted by newest session creation time
- muted secondary project basename on each row
- no project-level grouping chrome

**Step 4: Remove per-session `+`**

Delete the current row-level create button in both modes and keep only the project-level create button plus the global top button.

**Step 5: Run targeted checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:sidebar-flat
pnpm typecheck
```

Expected: both PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx
git commit -m "feat: add by-project sidebar sessions"
```

### Task 4: Preserve page wiring and create-session behavior

**Files:**
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`

**Step 1: Verify callback semantics**

Keep:
- the top `New session` button wired to the existing global create flow
- the project `+` wired to `createTaskInWorkspace(workspaceId)`

**Step 2: Adjust props only if needed**

If the sidebar component needs renamed props or small helper props, keep the page-level changes minimal and avoid moving data-fetch logic out of existing owners.

**Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx
git commit -m "refactor: keep sidebar project actions wired"
```

### Task 5: Verify behavior and capture evidence

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/scripts/sidebar-flat-sessions.mjs`

**Step 1: Run the required verification commands**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:sidebar-flat
```

Expected: PASS.

**Step 2: Attempt the end-to-end UI gate**

From the repo root, run:

```bash
packaging/docker/dev-up.sh
```

Then test the feature using the Chrome MCP flow described in:

```text
.opencode/skills/openwork-docker-chrome-mcp/SKILL.md
```

Capture screenshots in the repo if the environment is available.

**Step 3: If Docker or Chrome MCP is unavailable**

Record:
- which step could not run
- why it could not run
- which local checks were run instead

**Step 4: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/scripts/sidebar-flat-sessions.mjs
git commit -m "test: verify sidebar project grouping"
```
