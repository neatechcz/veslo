# Sidebar Add Directory Session Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a right-aligned left-sidebar icon that opens the native directory picker, reuses an existing local worker when the selected directory is already present, and immediately opens a new session in that directory from both Session and Dashboard.

**Architecture:** Keep the picker + workspace/session orchestration out of the presentational sidebar component. Reuse the existing workspace store (`pickWorkspaceFolder`, `ensureWorkspaceForFolder`) and the existing single-flight session creation helper (`createSessionWithWorkspaceActivation`) by wrapping them in a small pure helper that can be unit tested. Then wire that callback through Session and Dashboard into `WorkspaceSessionList`, where the top action row is split into a left view-toggle cluster and a right action cluster containing search plus the new directory icon.

**Tech Stack:** SolidJS, TypeScript, lucide-solid, Tailwind utility classes, Veslo i18n locale tables, Node test runner (`node --test` via `tsx/esm`), pnpm, Tauri desktop shell

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Do implementation in a dedicated worktree. The current workspace already has unrelated dirty changes.
- Do not run `packages/web`; manual verification must use the Tauri desktop app.
- Use `@openwork-docker-chrome-mcp` (see `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`) for the end-to-end UI gate.

### Task 1: Create worktree and capture a clean baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync repository state**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: both commands complete without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/sidebar-add-directory-session -b codex/sidebar-add-directory-session origin/main
cd .worktrees/codex/sidebar-add-directory-session
```

Expected: the new worktree is created on branch `codex/sidebar-add-directory-session`.

**Step 3: Verify targeted baseline health**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: PASS before feature edits.

### Task 2: Add failing tests for picker-driven directory session orchestration

**Files:**
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Test: `packages/app/src/app/pages/session-navigation.test.ts`

**Step 1: Add failing tests for cancel, existing-worker reuse, and new-worker creation**

Extend `session-navigation.test.ts` with a new helper contract, for example:

```ts
const result = await createSessionFromDirectorySelection({
  activeWorkspaceId: "ws-active",
  getActiveWorkspaceId: () => currentActive,
  pickDirectory: async () => "/tmp/project-a",
  ensureWorkspaceForFolder: async (folder) => ({ id: "ws-project", path: folder }),
  activateWorkspace: async (id) => {
    activated.push(id);
    currentActive = id;
    return true;
  },
  createSession: async () => "sess-new",
});

assert.equal(result, "created");
assert.deepEqual(activated, ["ws-project"]);
assert.deepEqual(created, ["sess-new"]);
```

Add at least these scenarios:
- picker cancel returns `"cancelled"`
- existing workspace path activates/reuses existing worker and creates a session
- new workspace path also flows through to activation + session creation
- activation failure returns `"blocked"` and does not create a session

**Step 2: Run the targeted test to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts
```

Expected: FAIL because `createSessionFromDirectorySelection` and its input/result types do not exist yet.

**Step 3: Commit the failing test**

```bash
git add packages/app/src/app/pages/session-navigation.test.ts
git commit -m "test: cover picker-driven directory session flow"
```

### Task 3: Implement the picker-driven orchestration helper

**Files:**
- Modify: `packages/app/src/app/pages/session-navigation.ts:1-89`
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Test: `packages/app/src/app/pages/session-navigation.test.ts`

**Step 1: Add a new input/result contract**

Implement something along these lines in `session-navigation.ts`:

```ts
export type CreateSessionFromDirectorySelectionInput = {
  activeWorkspaceId: string;
  getActiveWorkspaceId?: () => string;
  pickDirectory: () => Promise<string | null> | string | null;
  ensureWorkspaceForFolder: (folder: string) => Promise<{ id: string } | null> | { id: string } | null;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  createSession: () => Promise<string | undefined> | string | undefined | void;
};

export type CreateSessionFromDirectorySelectionResult = "cancelled" | "blocked" | "created";
```

**Step 2: Implement the helper as a thin orchestrator**

Implementation requirements:
- call `pickDirectory()` first
- return `"cancelled"` on empty selection
- call `ensureWorkspaceForFolder(selectedFolder)`
- return `"blocked"` if no workspace ID is produced
- delegate activation + session creation to `createSessionWithWorkspaceActivation(...)`
- return `"created"` only when the delegated flow succeeds
- do not duplicate path normalization or workspace dedup logic here

Skeleton:

```ts
export async function createSessionFromDirectorySelection(
  input: CreateSessionFromDirectorySelectionInput,
): Promise<CreateSessionFromDirectorySelectionResult> {
  const selected = await Promise.resolve(input.pickDirectory());
  if (!selected?.trim()) return "cancelled";

  const workspace = await Promise.resolve(input.ensureWorkspaceForFolder(selected));
  const workspaceId = workspace?.id?.trim() ?? "";
  if (!workspaceId) return "blocked";

  const created = await createSessionWithWorkspaceActivation({
    activeWorkspaceId: input.activeWorkspaceId,
    getActiveWorkspaceId: input.getActiveWorkspaceId,
    workspaceId,
    activateWorkspace: input.activateWorkspace,
    createSession: input.createSession,
  });

  return created ? "created" : "blocked";
}
```

**Step 3: Run the targeted test again**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts
```

Expected: PASS.

**Step 4: Commit the helper**

```bash
git add packages/app/src/app/pages/session-navigation.ts packages/app/src/app/pages/session-navigation.test.ts
git commit -m "feat: add picker-driven directory session helper"
```

### Task 4: Add failing source-contract tests for page wiring and sidebar action layout

**Files:**
- Create: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Add a new source-contract test for Session/Dashboard wiring**

Create `sidebar-directory-session-wiring.test.ts` that reads the page sources and asserts:
- `SessionViewProps` includes `openDirectorySessionFromPicker`
- `DashboardViewProps` includes `openDirectorySessionFromPicker`
- both pages pass `onAddDirectorySession={props.openDirectorySessionFromPicker}` into `WorkspaceSessionList`

Example assertion style:

```ts
assert.match(sessionSource, /openDirectorySessionFromPicker: \(\) => void;/);
assert.match(sessionSource, /onAddDirectorySession=\{props\.openDirectorySessionFromPicker\}/);
```

**Step 2: Extend the sidebar layout source test**

Update `workspace-session-list-layout.test.ts` to assert:
- the top action row uses a right-aligned action cluster (`ml-auto` or equivalent)
- `FolderPlus` is imported/used
- the new button reads `props.onAddDirectorySession`

Example:

```ts
assert.match(source, /<div class="mb-3 flex items-center gap-2">[\s\S]*<div class="ml-auto flex items-center gap-2">/);
assert.match(source, /FolderPlus/);
assert.match(source, /onAddDirectorySession/);
```

**Step 3: Run the targeted tests to confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/sidebar-directory-session-wiring.test.ts src/app/components/session/workspace-session-list-layout.test.ts
```

Expected: FAIL because the new prop, layout, and icon do not exist yet.

**Step 4: Commit the failing source-contract tests**

```bash
git add packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts packages/app/src/app/components/session/workspace-session-list-layout.test.ts
git commit -m "test: specify sidebar directory session wiring"
```

### Task 5: Wire the new picker flow through App, Session, and Dashboard

**Files:**
- Modify: `packages/app/src/app/app.tsx:5003-5013`
- Modify: `packages/app/src/app/app.tsx:6493-6576`
- Modify: `packages/app/src/app/pages/session.tsx:119-140`
- Modify: `packages/app/src/app/pages/session.tsx:3346-3355`
- Modify: `packages/app/src/app/pages/session.tsx:3610-3637`
- Modify: `packages/app/src/app/pages/dashboard.tsx:80-90`
- Modify: `packages/app/src/app/pages/dashboard.tsx:445-454`
- Modify: `packages/app/src/app/pages/dashboard.tsx:1188-1205`
- Test: `packages/app/src/app/pages/session-navigation.test.ts`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`

**Step 1: Add an app-level action next to `openNewSessionWithDirectory`**

In `app.tsx`, add:

```ts
const openDirectorySessionFromPicker = async () => {
  return await createSessionFromDirectorySelection({
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    getActiveWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    pickDirectory: () => workspaceStore.pickWorkspaceFolder(),
    ensureWorkspaceForFolder: workspaceStore.ensureWorkspaceForFolder,
    activateWorkspace: workspaceStore.activateWorkspace,
    createSession: () => createSessionAndOpen(),
  });
};
```

Requirements:
- do not touch `openNewSessionWithDirectory()`
- do not inject sidebar state management here
- let existing workspace/session flows own activation and routing

**Step 2: Thread the new callback through both page prop shapes**

Add `openDirectorySessionFromPicker: () => void;` to:
- `SessionViewProps`
- `DashboardViewProps`

Pass it from `app.tsx` into both page prop objects.

**Step 3: Pass the callback into `WorkspaceSessionList`**

In both `session.tsx` and `dashboard.tsx`, wire:

```tsx
<WorkspaceSessionList
  ...
  onAddDirectorySession={props.openDirectorySessionFromPicker}
/>
```

**Step 4: Run the targeted wiring tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-navigation.test.ts src/app/pages/sidebar-directory-session-wiring.test.ts
```

Expected: PASS.

**Step 5: Commit the wiring**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session-navigation.ts packages/app/src/app/pages/session-navigation.test.ts packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts
git commit -m "feat: wire picker-based directory sessions"
```

### Task 6: Implement the right-aligned sidebar action cluster and i18n labels

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx:1-53`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx:317-414`
- Modify: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/components/session/workspace-session-list-layout.test.ts`

**Step 1: Extend the sidebar props and import the new icon**

In `workspace-session-list.tsx`:
- add `FolderPlus` to the lucide import
- add `onAddDirectorySession?: () => void` to `Props`

**Step 2: Split the action row into left and right clusters**

Refactor the current top row to this shape:

```tsx
<div class="mb-3 flex items-center gap-2">
  <div class="inline-flex items-center gap-1 rounded-full ...">
    {/* by-project / recent toggle */}
  </div>

  <div class="ml-auto flex items-center gap-2">
    <Show when={props.onOpenSessionSearch}>
      <button ...>
        <Search size={14} />
      </button>
    </Show>

    <Show when={props.onAddDirectorySession}>
      <button
        type="button"
        class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-6 bg-gray-1 text-gray-9 shadow-sm transition-colors hover:bg-gray-3 hover:text-gray-11 disabled:opacity-60 disabled:cursor-not-allowed"
        aria-label={tr("sidebar.add_directory_session")}
        title={tr("sidebar.add_directory_session")}
        disabled={props.newTaskDisabled}
        onClick={() => props.onAddDirectorySession?.()}
      >
        <FolderPlus size={14} />
      </button>
    </Show>
  </div>
</div>
```

Requirements:
- keep search in the same right-aligned cluster when present
- keep Dashboard aligned correctly when search is absent
- do not restyle the primary `New session` button above this row

**Step 3: Add locale entries for the new action**

Add `sidebar.add_directory_session` to:
- `packages/app/src/i18n/locales/en.ts`
- `packages/app/src/i18n/locales/cs.ts`
- `packages/app/src/i18n/locales/zh.ts`

Suggested English copy:

```ts
"sidebar.add_directory_session": "Add directory and open session"
```

Use matching, concise localized text in Czech and Chinese.

**Step 4: Run focused UI and locale verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/workspace-session-list-layout.test.ts src/app/pages/sidebar-directory-session-wiring.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit the UI implementation**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/workspace-session-list-layout.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add sidebar directory session action"
```

### Task 7: Run the full verification gate and capture evidence

**Files:**
- Create: `evidence/2026-03-28-sidebar-add-directory-session/`
- Modify: none unless you store screenshots in the repo

**Step 1: Run broader local verification**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 2: Start the Veslo Docker dev stack from the repo root**

Run:

```bash
packaging/docker/dev-up.sh
```

Expected: the dev services come up cleanly and stay healthy.

**Step 3: Launch the Tauri desktop app**

Run:

```bash
pnpm --filter @neatech/veslo exec tauri dev
```

Expected: the desktop app launches; do not replace this with `next dev` or any web-only server.

**Step 4: Execute the manual UI flow with Chrome MCP**

Use `@openwork-docker-chrome-mcp` / `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md` to verify:
- `Session` view: existing directory -> no duplicate worker, new session opens in existing worker
- `Session` view: new directory -> worker is added, new session opens there
- `Dashboard` view: same two flows behave identically
- picker cancel -> no worker/session change

**Step 5: Save screenshots into the repo**

Create:

```bash
mkdir -p evidence/2026-03-28-sidebar-add-directory-session
```

Save screenshots of:
- Session existing-directory flow
- Session new-directory flow
- Dashboard action alignment

**Step 6: Commit verification evidence if the team wants screenshots tracked**

```bash
git add evidence/2026-03-28-sidebar-add-directory-session
git commit -m "docs: add sidebar directory session verification evidence"
```

If the team does not want screenshot artifacts committed, still keep the files locally for PR attachment and skip this commit.
