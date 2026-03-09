# Session-First Scratch Workspaces Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current folder-first and worker-first entry flow with a single `New session` action that always starts immediately in a persistent private workspace, then let users choose a real folder later from inside the session with copy-and-switch semantics.

**Architecture:** Scratch workspaces should be implemented as normal local workspaces with app-managed directories so the existing engine, permissions, session, reload, and persistence machinery can be reused. The default UI should expose one creation action only: `New session`. A private-workspace session may later use `Choose folder` to copy its contents into a user-selected real folder, switch the backing workspace to that folder, and keep the original private workspace as a hidden backup.

**Tech Stack:** SolidJS, Tauri dialog/file APIs, workspace context store in `packages/app/src/app/context/workspace.ts`, app shell wiring in `packages/app/src/app/app.tsx`, session/dashboard UI in `packages/app/src/app/pages/*.tsx`, Tauri Rust commands under `packages/desktop/src-tauri/src`

---

## Implementation notes before starting

- Work only in `/Users/vaclavsoukup/AI agent projects/Openwork`.
- Do not remove remote/runtime support from the data model or connection code.
- Do not rely on `CLOUD_ONLY_MODE = false` as the mechanism for local-first behavior.
- Prefer normal local workspace primitives over inventing a folderless execution mode.
- Keep commits small and scoped to each task.

### Task 1: Guarantee local runtime readiness for session creation

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/cloud-policy.impl.js`
- Test: `packages/app/package.json`
- Test: `packages/app/scripts/health.mjs`
- Test: `packages/app/scripts/sessions.mjs`
- Test: `packages/app/scripts/cloud-policy.mjs`

**Step 1: Capture the current failure**

Document the expected contract near the relevant functions:

```ts
// Session creation contract:
// 1. The active local workspace must have a running local client.
// 2. createSessionAndOpen() must not silently no-op because client() is missing.
// 3. New-session flows may create or switch workspaces, but must end with a ready client.
```

**Step 2: Run baseline checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:cloud-policy
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- `test:cloud-policy` fails in the current worktree because policy was changed as a side effect
- `test:sessions` passes but does not cover the broken first-run local flow

**Step 3: Add explicit local-runtime helpers**

In `workspace.ts`, add reusable helpers along these lines:

```ts
async function ensureLocalWorkspaceActive(workspaceId: string) {
  const ok = await activateWorkspace(workspaceId);
  if (!ok) return false;
  if (!options.client()) {
    const active = workspaces().find((w) => w.id === workspaceId && w.workspaceType === "local");
    if (!active) return false;
    const started = await startHost({ workspacePath: active.path, navigate: false });
    if (!started) return false;
  }
  return Boolean(options.client());
}
```

Use existing runtime helpers rather than introducing parallel startup logic.

**Step 4: Remove the policy regression**

Restore `packages/app/src/app/lib/cloud-policy.impl.js` to a value and behavior that match the intended product policy, and make the local-first UX explicit in the UI flow instead of piggybacking on that constant.

**Step 5: Verify**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:health
pnpm --filter @neatech/veslo-ui test:sessions
pnpm --filter @neatech/veslo-ui test:cloud-policy
```

Expected:

- all pass

**Step 6: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/app.tsx packages/app/src/app/lib/cloud-policy.impl.js
git commit -m "fix(app): guarantee local runtime before session creation"
```

### Task 2: Make `New session` create a fresh private workspace

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/app/scripts/sessions.mjs`

**Step 1: Add scratch workspace creation primitives**

Expose a helper in the Tauri layer that can create a persistent app-managed workspace folder, then create or register a normal local workspace for it.

Expected shape:

```ts
async function createScratchWorkspace(): Promise<WorkspaceInfo | null>
```

Use the app data directory or another app-managed location rather than temp directories.

**Step 2: Replace the current folder-picker new-session handler**

In `app.tsx`, replace the current directory-first flow with:

```ts
const openNewSession = async () => {
  const workspace = await workspaceStore.createScratchWorkspace();
  if (!workspace?.id) return;
  const ready = await workspaceStore.ensureLocalWorkspaceActive(workspace.id);
  if (!ready) return;
  await createSessionAndOpen();
};
```

`New session` must not open a directory picker.

**Step 3: Keep private workspaces isolated**

Ensure repeated `New session` actions create distinct directories and distinct local workspace records.

**Step 4: Verify**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- both pass

**Step 5: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/app.tsx packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/commands/workspace.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(app): make new session create private workspaces"
```

### Task 3: Add in-session `Choose folder` copy-and-switch flow

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/app/scripts/sessions.mjs`

**Step 1: Validate the session-directory contract**

Before changing UI behavior, prove the session API behavior with a focused script/test:

1. create a session in a private workspace directory
2. attempt to switch it to a second directory using the raw SDK
3. verify whether the same session ID can continue in the new directory

OpenCode does not mutate the stored `session.directory`, but the same session can continue running against a new request `directory`. Veslo must therefore persist a local session-directory override so the migrated session stays attached to the chosen folder in the UI and across restarts.

**Step 2: Add folder-switch primitives**

Expose a helper that can:

1. inspect the current private workspace contents
2. compare them with a chosen target folder
3. detect filename conflicts
4. copy files into the target folder
5. preserve the old private workspace as backup
6. update the active workspace/session to use the real folder
7. persist a local session-directory override for the migrated session

Expected shape:

```ts
type FolderSwitchResult =
  | { kind: "ok"; workspace: WorkspaceInfo }
  | { kind: "conflict"; paths: string[] }
  | { kind: "cancel" };
```

**Step 3: Add a simple conflict model**

Do not build per-file merge UX. Support exactly these outcomes:

- replace conflicting files
- choose another folder
- cancel

The user must be prompted before overwrite.

**Step 4: Show `Choose folder` only for private-workspace sessions**

In `session.tsx`:

- show a subtle `Choose folder` action only when the active session is still backed by a private workspace
- hide or disable it once the session has switched to a real folder
- show the folder/project as read-only context after switch

**Step 5: Verify**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- both pass

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/context/workspace.ts packages/app/src/app/app.tsx packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/commands/workspace.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(app): allow private sessions to choose a folder later"
```

### Task 4: Remove top-level folder actions and worker-first UI

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/scripts/cloud-ui-guards.mjs`

**Step 1: Remove top-level folder picking from primary flows**

Default visible creation action should be only:

- `New session`

Remove or hide top-level `Open project/folder` entry points from default BFU UI.

**Step 2: Remove worker-first copy**

Extend `packages/app/scripts/cloud-ui-guards.mjs` so it fails if the normal local-first UI still renders any of:

```js
[
  "Create or connect a worker",
  "Connect your worker",
  "Create worker on this device",
  "Connect remote worker",
]
```

Keep remote/admin terms only in explicitly gated internal flows if they still exist.

**Step 3: Replace copy**

Target copy:

- `New session`
- `Start a new session`
- `Begin in a private workspace. You can choose a folder later if you need one.`
- `Choose folder`

**Step 4: Verify**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:cloud-ui-guards
```

Expected:

- both pass

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/app.tsx packages/app/scripts/cloud-ui-guards.mjs
git commit -m "refactor(app): simplify top-level UI to new session only"
```

### Task 5: Update docs and end-to-end verification

**Files:**
- Modify: `docs/plans/2026-03-09-session-first-scratch-workspaces-design.md`
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`
- Modify: `VISION.md`
- Modify: `INFRASTRUCTURE.md`
- Optionally add screenshots under `packages/app/pr/`

**Step 1: Align docs with implemented behavior**

Make sure docs describe:

- one top-level `New session`
- later in-session `Choose folder`
- copy-and-switch semantics
- conflict confirmation
- cross-device view-only behavior

**Step 2: Start the dev stack**

Run:

```bash
bash packaging/docker/dev-up.sh
```

Expected:

- dev services start cleanly

**Step 3: Manual/E2E verification**

Verify:

1. `New session` opens immediately without folder picker
2. a second `New session` creates a distinct private workspace
3. `Choose folder` is visible in private-workspace sessions
4. choosing a clean folder copies and switches the session
5. choosing a conflicting folder shows overwrite/choose another/cancel
6. after switch, `Choose folder` is gone or disabled

If desktop-native dialog automation is blocked here, verify as much as possible via tests and local logs, and say exactly what remains manual.

**Step 4: Run automated checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:health
pnpm --filter @neatech/veslo-ui test:sessions
pnpm --filter @neatech/veslo-ui test:cloud-policy
pnpm --filter @neatech/veslo-ui test:cloud-ui-guards
```

Expected:

- all pass

**Step 5: Final commit if verification required fixes**

```bash
git add -A
git commit -m "test(app): verify private workspace and choose-folder flows"
```

Only create this commit if verification required code changes.
