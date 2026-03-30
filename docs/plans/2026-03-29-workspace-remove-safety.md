# Workspace Remove Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent accidental loss of mounted workspaces by making “Remove workspace” non-destructive by default and requiring explicit confirmation for destructive cleanup.

**Architecture:** Split workspace removal into two explicit modes: detach-only (remove from Veslo list, keep files) and delete-local-data (remove from list and delete `.opencode`/`opencode.jsonc`). Propagate the mode from UI through TypeScript Tauri bridge to Rust command, with default-safe behavior. Add clear confirmation copy in UI before any destructive operation.

**Tech Stack:** SolidJS (`@neatech/veslo-ui`), Tauri command bridge (`@tauri-apps/api` invoke), Rust backend (`packages/desktop/src-tauri`), Node test runner + Rust unit tests.

---

### Task 1: Add Safe Backend Contract For Workspace Forget

**Files:**
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Test: `packages/desktop/src-tauri/src/commands/workspace.rs` (new unit tests in existing test module)

**Step 1: Write the failing Rust test for non-destructive default**

```rust
#[test]
fn workspace_forget_default_keeps_local_files() {
    // Arrange temp workspace with .opencode and opencode.jsonc
    // Call workspace_forget with default/None cleanup mode
    // Assert workspace removed from state, files still exist
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test workspace_forget_default_keeps_local_files -- --nocapture`  
Expected: FAIL because current implementation always deletes local `.opencode` and `opencode.jsonc`.

**Step 3: Write minimal Rust implementation to support mode**

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceForgetMode {
    DetachOnly,
    DeleteLocalData,
}

#[tauri::command]
pub fn workspace_forget(..., mode: Option<WorkspaceForgetMode>, ...) -> Result<WorkspaceList, String> {
    let mode = mode.unwrap_or(WorkspaceForgetMode::DetachOnly);
    // delete files only if mode == DeleteLocalData
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test workspace_forget_default_keeps_local_files -- --nocapture`  
Expected: PASS.

**Step 5: Add destructive mode regression test**

```rust
#[test]
fn workspace_forget_delete_local_data_removes_local_files() {
    // Arrange same fixture
    // Call workspace_forget with DeleteLocalData
    // Assert .opencode/opencode.jsonc removed
}
```

**Step 6: Run both Rust tests**

Run: `cargo test workspace_forget -- --nocapture`  
Expected: both tests PASS.

**Step 7: Wire mode through TS bridge**

```ts
export type WorkspaceForgetMode = "detach_only" | "delete_local_data";
export async function workspaceForget(workspaceId: string, mode?: WorkspaceForgetMode) {
  return invoke<WorkspaceList>("workspace_forget", { workspaceId, mode });
}
```

**Step 8: Update workspace store API to accept mode**

```ts
async function forgetWorkspace(workspaceId: string, options?: { deleteLocalData?: boolean }) {
  const mode = options?.deleteLocalData ? "delete_local_data" : "detach_only";
  const ws = await workspaceForget(id, mode);
}
```

**Step 9: Commit**

```bash
git add packages/desktop/src-tauri/src/commands/workspace.rs packages/app/src/app/lib/tauri.ts packages/app/src/app/context/workspace.ts
git commit -m "fix(workspace): make forget non-destructive by default"
```

### Task 2: Split UI Actions Into Safe Remove vs Destructive Delete

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/sidebar.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts`

**Step 1: Write failing UI test for explicit destructive action presence**

```ts
test("workspace menu exposes separate safe remove and destructive delete actions", () => {
  const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");
  assert.match(source, /remove_workspace/i);
  assert.match(source, /delete_local_data/i);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit`  
Expected: FAIL because only one remove action exists today.

**Step 3: Implement minimal UI split**

```tsx
<button onClick={() => props.onForgetWorkspace(workspace.id, { deleteLocalData: false })}>
  Remove from Veslo
</button>
<button onClick={() => props.onRequestDeleteWorkspaceData(workspace.id)}>
  Delete local worker data…
</button>
```

**Step 4: Add confirmation flow in app container**

```ts
// app.tsx
// state: pendingDeleteWorkspaceId
// modal copy: "This deletes .opencode and opencode.jsonc from <path>."
// confirm => workspaceStore.forgetWorkspace(id, { deleteLocalData: true })
```

**Step 5: Re-run unit tests**

Run: `pnpm --filter @neatech/veslo-ui test:unit`  
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/sidebar.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/app.tsx packages/app/src/app/components/session/workspace-session-list-interactions.test.ts
git commit -m "feat(workspace): split remove and destructive delete actions"
```

### Task 3: Add End-to-End Safety Verification Script

**Files:**
- Create: `packages/app/scripts/workspace-remove-safety.mjs`
- Modify: `packages/app/package.json`
- Create: `docs/plans/assets/workspace-remove-safety/README.md` (manual verification notes)

**Step 1: Write failing script checks**

```js
// Verify:
// 1) detach-only keeps .opencode
// 2) delete-local-data removes .opencode
// throw on mismatch
```

**Step 2: Run script to verify initial failure**

Run: `pnpm --filter @neatech/veslo-ui test:workspace-remove-safety`  
Expected: FAIL before wiring command.

**Step 3: Implement script using existing app command helpers**

```js
// Use deterministic temp workspace fixture
// call corresponding app/tauri command path
// assert filesystem state after each action
```

**Step 4: Register npm script**

```json
"test:workspace-remove-safety": "node scripts/workspace-remove-safety.mjs"
```

**Step 5: Run full verification**

Run:
- `cargo test workspace_forget -- --nocapture`
- `pnpm --filter @neatech/veslo-ui test:unit`
- `pnpm --filter @neatech/veslo-ui test:workspace-remove-safety`

Expected: all PASS.

**Step 6: Commit**

```bash
git add packages/app/scripts/workspace-remove-safety.mjs packages/app/package.json docs/plans/assets/workspace-remove-safety/README.md
git commit -m "test(workspace): add remove safety regression coverage"
```

### Task 4: Manual UX Gate (No New Code)

**Files:**
- Create: `pr/workspace-remove-safety/README.md`
- Create: `pr/workspace-remove-safety/remove-from-veslo.png`
- Create: `pr/workspace-remove-safety/delete-local-data-confirm.png`
- Create: `pr/workspace-remove-safety/delete-local-data-done.png`

**Step 1: Run desktop app (Tauri only)**

Run: `pnpm --filter @neatech/veslo dev`

**Step 2: Verify safe remove path**

Expected:
- Workspace disappears from list
- Project folder still contains `.opencode` and `opencode.jsonc`

**Step 3: Re-add workspace and verify destructive path**

Expected:
- Confirmation modal shown
- After confirmation, `.opencode` and `opencode.jsonc` are removed

**Step 4: Save screenshots + notes**

Document exact steps and outcomes in `pr/workspace-remove-safety/README.md`.

**Step 5: Final commit**

```bash
git add pr/workspace-remove-safety
git commit -m "docs(pr): add workspace remove safety UX evidence"
```

---

Plan complete and saved to `docs/plans/2026-03-29-workspace-remove-safety.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
