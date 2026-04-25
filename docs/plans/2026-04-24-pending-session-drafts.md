# Pending Session Drafts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `New session` and project `+` open durable pending drafts that stay out of the sidebar until the user presses `Run`.

**Architecture:** Add a desktop-backed pending-draft store in app data, then route the session surface through an explicit active pending-draft context instead of treating all no-session states as one anonymous composer bucket. Real OpenCode sessions remain unchanged and are created only from `sendPrompt`, which now materializes a session from the active pending draft before sending.

**Tech Stack:** SolidJS, Tauri commands in Rust, existing session/workspace app state, node:test, Rust unit tests

---

### Task 1: Add desktop persistence for pending drafts

**Files:**
- Create: `packages/desktop/src-tauri/src/commands/pending_session_drafts.rs`
- Modify: `packages/desktop/src-tauri/src/commands/mod.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/desktop/src-tauri/src/commands/pending_session_drafts.rs`
- Modify: `packages/app/src/app/lib/tauri.ts`

**Step 1: Write the failing Rust tests**

Add tests that prove:

- saving a draft writes metadata plus copied attachments
- loading returns the same metadata and attachments
- deleting a draft removes both `draft.json` and attachment copies
- a broken attachment file is surfaced as a recoverable per-attachment failure

Example test shape:

```rust
#[test]
fn pending_draft_round_trip_persists_metadata_and_attachment_payloads() {
    let root = temp_app_data_dir("pending-draft-round-trip");
    let store = PendingSessionDraftStore::new(root.clone());
    let draft = sample_pending_draft();

    store.save(&draft).expect("save draft");
    let loaded = store.load("new-private").expect("load draft").expect("draft");

    assert_eq!(loaded.meta.kind, PendingDraftKind::NewPrivate);
    assert_eq!(loaded.composer.text, "Draft text");
    assert_eq!(loaded.attachments.len(), 1);
    assert_eq!(loaded.attachments[0].name, "spec.png");
    assert!(!loaded.attachments[0].data_base64.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-desktop test -- pending_session_drafts
```

Expected: FAIL because the pending-draft command module and store do not exist yet.

**Step 3: Write the minimal implementation**

Implement a Tauri command surface that supports:

- `pending_session_drafts_list`
- `pending_session_drafts_get`
- `pending_session_drafts_put`
- `pending_session_drafts_delete`

Use `app_data_dir()/pending-session-drafts/` and keep the payload JSON-focused:

```rust
#[derive(Serialize, Deserialize, Clone)]
struct PendingDraftRecord {
    id: String,
    kind: String,
    workspace_id: String,
    directory_key: Option<String>,
    private_workspace_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    composer: PendingDraftComposer,
    attachments: Vec<PendingDraftAttachmentMeta>,
}
```

Store attachment bytes as files under each draft directory instead of embedding large blobs in one index file.

Expose matching wrappers from `packages/app/src/app/lib/tauri.ts`.

**Step 4: Run tests to verify they pass**

Run:

```bash
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml pending_session_drafts
```

Expected: PASS for the new store/command tests.

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/commands/pending_session_drafts.rs packages/desktop/src-tauri/src/commands/mod.rs packages/desktop/src-tauri/src/lib.rs packages/app/src/app/lib/tauri.ts
git commit -m "feat(desktop): persist pending session drafts"
```

### Task 2: Model pending-draft identity on the app side

**Files:**
- Create: `packages/app/src/app/lib/pending-session-drafts.ts`
- Test: `packages/app/src/app/lib/pending-session-drafts.test.ts`
- Modify: `packages/app/src/app/pages/session-composer-drafts.ts`
- Modify: `packages/app/src/app/pages/session-composer-drafts.test.ts`

**Step 1: Write the failing app tests**

Add tests that prove:

- `new-private` resolves to one global draft key
- directory drafts resolve to distinct keys per normalized target
- real session drafts and pending drafts do not overwrite one another
- restoring a pending draft preserves attachments

Example:

```ts
test("new-private always resolves to one stable pending draft key", () => {
  assert.equal(resolvePendingDraftKey({ kind: "new-private" }), "pending:new-private");
  assert.equal(resolvePendingDraftKey({ kind: "new-private" }), "pending:new-private");
});

test("directory drafts split by workspace and normalized directory", () => {
  assert.equal(
    resolvePendingDraftKey({ kind: "directory", workspaceId: "ws-1", directory: "/tmp/A" }),
    "pending:directory:ws-1:/tmp/A",
  );
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- pending-session-drafts session-composer-drafts
```

Expected: FAIL because the pending-draft key model does not exist.

**Step 3: Write the minimal implementation**

Add a dedicated pending-draft helper module with:

- `resolvePendingDraftKey(...)`
- `isPendingDraftKey(...)`
- `resolveComposerStorageKey({ sessionId, pendingDraftKey })`
- helpers for converting persisted attachment payloads to `ComposerAttachment`

Adjust the composer draft helper so it can store drafts by an explicit storage key rather than only by `selectedSessionId`.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- pending-session-drafts session-composer-drafts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/pending-session-drafts.ts packages/app/src/app/lib/pending-session-drafts.test.ts packages/app/src/app/pages/session-composer-drafts.ts packages/app/src/app/pages/session-composer-drafts.test.ts
git commit -m "feat(app): model pending draft identities"
```

### Task 3: Track the active pending draft in app state

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/session-route-client-resume.test.ts`
- Test: `packages/app/src/app/lib/session-route-selection-guard.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- `/session` with an active pending draft does not get auto-cleared by route effects
- route fallback logic still ignores pending drafts for `/session/<real-id>`
- switching from a real session to a pending draft clears message/todo selection without dropping the pending-draft context

Use either focused logic tests or source-contract tests already used in this area.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-route-client-resume session-route-selection-guard
```

Expected: FAIL because app state only knows `selectedSessionId`.

**Step 3: Write the minimal implementation**

In `app.tsx`, add:

- `activePendingDraftKey`
- `activePendingDraftMeta`
- startup hydration from the Tauri draft store
- helper that computes the current composer storage key from either:
  - `selectedSessionId`
  - or `activePendingDraftKey`

Keep `/session/<id>` dedicated to real sessions only. Keep `/session` as the route for an active pending draft.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-route-client-resume session-route-selection-guard
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/session-route-client-resume.test.ts packages/app/src/app/lib/session-route-selection-guard.test.ts
git commit -m "feat(app): add active pending draft state"
```

### Task 4: Rework `New session` to reuse one pending private draft

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/workspace.ts`
- Test: `packages/app/src/app/utils/temp-folder-isolation.test.ts`
- Test: `packages/app/src/app/pages/session-navigation.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- first `New session` creates one private workspace and opens a pending draft
- second `New session` reopens the same pending draft and does not create another private workspace
- once the pending draft is deleted, the next `New session` creates a fresh private workspace again

Example assertion shape:

```ts
assert.equal(createScratchWorkspaceCalls, 1);
assert.equal(openedPendingDraftKey, "pending:new-private");
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-navigation temp-folder-isolation
```

Expected: FAIL because `openNewSessionWithDirectory()` currently creates a fresh scratch workspace every time.

**Step 3: Write the minimal implementation**

Refactor `openNewSessionWithDirectory()` to:

1. look up the `new-private` pending draft
2. if found, activate its private workspace and open `/session`
3. otherwise create the scratch workspace exactly once, persist the pending draft, then open `/session`

Do not clear the draft bucket on repeat open.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-navigation temp-folder-isolation
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/context/workspace.ts packages/app/src/app/utils/temp-folder-isolation.test.ts packages/app/src/app/pages/session-navigation.test.ts
git commit -m "feat(app): reuse pending new-session private draft"
```

### Task 5: Rework project `+` to open pending drafts instead of sessions

**Files:**
- Modify: `packages/app/src/app/pages/session-navigation.ts`
- Modify: `packages/app/src/app/pages/session-navigation.test.ts`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Test: `packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- project `+` activates the right workspace but does not call real session creation immediately
- project `+` reopens the same pending draft for the same normalized directory
- clicking `+` on two different projects yields two different pending draft targets

Prefer existing navigation tests plus a source-contract test for the sidebar wiring.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-navigation sidebar-directory-session-wiring
```

Expected: FAIL because the current callback ends in `createSessionAndOpen()`.

**Step 3: Write the minimal implementation**

Replace the project-creation callback chain so it opens a pending directory draft:

- keep `createSessionWithWorkspaceActivation(...)` only for real-session creation paths
- add a parallel `openPendingDraftWithWorkspaceActivation(...)` helper
- pass the new callback from `app.tsx` into dashboard/session views and into `WorkspaceSessionList`

The project `+` button keeps its UI, but the callback now targets the pending-draft flow.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-navigation sidebar-directory-session-wiring
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/session-navigation.ts packages/app/src/app/pages/session-navigation.test.ts packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/pages/sidebar-directory-session-wiring.test.ts
git commit -m "feat(app): open project pending drafts from sidebar"
```

### Task 6: Materialize a real session only on send

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts`
- Create: `packages/app/src/app/pending-session-send-flow.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- sending from a pending draft creates the OpenCode session just-in-time
- successful send deletes the pending draft
- failed session creation or failed attachment staging keeps the pending draft intact
- successful send causes the real session to become the selected route/session

Example expectations:

```ts
assert.equal(sessionCreateCalls, 1);
assert.equal(deletePendingDraftCalls, 1);
assert.equal(navigatedTo, "/session/sess-real");
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- pending-session-send-flow composer-screenshot-staging-regression
```

Expected: FAIL because the send path currently assumes either a real selected session or immediate pre-created session creation.

**Step 3: Write the minimal implementation**

Refactor `sendPrompt()` to:

1. detect active pending-draft context
2. create the real session in the target directory only at send time
3. stage attachment copies from the persisted draft store
4. send the prompt
5. delete the pending draft only after successful session creation and send handoff

Keep the existing failure rule: if send cannot complete, do not clear the composer draft.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- pending-session-send-flow composer-screenshot-staging-regression
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts packages/app/src/app/pending-session-send-flow.test.ts
git commit -m "feat(app): create real sessions only when sending drafts"
```

### Task 7: Restore pending drafts after restart and document the behavior

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Test: `packages/app/src/app/pages/session-inline-loading.test.ts`
- Test: `packages/app/src/app/pages/session-composer-drafts.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- startup hydration loads persisted pending drafts before the user reopens them
- opening `New session` after restart restores the old text and attachment chips
- opening a project `+` after restart restores the right directory draft

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-inline-loading session-composer-drafts
```

Expected: FAIL because restart hydration for pending drafts does not exist yet.

**Step 3: Write the minimal implementation**

Hydrate pending-draft metadata during app startup and update the docs to state:

- pending drafts are durable local state
- unstarted drafts stay out of the sidebar
- `New session` reopens the one existing unpublished private draft

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm --filter @neatech/veslo-ui test -- session-inline-loading session-composer-drafts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx docs/features/session-runtime.md docs/dev/state-and-config-reference.md packages/app/src/app/pages/session-inline-loading.test.ts packages/app/src/app/pages/session-composer-drafts.test.ts
git commit -m "docs(app): document pending session draft behavior"
```

### Task 8: Run focused desktop verification

**Files:**
- Modify: none
- Test: existing desktop and app tests only

**Step 1: Run the focused test suite**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test -- pending-session-drafts session-composer-drafts session-navigation sidebar-directory-session-wiring pending-session-send-flow session-inline-loading composer-screenshot-staging-regression
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml pending_session_drafts
```

Expected: PASS.

**Step 2: Run desktop preflight and launch the real app**

Follow `docs/dev/testing-playbook.md` and `docs/dev/development-startup.md`:

- stop internally started Veslo dev/test processes from this repo
- verify no conflicting desktop runtime remains
- launch the `packages/desktop` runtime

**Step 3: Manually verify the user flows**

Check:

- repeated `New session` opens the same unpublished draft
- no new sidebar row appears before `Run`
- project `+` drafts restore correctly
- restart preserves draft text and attachments
- `Run` creates the visible session only then

**Step 4: Commit the verification checkpoint**

```bash
git add .
git commit -m "test(app): verify pending session draft flows"
```
