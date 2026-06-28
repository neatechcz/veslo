# Global Unpublished Chat Draft Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-workspace unpublished chat drafts with one application-wide unpublished draft while preserving existing post-send and real-session behavior.

**Architecture:** Keep target selection separate from composer draft storage. Any unpublished pending target can still identify where the first message should be posted, but the composer body and desktop persistence use one global unpublished draft record. Old per-workspace pending drafts are ignored rather than migrated.

**Tech Stack:** SolidJS app state, Tauri pending-draft commands, Node test runner with `tsx`, `tauri-pilot` desktop E2E scenarios.

---

### Task 1: Add The Desktop E2E UI Contract

**Files:**
- Create: `packages/e2e/pilot-scenarios/global-unpublished-draft.toml`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/helpers/pilot-runner.test.ts`

**Step 1: Write the failing E2E scenario**

Create a `tauri-pilot` scenario that:

1. Waits for the app root.
2. Sets sidebar view to by-project.
3. Registers or finds a second local workspace through the Tauri workspace commands.
4. Opens bare `/session`.
5. Types a unique draft into the composer.
6. Switches the unpublished target to the second workspace through the UI.
7. Verifies the same text remains in the composer.
8. Sends the draft.
9. Waits for the unique text to appear in the materialized real conversation.
10. Opens another unpublished chat and verifies the old project-specific draft does not restore.

Use the helper style from `packages/e2e/pilot-scenarios/composer-draft-workspace-move.toml`, but assert the new global behavior:

```js
const summaries = await tauriInvoke("pending_session_drafts_list");
const loaded = [];
for (const summary of summaries) {
  const item = await tauriInvoke("pending_session_drafts_get", { draftId: summary.id });
  loaded.push({ id: summary.id, workspaceId: summary.workspaceId, text: item?.draft?.composer?.text || "" });
}
assert(loaded.filter((draft) => draft.text === draftText).length <= 1, "Unpublished draft text was saved into multiple pending drafts.");
```

**Step 2: Add managed-AI fixture selection**

Update `scenarioSelectionNeedsManagedAiGatewayFixture` so the new send scenario gets the existing managed AI gateway fixture:

```ts
scenario.replaceAll("\\", "/").endsWith("/pilot-scenarios/global-unpublished-draft.toml")
```

Add a runner unit test proving the new scenario requests the managed AI fixture.

**Step 3: Run the runner test to verify the scenario is selectable**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
```

Expected now: FAIL before implementation if the helper test was added first and the fixture selector has not been updated. PASS after Step 2.

**Step 4: Commit**

```bash
git add packages/e2e/pilot-scenarios/global-unpublished-draft.toml packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/pilot-runner.test.ts
git commit -m "test(e2e): cover global unpublished draft target switching"
```

### Task 2: Lock Down Global Pending Draft Keys In App Tests

**Files:**
- Modify: `packages/app/src/app/tests/lib/pending-session-drafts.test.ts`
- Modify: `packages/app/src/app/tests/pages/session-composer-drafts.test.ts`
- Modify: `packages/app/src/app/lib/pending-session-drafts.ts`
- Modify: `packages/app/src/app/pages/session-composer-drafts.ts`

**Step 1: Write failing unit tests**

Add tests proving:

- any pending draft target uses one composer storage bucket
- real session ids still use separate composer storage buckets
- deleting a pending composer draft clears the global unpublished bucket only

Example expectation:

```ts
const chatKey = resolvePendingDraftKey({ kind: "new-private" });
const projectKey = resolvePendingDraftKey({
  kind: "directory",
  workspaceId: "workspace-a",
  directory: "/Users/demo/project",
});

const withChatDraft = setSessionComposerDraft({}, { storageKey: chatKey }, draft("hello"));
const projectDraft = getSessionComposerDraft(withChatDraft, { storageKey: projectKey });

assert.equal(projectDraft.text, "hello");
```

**Step 2: Run the focused app tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/pending-session-drafts.test.ts src/app/tests/pages/session-composer-drafts.test.ts
```

Expected: FAIL because pending storage keys are still distinct per workspace.

**Step 3: Implement global unpublished composer storage**

In `pending-session-drafts.ts`, add one global unpublished composer storage key and map any pending draft key to it from `resolveComposerStorageKey`. Keep normal session ids unchanged.

```ts
const GLOBAL_UNPUBLISHED_COMPOSER_STORAGE_KEY = `${PENDING_DRAFT_KEY_PREFIX}global-unpublished`;

export const resolveComposerStorageKey = (input: {
  sessionId?: string | null;
  pendingDraftKey?: string | null;
}) => {
  const pendingDraftKey = (input.pendingDraftKey ?? "").trim();
  if (pendingDraftKey) {
    if (!isPendingDraftKey(pendingDraftKey)) {
      throw new Error("pendingDraftKey must be a pending draft key");
    }
    return GLOBAL_UNPUBLISHED_COMPOSER_STORAGE_KEY;
  }

  return normalizeSessionId(input.sessionId);
};
```

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/pending-session-drafts.test.ts src/app/tests/pages/session-composer-drafts.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/pending-session-drafts.ts packages/app/src/app/pages/session-composer-drafts.ts packages/app/src/app/tests/lib/pending-session-drafts.test.ts packages/app/src/app/tests/pages/session-composer-drafts.test.ts
git commit -m "feat(app): use one unpublished composer draft bucket"
```

### Task 3: Store One Durable Pending Draft Record

**Files:**
- Modify: `packages/app/src/app/context/pending-session-draft-controller.ts`
- Modify: `packages/app/src/app/controllers/pending-draft-startup-controller.ts`
- Modify: `packages/app/src/app/tests/context/pending-session-draft-controller.test.ts`
- Modify: `packages/app/src/app/tests/controllers/pending-draft-startup-controller.test.ts`

**Step 1: Write failing tests**

Add tests proving:

- `openNewSessionWithDirectory` ignores old private pending drafts and creates or opens the global draft record
- `openDirectoryPendingDraft` writes the same global draft id while updating the selected workspace/directory metadata
- startup hydration ignores old per-workspace pending drafts when no global record exists

Use a fixed expected id:

```ts
assert.equal(persistedDraft.id, "pending-global-unpublished");
```

**Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/pending-session-draft-controller.test.ts src/app/tests/controllers/pending-draft-startup-controller.test.ts
```

Expected: FAIL because new/private and directory drafts still use separate ids and old summaries are still considered.

**Step 3: Implement one durable id and obsolete-draft filtering**

In `pending-session-drafts.ts`, export:

```ts
export const GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID = "pending-global-unpublished";

export const isGlobalUnpublishedPendingDraftSummary = (draft: { id?: string | null }) =>
  (draft.id ?? "").trim() === GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID;
```

Use that id for both private and directory pending draft writes. Filter pending-draft lists in app controllers so only this id participates in startup hydration, target switching, and active draft restore. Do not migrate old draft ids.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/pending-session-draft-controller.test.ts src/app/tests/controllers/pending-draft-startup-controller.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/pending-session-draft-controller.ts packages/app/src/app/controllers/pending-draft-startup-controller.ts packages/app/src/app/lib/pending-session-drafts.ts packages/app/src/app/tests/context/pending-session-draft-controller.test.ts packages/app/src/app/tests/controllers/pending-draft-startup-controller.test.ts
git commit -m "feat(app): persist one global unpublished pending draft"
```

### Task 4: Simplify Target Switching And Remove Draft Conflicts

**Files:**
- Modify: `packages/app/src/app/context/composer-target-controller.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-composer-entry.test.ts`
- Modify: `packages/app/src/app/tests/context/composer-target-controller.test.ts`
- Delete or retire: `packages/app/src/app/lib/composer-target-draft-conflict.ts`
- Delete or retire: `packages/app/src/app/tests/lib/composer-target-draft-conflict.test.ts`

**Step 1: Write failing tests**

Update target-controller tests so switching targets:

- never loads a destination draft body
- persists the current global draft with new target metadata
- does not return a conflict result
- keeps draft text unchanged when moving between chat and workspace targets

Example assertion:

```ts
pendingSessionDraftsGet: async () => {
  throw new Error("global target switch should not load destination draft text");
}
```

**Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/composer-target-controller.test.ts src/app/pages/session-composer-entry.test.ts src/app/tests/lib/composer-target-draft-conflict.test.ts
```

Expected: FAIL while conflict behavior and destination draft loading still exist.

**Step 3: Simplify implementation**

Remove the target conflict path from `createComposerTargetController`. Target switching should:

1. Resolve or pick the target.
2. Activate/register the target workspace if needed.
3. Persist the current global composer draft with the target metadata.
4. Set the active target key and metadata.
5. Show the session view.

Remove conflict modal state and resolution handling from the session page if no other caller uses it.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/composer-target-controller.test.ts src/app/pages/session-composer-entry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/composer-target-controller.ts packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-composer-entry.test.ts packages/app/src/app/tests/context/composer-target-controller.test.ts packages/app/src/app/lib/composer-target-draft-conflict.ts packages/app/src/app/tests/lib/composer-target-draft-conflict.test.ts
git commit -m "feat(app): switch unpublished targets without draft conflicts"
```

If the conflict files are deleted, use `git add -A` for those exact paths instead of adding missing files by name.

### Task 5: Preserve First-Send Behavior

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/tests/pending-session-send-flow.test.ts`
- Modify: `packages/app/src/app/tests/context/workspace-send-target.test.ts`
- Modify: `packages/app/src/app/tests/components/session/composer-screenshot-staging-regression.test.ts`

**Step 1: Write failing tests**

Add or update tests proving:

- pending send snapshots both the current draft and the selected destination before materializing a real session
- failed send keeps the global draft and selected destination
- successful send clears the global pending draft only after prompt handoff succeeds
- real-session composer draft handling is unchanged

**Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pending-session-send-flow.test.ts src/app/tests/context/workspace-send-target.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts
```

Expected: FAIL until the active target metadata and global draft cleanup rules are aligned.

**Step 3: Implement minimal send-path alignment**

Keep the existing materialization and server handoff path. Adjust only the pending-draft snapshot and cleanup code so it uses the selected target metadata from `activePendingDraftMeta`, while deleting the one global pending draft id after success.

Do not change Veslo server conversation binding or OpenCode session routing.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pending-session-send-flow.test.ts src/app/tests/context/workspace-send-target.test.ts src/app/tests/components/session/composer-screenshot-staging-regression.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/tests/pending-session-send-flow.test.ts packages/app/src/app/tests/context/workspace-send-target.test.ts packages/app/src/app/tests/components/session/composer-screenshot-staging-regression.test.ts
git commit -m "fix(app): preserve first-send handoff for global drafts"
```

### Task 6: Update Documentation

**Files:**
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/plans/2026-06-28-global-unpublished-chat-draft-design.md`

**Step 1: Update docs**

Replace the old project-pending-draft contract with:

- unpublished chats use one global draft body
- target selection determines where the draft will be sent
- old per-workspace pending drafts are obsolete and not migrated
- real conversations keep per-session composer drafts

**Step 2: Run docs/app validation**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

**Step 3: Commit**

```bash
git add docs/features/session-runtime.md docs/dev/state-and-config-reference.md docs/plans/2026-06-28-global-unpublished-chat-draft-design.md
git commit -m "docs: document global unpublished draft behavior"
```

### Task 7: Final Verification

**Files:**
- No new files unless verification uncovers a bug.

**Step 1: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If only internally-started Veslo dev/test processes from this repo are present, stop them and verify the post-check is empty before launching E2E.

**Step 3: Build desktop E2E runtime**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
```

Expected: PASS.

**Step 4: Run the focused E2E UI scenario**

Run:

```bash
cd packages/e2e
pnpm test:pilot -- --scenario global-unpublished-draft
```

Expected: PASS.

**Step 5: Update graph**

Run:

```bash
graphify update .
```

Expected: PASS or clearly report that `graphify` is unavailable.

**Step 6: Final commit if verification required fixups**

Commit only verification-driven fixes, not unrelated local changes.
