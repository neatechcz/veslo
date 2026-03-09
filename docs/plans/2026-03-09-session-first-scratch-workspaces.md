# Session-First Scratch Workspaces Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current worker-first and folder-first entry flow with a local-first session model where `New session` always opens immediately in a new persistent scratch workspace, while `Open project/folder` always opens a new session in a chosen real folder.

**Architecture:** Scratch workspaces should be implemented as normal local workspaces with app-managed directories so the existing engine, permissions, session, reload, and persistence machinery can be reused. UI entry points should resolve into two explicit actions only: `New session` for a fresh private workspace and `Open project/folder` for an explicit user-selected folder. Remote execution stays in code, but end-user UI paths for remote connect are hidden.

**Tech Stack:** SolidJS, Tauri dialog APIs, workspace context store in `packages/app/src/app/context/workspace.ts`, app shell wiring in `packages/app/src/app/app.tsx`, UI screens in `packages/app/src/app/pages/*.tsx`, package scripts in `packages/app/package.json`

---

## Implementation notes before starting

- Work only in `/Users/vaclavsoukup/AI agent projects/Openwork`.
- Do not remove remote/runtime support from the data model or connection code.
- Do not keep the current `CLOUD_ONLY_MODE = false` hack as the way to make local UI work.
- Prefer normal workspace primitives over inventing a new folderless execution mode.
- Keep commits small and scoped to each task.

### Task 1: Add scratch workspace primitives and fix local engine startup

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/scripts/health.mjs`
- Test: `packages/app/scripts/sessions.mjs`
- Test: `packages/app/scripts/cloud-policy.mjs`

**Step 1: Write the failing test scenario**

Document the expected runtime behavior in code comments next to the changed functions:

```ts
// Expected behavior:
// 1. Creating a scratch workspace yields a real local workspace with a real directory.
// 2. Activating that workspace guarantees a running local client before session creation.
// 3. Session creation must never silently no-op because `client()` is missing.
```

Add a temporary assertion path or guard in `app.tsx` so the current flow fails loudly during development if `createSessionAndOpen()` is called without a client.

**Step 2: Run current checks to capture the failing baseline**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:cloud-policy
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- `test:cloud-policy` currently fails because the runtime policy was changed as a side effect.
- `test:sessions` passes, but it does not cover the broken first-run UI flow yet.

**Step 3: Write minimal runtime primitives**

In `workspace.ts`, add explicit helpers along these lines:

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

async function createScratchWorkspace() {
  const folder = await createManagedScratchWorkspaceFolder();
  await createWorkspaceFlow("starter", folder);
  const created = workspaces().find((w) => w.workspaceType === "local" && w.path === folder);
  return created ?? null;
}
```

Do not implement the final details from the snippet blindly; use the repo’s existing workspace creation and engine helpers.

**Step 4: Remove the policy regression**

Restore `packages/app/src/app/lib/cloud-policy.impl.js` to a value and behavior that match the intended product policy, then decouple local-first UI behavior from that constant.

**Step 5: Run runtime checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:health
pnpm --filter @neatech/veslo-ui test:sessions
pnpm --filter @neatech/veslo-ui test:cloud-policy
```

Expected:

- all four pass

**Step 6: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/app.tsx packages/app/src/app/lib/cloud-policy.impl.js
git commit -m "fix(app): guarantee local runtime for new session flows"
```

### Task 2: Replace folder-first `New session` with scratch-first `New session`

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/scripts/sessions.mjs`

**Step 1: Write the failing behavior contract**

Add a short block comment in `app.tsx` above the new action:

```ts
// New session contract:
// - always create a brand-new scratch workspace
// - never reuse the current real project by default
// - always open a new session immediately
```

**Step 2: Implement a dedicated app action**

Replace the current directory-first handler in `app.tsx` with two explicit actions:

```ts
const openNewSession = async () => {
  const scratch = await workspaceStore.createScratchWorkspace();
  if (!scratch?.id) return;
  const ready = await workspaceStore.ensureLocalWorkspaceActive(scratch.id);
  if (!ready) return;
  await createSessionAndOpen();
};

const openProjectFolder = async () => {
  const selected = await workspaceStore.pickWorkspaceFolder();
  if (!selected) return;
  const workspace = await workspaceStore.ensureWorkspaceForFolder(selected);
  if (!workspace?.id) return;
  const ready = await workspaceStore.ensureLocalWorkspaceActive(workspace.id);
  if (!ready) return;
  await createSessionAndOpen();
};
```

Use the repo’s real naming conventions, but keep this exact behavior.

**Step 3: Wire all primary UI entry points**

Replace current `onQuickNewSession` / `openCreateWorkspace` behavior so:

- primary CTA maps to `openNewSession`
- secondary filesystem CTA maps to `openProjectFolder`

Do this consistently in:

- sidebar
- dashboard
- session empty states

**Step 4: Run targeted checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- both pass

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/workspace.ts packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx
git commit -m "feat(app): make new session create scratch workspaces"
```

### Task 3: Add explicit `Open project/folder` behavior for real folders

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Test: `packages/app/scripts/sessions.mjs`
- Test: `packages/app/scripts/health.mjs`

**Step 1: Define the reuse/bootstrap branch**

In `workspace.ts`, add or refactor a helper with this behavior:

```ts
async function ensureWorkspaceForFolder(folder: string) {
  const normalized = normalizeDirectoryPath(folder.trim());
  const existing = workspaces().find((ws) => ws.workspaceType === "local" && normalizeDirectoryPath(ws.path) === normalized);
  if (existing) return existing;
  await createWorkspaceFlow("starter", normalized);
  return workspaces().find((ws) => ws.workspaceType === "local" && normalizeDirectoryPath(ws.path) === normalized) ?? null;
}
```

Also make sure metadata/bootstrap repair happens on activation if the folder is missing expected config.

**Step 2: Make `Open project/folder` always open a new session**

Do not stop on “open existing project and show its old sessions”. After activation, always call `createSessionAndOpen()`.

**Step 3: Update UI copy**

Replace wording like:

- `Create worker on this device`
- `Create or connect a worker`

With wording like:

- `Open project/folder`
- `Start a new session`

**Step 4: Run checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:health
pnpm --filter @neatech/veslo-ui test:sessions
```

Expected:

- all pass

**Step 5: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx
git commit -m "feat(app): open folders as new-session local projects"
```

### Task 4: Remove remote/worker-first UI from the default local-first product surface

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/scripts/cloud-ui-guards.mjs`

**Step 1: Write the failing UI guard**

Extend `packages/app/scripts/cloud-ui-guards.mjs` so it fails if the normal local-first UI still renders any of the legacy default copy:

```js
[
  "Create or connect a worker",
  "Connect your worker",
  "Create worker on this device",
  "Connect remote worker",
]
```

Only keep remote terms in hidden or explicitly gated internal/admin flows if they still exist.

**Step 2: Hide remote entry points from default UI**

Change the visible end-user surfaces so they do not advertise remote connect in the normal local-first product path. Leave runtime handlers in place if they are still needed internally.

**Step 3: Replace copy with project/session-first language**

Target copy:

- `New session`
- `Open project/folder`
- `Start a new session`
- `Begin in a private workspace, or open an existing project folder.`

**Step 4: Run checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:cloud-ui-guards
```

Expected:

- both pass

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/app.tsx packages/app/scripts/cloud-ui-guards.mjs
git commit -m "refactor(app): make default UI session-first and local-first"
```

### Task 5: Align product and architecture docs with the approved runtime model

**Files:**
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`
- Optionally modify: `AGENTS.md`
- Modify: `docs/plans/2026-03-09-new-session-directory-flow-design.md`

**Step 1: Update product language**

In `PRODUCT.md`, replace current primary flow descriptions so they describe:

- `New session` creates a persistent private workspace and opens a chat immediately
- `Open project/folder` opens a real folder and starts a new chat there
- current end-user UI is local-first
- remote execution remains supported in platform/runtime, but is not shown in current UI

**Step 2: Update architecture language**

In `ARCHITECTURE.md`, describe:

- scratch workspaces as normal local workspaces with app-managed directories
- sessions always running against a real directory
- remote support as a capability retained in code
- user concepts as session/project, not worker

**Step 3: Mark the old design as superseded**

Add a short note at the top of `docs/plans/2026-03-09-new-session-directory-flow-design.md` pointing to the new approved design, or otherwise archive it clearly.

**Step 4: Review diffs**

Run:

```bash
git diff -- PRODUCT.md ARCHITECTURE.md AGENTS.md docs/plans/2026-03-09-new-session-directory-flow-design.md docs/plans/2026-03-09-session-first-scratch-workspaces-design.md
```

Expected:

- docs consistently describe the same local-first UX

**Step 5: Commit**

```bash
git add PRODUCT.md ARCHITECTURE.md AGENTS.md docs/plans/2026-03-09-new-session-directory-flow-design.md
git commit -m "docs: align product and architecture with session-first local UX"
```

### Task 6: End-to-end verification in desktop/dev stack

**Files:**
- No code changes required unless verification uncovers bugs
- Capture screenshots in a repo path such as `packages/app/pr/` if needed

**Step 1: Start the stack**

Run:

```bash
bash packaging/docker/dev-up.sh
```

Expected:

- dev web app and local services start cleanly

**Step 2: Verify scratch-first flow manually**

Use the desktop/Tauri-capable flow if available:

1. Launch app
2. Click `New session`
3. Confirm a new chat opens without a folder picker
4. Confirm a new private workspace is created
5. Repeat and confirm another distinct private workspace is created

**Step 3: Verify `Open project/folder` flow manually**

1. Click `Open project/folder`
2. Choose a folder with no prior workspace
3. Confirm Veslo bootstraps it and opens a new session
4. Repeat with the same folder
5. Confirm Veslo opens another new session in the existing project

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
git commit -m "test(app): verify session-first scratch workspace flows"
```

Only create this commit if verification required code changes.

