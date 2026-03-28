# Invalid File Continuation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep Veslo sessions running after `invalid_file` failures by filtering obviously invalid new attachments before send and by auto-continuing once in the same session when the provider rejects a file.

**Architecture:** Add small pure app-side helpers for attachment validation, invalid-file classification reuse, recovery prompt generation, and one-attempt recovery state. Then wire those helpers into the composer send path in `app.tsx` and the session error path in `context/session.ts`, keeping the existing synthetic error turn while preventing retry loops.

**Tech Stack:** SolidJS, TypeScript, OpenCode SDK client, Node test runner (`node --test --import=tsx/esm`), pnpm, Tauri desktop app

---

## Prerequisites

- Use `@superpowers:test-driven-development` during implementation.
- Run implementation in a dedicated worktree before touching feature code.
- Do not run a web-only app flow. Use the Tauri desktop app (`packages/desktop`) for any manual verification.
- The current worktree already has unrelated local changes, so implementation should happen in a fresh worktree to avoid mixing user edits into commits.

### Task 1: Create worktree and capture baseline

**Files:**
- Modify: none (environment preparation)

**Step 1: Sync the repository**

Run:

```bash
git fetch --all --prune
git submodule update --init --recursive
```

Expected: completes without errors.

**Step 2: Create and enter a dedicated worktree**

Run:

```bash
git worktree add .worktrees/codex/invalid-file-continuation -b codex/invalid-file-continuation
cd .worktrees/codex/invalid-file-continuation
```

Expected: new worktree exists and branch `codex/invalid-file-continuation` is checked out.

**Step 3: Capture baseline app checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: current branch is green before edits.

### Task 2: Add failing tests for attachment validation and recovery helpers

**Files:**
- Create: `packages/app/src/app/lib/attachment-validation.test.ts`
- Create: `packages/app/src/app/lib/invalid-file-recovery.test.ts`
- Modify: `packages/app/src/app/lib/session-error.test.ts`
- Test: `packages/app/src/app/lib/attachment-validation.test.ts`
- Test: `packages/app/src/app/lib/invalid-file-recovery.test.ts`
- Test: `packages/app/src/app/lib/session-error.test.ts`

**Step 1: Add failing attachment validation tests**

Write tests for a new helper module that cover:

- a valid PDF data URL stays valid
- a declared PDF whose bytes start with HTML is rejected
- a malformed/undecodable data URL is rejected conservatively

Example test shape:

```ts
test("rejects html masquerading as pdf attachment", () => {
  const result = sanitizeOutgoingAttachments([
    {
      id: "a1",
      name: "report.pdf",
      mimeType: "application/pdf",
      kind: "file",
      size: 42,
      dataUrl: "data:application/pdf;base64,PCFET0NUWVBFIGh0bWw+",
    },
  ]);

  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped[0]?.reason, "invalid_pdf_payload");
});
```

**Step 2: Add failing recovery-state tests**

Write tests for a pure helper that covers:

- first `invalid_file` for a session returns `attemptRecovery: true`
- a second `invalid_file` in the same chain returns `attemptRecovery: false`
- a successful non-error reset clears the exhausted state

**Step 3: Extend session-error tests**

Add a failing test that asserts the new classifier helper returns `true` for the existing `invalid_file` fixture and `false` for a normal API error.

**Step 4: Run targeted tests and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-error.test.ts \
  src/app/lib/attachment-validation.test.ts \
  src/app/lib/invalid-file-recovery.test.ts
```

Expected: FAIL because the new helper modules and exports do not exist yet.

**Step 5: Commit failing tests**

```bash
git add \
  packages/app/src/app/lib/session-error.test.ts \
  packages/app/src/app/lib/attachment-validation.test.ts \
  packages/app/src/app/lib/invalid-file-recovery.test.ts
git commit -m "test(app): add invalid file continuation specs"
```

### Task 3: Implement pure helpers to make the new tests pass

**Files:**
- Create: `packages/app/src/app/lib/attachment-validation.ts`
- Create: `packages/app/src/app/lib/invalid-file-recovery.ts`
- Modify: `packages/app/src/app/lib/session-error.ts`
- Test: `packages/app/src/app/lib/attachment-validation.test.ts`
- Test: `packages/app/src/app/lib/invalid-file-recovery.test.ts`
- Test: `packages/app/src/app/lib/session-error.test.ts`

**Step 1: Implement outgoing attachment sanitization helper**

Create a helper with a response like:

```ts
type AttachmentSanitizationResult = {
  kept: ComposerAttachment[];
  dropped: Array<{ attachment: ComposerAttachment; reason: string }>;
};
```

Use simple byte sniffing:

- decode `data:` URL payloads
- for `application/pdf`, require `%PDF-`
- if the decoded prefix looks like `<!doctype html`, `<html`, or XML error text, reject it

**Step 2: Implement recovery-state helper**

Create a small pure state utility that can answer:

```ts
type InvalidFileRecoveryState = "idle" | "recovering" | "exhausted";
```

and expose helpers such as:

```ts
shouldAttemptInvalidFileRecovery(state)
markInvalidFileRecoveryAttempt(state)
markInvalidFileRecoveryExhausted(state)
resetInvalidFileRecovery(state)
buildInvalidFileRecoveryPrompt()
```

**Step 3: Export reusable `invalid_file` classifier**

Refactor `packages/app/src/app/lib/session-error.ts` so the classifier logic is exported and reused by the formatter instead of remaining private.

**Step 4: Run targeted tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-error.test.ts \
  src/app/lib/attachment-validation.test.ts \
  src/app/lib/invalid-file-recovery.test.ts
```

Expected: PASS.

**Step 5: Commit helper implementation**

```bash
git add \
  packages/app/src/app/lib/session-error.ts \
  packages/app/src/app/lib/attachment-validation.ts \
  packages/app/src/app/lib/attachment-validation.test.ts \
  packages/app/src/app/lib/invalid-file-recovery.ts \
  packages/app/src/app/lib/invalid-file-recovery.test.ts
git commit -m "feat(app): add invalid file recovery helpers"
```

### Task 4: Add failing wiring tests for session error recovery behavior

**Files:**
- Create: `packages/app/src/app/context/session-invalid-file-recovery.test.ts`
- Test: `packages/app/src/app/context/session-invalid-file-recovery.test.ts`

**Step 1: Add a focused session-store test**

Cover:

- `session.error` with an `invalid_file` payload triggers the recoverable callback once
- non-file `session.error` payloads do not trigger the callback
- duplicate `invalid_file` errors for the same session do not repeatedly trigger the callback when recovery is already exhausted

Prefer a small harness around `createSessionStore()` rather than mounting the full app.

**Step 2: Run the new test and confirm failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/context/session-invalid-file-recovery.test.ts
```

Expected: FAIL because the callback wiring does not exist yet.

**Step 3: Commit failing wiring test**

```bash
git add packages/app/src/app/context/session-invalid-file-recovery.test.ts
git commit -m "test(app): cover invalid file recovery wiring"
```

### Task 5: Wire recovery into the session store and send path

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/types.ts` (only if a shared recovery type makes the wiring clearer)
- Test: `packages/app/src/app/context/session-invalid-file-recovery.test.ts`
- Test: `packages/app/src/app/lib/attachment-validation.test.ts`
- Test: `packages/app/src/app/lib/invalid-file-recovery.test.ts`
- Test: `packages/app/src/app/lib/session-error.test.ts`

**Step 1: Add a recoverable-error callback to the session store**

Extend the session store options so `session.ts` can notify the app when a `session.error` event is classified as `invalid_file`.

The callback should receive:

```ts
{ sessionID: string; error: Record<string, unknown> }
```

and should run only after the synthetic error turn is appended.

**Step 2: Sanitize attachments before prompt send**

In `app.tsx`, sanitize `resolvedDraft.attachments` before building parts.

Behavior:

- replace the outgoing attachments with the kept list
- if any are dropped, surface a short notice
- if no text and no valid attachments remain, stop locally with a clear error

**Step 3: Trigger one same-session continuation**

In `app.tsx`, maintain a small per-session invalid-file recovery map.

On the callback from `session.ts`:

- if the session is eligible for recovery, mark it recovering
- send a text-only follow-up prompt built by `buildInvalidFileRecoveryPrompt()`
- if it fails with `invalid_file` again, mark recovery exhausted

Reset the session’s recovery state after a normal successful run start or a non-file error path so future unrelated failures are not blocked.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/lib/session-error.test.ts \
  src/app/lib/attachment-validation.test.ts \
  src/app/lib/invalid-file-recovery.test.ts \
  src/app/context/session-invalid-file-recovery.test.ts
```

Expected: PASS.

**Step 5: Commit wiring**

```bash
git add \
  packages/app/src/app/context/session.ts \
  packages/app/src/app/app.tsx \
  packages/app/src/app/types.ts \
  packages/app/src/app/context/session-invalid-file-recovery.test.ts
git commit -m "feat(app): continue after invalid file failures"
```

### Task 6: Run full app verification

**Files:**
- Modify: none
- Test: existing app/unit coverage only

**Step 1: Run typecheck**

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 2: Run full unit suite**

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 3: Run a targeted manual desktop verification**

From the repo root:

```bash
packaging/docker/dev-up.sh
pnpm --filter packages/desktop dev
```

Manual verification:

- attach an obviously bad PDF-like file and confirm Veslo skips it before send
- trigger an `invalid_file` failure scenario and confirm the session appends the error then auto-continues once
- confirm non-file errors still stop normally

Expected: the run stays in the same session and only retries once for invalid-file recovery.

**Step 4: Commit verification-ready state**

```bash
git status --short
```

Expected: only intended implementation files are modified.
