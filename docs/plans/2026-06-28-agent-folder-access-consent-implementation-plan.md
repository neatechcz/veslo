# Agent Folder Access Consent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Veslo pause on denied local folder reads, explain the request in a localized consent prompt, open the OS folder picker near the requested folder, persist the selected root, and mount it read-only into local agent runtimes.

**Architecture:** Add a structured local folder access request flow that starts from runtime/tool denial and ends in workspace `authorizedRoots`. The app owns user consent and localization; the desktop command layer owns path validation and persistence; the orchestrator consumes approved roots as read-only sandbox mounts at engine launch.

**Tech Stack:** SolidJS app shell, Tauri v2 dialog plugin, Rust Tauri commands, Veslo workspace `.opencode/veslo.json`, TypeScript orchestrator sandbox mounts, Tauri Pilot E2E.

---

### Task 1: Path Request Model and Unit Tests

**Files:**
- Create: `packages/app/src/app/lib/folder-access-request.ts`
- Test: `packages/app/src/app/tests/lib/folder-access-request.test.ts`

**Step 1: Write failing tests**

Cover nearest parent selection, containment validation, and picker defaults.

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  choosePickerStartPath,
  selectedFolderContainsRequestedPath,
} from "../../lib/folder-access-request";

test("starts picker at requested directory when it exists", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("falls back to nearest existing parent for missing leaf", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("accepts selected folder containing requested path", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Drive", "/Users/me/Drive/NDA/file.docx"),
    true,
  );
});

test("rejects unrelated selected folder", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Other", "/Users/me/Drive/NDA/file.docx"),
    false,
  );
});
```

**Step 2: Run failing test**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/folder-access-request.test.ts
```

Expected: fail because the module does not exist.

**Step 3: Implement minimal helpers**

Normalize slashes, trim trailing separators, and use path segment boundaries so `/foo/bar2` does not contain `/foo/bar`.

**Step 4: Run passing test**

Run the same command. Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/folder-access-request.ts packages/app/src/app/tests/lib/folder-access-request.test.ts
git commit -m "test: add folder access request path helpers"
```

### Task 2: Localized Consent Prompt Component

**Files:**
- Create: `packages/app/src/app/components/folder-access-consent-modal.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/tests/components/folder-access-consent-modal.test.ts`

**Step 1: Write failing tests**

Assert that the component exposes stable test hooks, uses localized keys, shows requested path, access mode, duration, and picker guidance.

**Step 2: Run failing test**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/folder-access-consent-modal.test.ts
```

Expected: fail because the component does not exist.

**Step 3: Implement component**

Use the existing modal shell/focus conventions. Props:

```ts
type FolderAccessConsentModalProps = {
  open: boolean;
  requestedPath: string;
  pickerStartPath: string;
  accessMode: "read";
  duration: "workspace";
  error?: string | null;
  onChooseFolder: () => void;
  onCancel: () => void;
};
```

Use translation keys such as:

- `folder_access.title`
- `folder_access.body_intro`
- `folder_access.requested_path_label`
- `folder_access.access_read_only`
- `folder_access.duration_workspace`
- `folder_access.picker_guidance`
- `folder_access.choose_folder`
- `folder_access.cancel`
- `folder_access.invalid_selection`

**Step 4: Add locale entries**

Add English, Czech, and Chinese strings. Keep copy concise and explicit that subfolders are included.

**Step 5: Run passing test**

Run the same component test. Expected: pass.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/folder-access-consent-modal.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/tests/components/folder-access-consent-modal.test.ts
git commit -m "feat: add localized folder access consent prompt"
```

### Task 3: Desktop Grant Command

**Files:**
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/desktop/src-tauri/src/commands/workspace.rs`

**Step 1: Write failing Rust tests**

Add tests for selected-folder containment and `authorized_roots` persistence. Reuse existing workspace command test helpers where possible.

**Step 2: Run failing test**

```bash
cd packages/desktop/src-tauri
cargo test workspace_grant_folder_access --lib
```

Expected: fail until the new validation branch exists.

**Step 3: Add command**

Add a command such as:

```rust
pub fn workspace_grant_folder_access(
    app: tauri::AppHandle,
    workspace_path: String,
    requested_path: String,
    selected_folder_path: String,
    access_mode: String,
) -> Result<ExecResult, String>
```

Rules:

- workspace must be a registered local workspace
- selected folder must not be a system path
- selected folder must equal or contain requested path after canonicalization where possible
- only `read` access is accepted for this first iteration
- successful grant appends selected folder to `authorized_roots`

**Step 4: Register command**

Add it to the Tauri command handler.

**Step 5: Run passing tests**

Run the Rust unit tests again. Expected: pass.

**Step 6: Commit**

```bash
git add packages/desktop/src-tauri/src/commands/workspace.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat: persist verified folder access grants"
```

### Task 4: App Flow Integration

**Files:**
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/app/src/app/stores/config-store.ts`
- Modify: `packages/app/src/app/context/session-runtime-prompts.ts`
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Test: `packages/app/src/app/tests/context/session-runtime-prompts.test.ts`
- Test: `packages/app/src/app/pages/session-folder-access-consent.test.ts`

**Step 1: Add Tauri client wrapper test**

Assert the frontend wrapper calls `workspace_grant_folder_access` with workspace path, requested path, selected folder, and read mode.

**Step 2: Implement wrapper**

Add:

```ts
export async function workspaceGrantFolderAccess(input: {
  workspacePath: string;
  requestedPath: string;
  selectedFolderPath: string;
  accessMode: "read";
}): Promise<ExecResult> {
  return invoke<ExecResult>("workspace_grant_folder_access", {
    workspacePath: input.workspacePath,
    requestedPath: input.requestedPath,
    selectedFolderPath: input.selectedFolderPath,
    accessMode: input.accessMode,
  });
}
```

**Step 3: Wire consent modal state**

Add app state for a pending folder access request:

```ts
type PendingFolderAccessRequest = {
  workspaceId: string;
  workspacePath: string;
  requestedPath: string;
  reason: string;
  pickerStartPath: string;
};
```

When the user chooses a folder, call `pickDirectory({ title, defaultPath: pickerStartPath })`, validate with the helper, call the grant command, refresh workspace config, and schedule workspace runtime reload.

**Step 4: Run app tests**

Run the targeted app tests touched in this task. Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/tauri.ts packages/app/src/app/stores/config-store.ts packages/app/src/app/context packages/app/src/app/tests
git commit -m "feat: wire folder access consent flow"
```

### Task 5: Orchestrator Read-Only Mounts

**Files:**
- Modify: `packages/orchestrator/src/cli.ts`
- Possibly modify: `packages/orchestrator/src/sandbox/types.ts`
- Test: `packages/orchestrator/src/tests/`

**Step 1: Write failing orchestrator test**

Test that a workspace with authorized roots beyond the workspace path passes those paths as read-only `extraMounts` to sandbox launch.

**Step 2: Run failing test**

```bash
pnpm --filter veslo-orchestrator exec bun test src/tests/authorized-roots-sandbox.test.ts
```

Expected: fail because authorized roots are not translated into `extraMounts`.

**Step 3: Implement root loading**

When activating or spawning a workspace engine, load the workspace config, normalize `authorizedRoots`, filter out the primary workspace path, and pass the remaining roots as:

```ts
extraMounts: roots.map((hostPath) => ({ hostPath, readonly: true }))
```

Do not add these roots to `additionalWritePaths`.

**Step 4: Run passing test**

Run the orchestrator test command again. Expected: pass.

**Step 5: Commit**

```bash
git add packages/orchestrator/src/cli.ts packages/orchestrator/src/tests
git commit -m "feat: mount authorized roots read-only in sandbox"
```

### Task 6: Desktop E2E Scenario

**Files:**
- Create: `packages/e2e/pilot-scenarios/folder-access-consent.toml`
- Possibly add helper fixture under `packages/e2e/`

**Step 1: Write scenario**

Use a local workspace and a separate temporary folder. Trigger a prompt that attempts to read the external folder. Verify:

- localized consent modal appears
- cancel leaves the folder unauthorized
- choosing the external folder adds it to workspace config
- subsequent read succeeds after runtime reload

**Step 2: Run real Tauri E2E preflight**

Follow `docs/dev/testing-playbook.md` before launching. Do not use raw Vite or UI-only dev servers.

**Step 3: Run scenario**

```bash
cd packages/e2e
pnpm test:pilot -- --scenario folder-access-consent
```

Expected: pass against the real Tauri runtime.

**Step 4: Commit**

```bash
git add packages/e2e/pilot-scenarios/folder-access-consent.toml
git commit -m "test: cover folder access consent in desktop e2e"
```

### Task 7: Documentation and Final Verification

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/opencode-workspace-runtime-architecture.md`
- Modify: `docs/features/workspace-config-and-sharing.md`

**Step 1: Update docs**

Document that `authorizedRoots` now drive both Veslo-managed local flows and read-only sandbox mounts after explicit user consent.

**Step 2: Run final verification**

Run targeted tests from previous tasks, then run the desktop E2E scenario.

**Step 3: Update graph**

If `graphify` is available:

```bash
graphify update .
```

**Step 4: Commit docs and graph update**

```bash
git add docs/dev/state-and-config-reference.md docs/dev/opencode-workspace-runtime-architecture.md docs/features/workspace-config-and-sharing.md graphify-out
git commit -m "docs: document folder access grants"
```
