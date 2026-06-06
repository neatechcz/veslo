# Global Automations Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Automations page show and fully manage automations from all Veslo workspaces, including inactive workspaces.

**Architecture:** Use app-side aggregation, matching Skills and Soul. The app maps configured workspaces to Veslo server workspace ids, fans out existing workspace-scoped automation API calls, and stores each automation with its owning workspace context. Mutations remain workspace-scoped and must use the automation's own workspace id.

**Tech Stack:** SolidJS app state and UI, Veslo server client wrapper, existing workspace-scoped automation API, Node source tests, Bun server tests where needed, Tauri desktop WebdriverIO E2E.

---

### Task 1: Add Workspace-Aware Automation Types

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/pages/scheduled.tsx`
- Test: `packages/app/src/app/pages/scheduled-automations.test.ts`

**Step 1: Write the failing test**

Add assertions that `ScheduledTasksView` consumes workspace-aware automation items and does not accept a bare `VesloAutomation[]` as the primary list.

```ts
test("ScheduledTasksView uses workspace-aware automation items", () => {
  const source = scheduledSource();
  assert.match(source, /automationItems:\s*WorkspaceAutomationItem\[\]/);
  assert.match(source, /workspace:\s*AutomationWorkspaceSummary/);
  assert.doesNotMatch(source, /automations:\s*VesloAutomation\[\]/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: FAIL because the page still accepts `automations: VesloAutomation[]`.

**Step 3: Add minimal types**

Add app-facing types similar to:

```ts
export type AutomationWorkspaceSummary = {
  appWorkspaceId: string;
  serverWorkspaceId: string | null;
  name: string;
  path?: string | null;
  workspaceType: "local" | "remote";
  status: "ready" | "unavailable" | "error";
  error?: string | null;
};

export type WorkspaceAutomationItem = {
  key: string;
  workspace: AutomationWorkspaceSummary;
  automation: VesloAutomation;
  runs: VesloAutomationRun[];
};
```

Use these in `ScheduledTasksViewProps`.

**Step 4: Run test to verify it passes**

Run the same command. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/pages/scheduled.tsx packages/app/src/app/pages/scheduled-automations.test.ts
git commit -m "test: define workspace-aware automation items"
```

### Task 2: Aggregate Automations Across Workspaces In App State

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/pages/scheduled-automations.test.ts`
- Test: `packages/app/src/app/app-local-veslo-server-ensure.test.ts` if workspace mapping helpers move or change

**Step 1: Write the failing test**

Add a source-level test that `App` resolves multiple workspaces and calls `listAutomations` per mapped workspace instead of only using `vesloServerWorkspaceId()`.

```ts
test("App refreshes automations for all mapped workspaces", () => {
  const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.match(source, /resolveAutomationWorkspaceMap/);
  assert.match(source, /Promise\.all\([\s\S]*listAutomations/);
  assert.doesNotMatch(source, /const automationClient = resolveVesloAutomations\(\);[\s\S]*listAutomations\(automationClient\.workspaceId\)/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: FAIL because app refresh is still active-workspace scoped.

**Step 3: Implement aggregation**

In `App`, replace the single `automations` signal with aggregate signals:

- `automationItems`
- `automationWorkspaces`
- `automationWorkspaceErrors`
- `automationRunsByKey`

Add `resolveAutomationWorkspaceMap()` based on the Soul mapping pattern:

- call `vesloServerClient().listWorkspaces()`
- compare app workspaces by local path, directory, and `opencode.directory`
- include every app workspace in workspace summary output
- mark unmapped workspaces as unavailable

`refreshScheduledJobs()` should:

- no-op only when already busy unless forced
- clear global status without clearing successful prior workspace data prematurely
- fan out `listAutomations(serverWorkspaceId)` for ready workspaces
- load runs per automation with `listAutomationRuns`
- keep per-workspace errors separate
- set `scheduledJobsUpdatedAt`

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/scheduled-automations.test.ts
git commit -m "feat: aggregate automations across workspaces"
```

### Task 3: Make Automation Mutations Workspace-Scoped

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/scheduled.tsx`
- Test: `packages/app/src/app/pages/scheduled-automations.test.ts`

**Step 1: Write the failing test**

Assert that create, update, delete, and run handlers include workspace context.

```ts
test("ScheduledTasksView mutation handlers include workspace context", () => {
  const source = scheduledSource();
  assert.match(source, /createAutomation:\s*\(workspaceId:\s*string,/);
  assert.match(source, /updateAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string,/);
  assert.match(source, /deleteAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string/);
  assert.match(source, /runAutomation:\s*\(workspaceId:\s*string,\s*automationId:\s*string/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: FAIL because handlers currently use the active workspace implicitly.

**Step 3: Implement workspace-scoped handlers**

Update handler signatures:

- create requires selected target workspace id
- update uses selected automation item workspace id
- delete uses selected automation item workspace id
- run uses selected automation item workspace id

After a mutation:

- update only the affected workspace/item in local aggregate state when possible
- refresh that workspace's automation list if the mutation changes schedule/status in a complex way
- never fall back to the active workspace for an existing automation

**Step 4: Run test to verify it passes**

Run the same command. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/scheduled.tsx packages/app/src/app/pages/scheduled-automations.test.ts
git commit -m "feat: scope automation mutations to owning workspace"
```

### Task 4: Add Full Edit UI

**Files:**
- Modify: `packages/app/src/app/pages/scheduled.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts` if this locale is active in parity checks
- Test: `packages/app/src/app/pages/scheduled-automations.test.ts`

**Step 1: Write the failing test**

Assert that the page has an edit modal and calls `updateAutomation`.

```ts
test("ScheduledTasksView exposes full automation editing", () => {
  const source = scheduledSource();
  assert.match(source, /editTarget/);
  assert.match(source, /handleUpdateAutomation/);
  assert.match(source, /props\.updateAutomation/);
  assert.match(source, /scheduled\.edit_title/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: FAIL because only create/run/delete are available.

**Step 3: Implement edit modal**

Reuse the create modal form fields for edit mode where practical.

Support editing:

- name
- prompt
- schedule
- target fallback title
- target preferred session id
- target agent
- target model
- target variant
- enabled/status controls for pause/resume/cancel/reactivate

Use the existing schedule builder. For reactivation, send explicit `status:
"active"` and a valid future or recurring schedule.

**Step 4: Add copy**

Add localized strings for:

- edit title
- edit description
- save changes
- pause/resume labels
- workspace selector
- unavailable workspace explanations
- mutation error labels

Run:

```bash
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 5: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/scheduled.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/scheduled-automations.test.ts
git commit -m "feat: add full automation editing UI"
```

### Task 5: Update Page Layout For App-Wide Management

**Files:**
- Modify: `packages/app/src/app/pages/scheduled.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/src/app/pages/scheduled-automations.test.ts`

**Step 1: Write the failing test**

Assert visible workspace filtering/grouping exists.

```ts
test("ScheduledTasksView provides workspace-aware filtering", () => {
  const source = scheduledSource();
  assert.match(source, /workspaceFilter/);
  assert.match(source, /scheduled\.all_workspaces/);
  assert.match(source, /item\.workspace\.name/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
```

Expected: FAIL.

**Step 3: Implement layout**

Add:

- all-workspaces header copy
- workspace filter
- status filter over aggregate items
- optional search over automation name, prompt, workspace name, and path
- workspace name/path on every automation card
- workspace diagnostics for unmapped or failed workspaces

Follow the approved Pencil direction, `Global Automations App Visual Design
CZ`. Keep the app's existing visual system: IBM Plex Sans, Radix gray surfaces,
subtle borders, existing `Button` variants, and rounded automation cards
consistent with the current scheduled page. Do not convert the page into a dark
sidebar admin dashboard or a hard-edged data table. Do not create a
marketing-style landing section.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/scheduled.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/scheduled-automations.test.ts
git commit -m "feat: show automations across workspaces"
```

### Task 6: Update Documentation

**Files:**
- Modify: `docs/features/soul-and-automations.md`
- Modify: `docs/dev/veslo-server-app-contract.md` only if client assumptions need clarification

**Step 1: Update feature docs**

Document that:

- Automations UI is app-wide
- aggregation happens in app-side state
- server routes remain workspace-scoped
- inactive workspace automations can be edited through their owning workspace id
- unavailable workspaces are shown with diagnostics

**Step 2: Run docs sanity check**

Run:

```bash
git diff --check
```

Expected: PASS.

**Step 3: Commit**

```bash
git add docs/features/soul-and-automations.md docs/dev/veslo-server-app-contract.md
git commit -m "docs: document app-wide automations management"
```

### Task 7: Desktop E2E Verification

**Files:**
- Modify: `packages/e2e/specs/veslo-automations.e2e.ts`
- Possibly modify: `packages/e2e/helpers/app-launcher.ts`

**Step 1: Extend E2E**

Add a focused E2E path that:

1. Starts the real Tauri desktop runtime.
2. Creates or seeds two workspaces.
3. Creates one automation in each workspace.
4. Opens the Automations page.
5. Verifies both automations are visible at the same time.
6. Switches the active workspace.
7. Edits the automation that belongs to the now-inactive workspace.
8. Verifies the server persisted the edit under the correct workspace id.

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Stop only internally started Veslo dev/test processes from this repo, then verify the post-check is empty.

**Step 3: Build desktop E2E binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: PASS. The build should rebuild the bundled `veslo-server` sidecar through `prepare-sidecar`.

**Step 4: Run focused E2E**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/veslo-automations.e2e.ts
```

Expected: PASS with both app-wide visibility and inactive-workspace edit covered.

**Step 5: Commit**

```bash
git add packages/e2e/specs/veslo-automations.e2e.ts packages/e2e/helpers/app-launcher.ts
git commit -m "test: verify app-wide automations desktop flow"
```

### Task 8: Final Verification

**Files:**
- No edits unless a verification failure reveals a real bug.

**Step 1: Run focused app tests**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/scheduled-automations.test.ts src/app/app-local-veslo-server-ensure.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 2: Run server-side safety tests if client/server contracts changed**

```bash
pnpm --filter veslo-server exec bun test src/server.automations.test.ts src/automation-store.test.ts src/automation-runner.test.ts
pnpm --filter veslo-server typecheck
```

Expected: PASS.

**Step 3: Rebuild server binary**

Run this if `packages/server/src` changed:

```bash
pnpm --filter veslo-server build:bin
```

Expected: PASS.

**Step 4: Run desktop E2E**

Use the commands from Task 7.

Expected: PASS.

**Step 5: Final commit if needed**

If verification fixes were required:

```bash
git add <changed-files>
git commit -m "fix: stabilize app-wide automations"
```
