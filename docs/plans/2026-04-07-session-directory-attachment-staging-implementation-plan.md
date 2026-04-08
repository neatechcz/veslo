# Session Directory Attachment Staging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stage composer drag-and-drop attachments directly into the active session directory before send, block send on staging failure, and eliminate Inbox-based staging from composer send flow.

**Architecture:** Keep composer behavior unchanged (chips + draft state), but replace pre-send attachment normalization in `app.tsx` with file-session writes targeted at the active session directory (`session override` first, workspace root fallback). Build small pure helpers for path conversion and collision-safe file naming, then wire them into send pipeline for both prompt and slash-command flows. On failure, abort send with explicit error and preserve draft/chips.

**Tech Stack:** SolidJS, TypeScript, Veslo server file-session APIs (`createFileSession`, `readFileBatch`, `writeFileBatch`), Node test runner (`node --test --import=tsx/esm`), WebdriverIO + Tauri desktop E2E.

---

### Task 1: Add failing tests for session-directory staging helpers

**Files:**
- Create: `packages/app/src/app/lib/session-attachment-staging.test.ts`
- Reference: `packages/app/src/app/app.tsx`

**Step 1: Write the failing helper tests (@test-driven-development)**

Add tests for:

1. path normalization from absolute session directory to workspace-relative path
2. invalid target outside workspace root throws
3. collision resolver generates `name`, `name (1)`, `name (2)` while preserving extension

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  toWorkspaceRelativeFromSessionDir,
  splitFilenameForCollision,
  pickCollisionSafeName,
} from "./session-attachment-staging";

test("converts session-dir absolute path to workspace-relative path", () => {
  const result = toWorkspaceRelativeFromSessionDir({
    workspaceRoot: "/repo",
    sessionDirectory: "/repo/project-a",
    filename: "notes.md",
  });
  assert.equal(result, "project-a/notes.md");
});

test("rejects session directory outside workspace root", () => {
  assert.throws(
    () => toWorkspaceRelativeFromSessionDir({
      workspaceRoot: "/repo",
      sessionDirectory: "/other/place",
      filename: "a.txt",
    }),
    /outside workspace root/i,
  );
});

test("collision naming preserves extension", () => {
  const existing = new Set(["docs/report.pdf", "docs/report (1).pdf"]);
  const result = pickCollisionSafeName({
    directoryRel: "docs",
    filename: "report.pdf",
    existingPaths: existing,
  });
  assert.equal(result, "docs/report (2).pdf");
});
```

**Step 2: Run test and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-attachment-staging.test.ts
```

Expected: FAIL with module/function not found errors.

**Step 3: Commit failing tests**

```bash
git add packages/app/src/app/lib/session-attachment-staging.test.ts
git commit -m "test(app): add failing tests for session attachment staging helpers"
```

### Task 2: Implement session-directory staging helper module

**Files:**
- Create: `packages/app/src/app/lib/session-attachment-staging.ts`
- Test: `packages/app/src/app/lib/session-attachment-staging.test.ts`

**Step 1: Implement minimal helper code to satisfy tests**

Create pure utilities:

```ts
export function toWorkspaceRelativeFromSessionDir(input: {
  workspaceRoot: string;
  sessionDirectory: string;
  filename: string;
}): string {
  // normalize separators, enforce sessionDirectory inside workspaceRoot,
  // return workspace-relative target path
}

export function splitFilenameForCollision(filename: string): {
  stem: string;
  ext: string;
} {
  // "report.pdf" => { stem: "report", ext: ".pdf" }
  // "README" => { stem: "README", ext: "" }
}

export function pickCollisionSafeName(input: {
  directoryRel: string;
  filename: string;
  existingPaths: Set<string>;
}): string {
  // candidates: name.ext, name (1).ext, name (2).ext
}
```

**Step 2: Re-run tests and confirm GREEN**

Run the same command from Task 1 Step 2.

Expected: PASS.

**Step 3: Commit helper implementation**

```bash
git add packages/app/src/app/lib/session-attachment-staging.ts packages/app/src/app/lib/session-attachment-staging.test.ts
git commit -m "feat(app): add session directory attachment staging helpers"
```

### Task 3: Add failing app-send tests for hard-fail and no-Inbox behavior

**Files:**
- Modify: `packages/app/src/app/components/session/composer-docx-delegation.test.ts`
- Optionally create: `packages/app/src/app/app-attachment-staging.test.ts`

**Step 1: Extend tests to reflect new contract**

Update assertions to require:

1. no `uploadInbox(` in send pipeline path
2. send pipeline uses session-directory staging helper
3. hard-fail path exists and prevents provider call
4. command arguments receive staged paths too

```ts
assert.doesNotMatch(appSource, /uploadInbox\(/, "composer send should not stage via inbox");
assert.match(appSource, /stageAttachmentsIntoSessionDirectory\(/);
assert.match(appSource, /setError\(/);
assert.match(appSource, /return;\s*\/\/ abort send when staging fails/);
```

**Step 2: Run targeted tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/composer-docx-delegation.test.ts
```

Expected: FAIL because current code still stages through Inbox.

**Step 3: Commit failing assertions**

```bash
git add packages/app/src/app/components/session/composer-docx-delegation.test.ts
git commit -m "test(app): require session-directory staging in send pipeline"
```

### Task 4: Implement session-directory staging in send pipeline

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/veslo-server.ts` (only if missing small typing/helper support)
- Reuse: `packages/app/src/app/lib/session-attachment-staging.ts`

**Step 1: Replace Inbox staging helper in `app.tsx`**

Implement a new helper with this shape:

```ts
const stageAttachmentsIntoSessionDirectory = async (
  draft: ComposerDraft,
  sessionID: string,
): Promise<ComposerDraft> => {
  // resolve sessionDir from override or workspace root
  // open/renew file session with write=true
  // for each attachment:
  //   compute workspace-relative target path
  //   resolve collision-safe name
  //   writeFileBatch(sessionId, [{ path, contentBase64 }])
  // append staged paths to resolvedText and command.arguments
  // return draft with attachments: []
};
```

Remove Inbox-specific assumptions from this send path:

- delete `INBOX_PATH_PREFIX` usage in staging logic
- delete `uploadInbox(...)` usage in composer send flow

**Step 2: Ensure hard-fail preserves draft/chips**

In `sendPrompt`:

- call staging before provider request
- on error: `setError(...)` and `return` without clearing prompt/draft

```ts
try {
  resolvedDraft = await stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID);
} catch (error) {
  setError(error instanceof Error ? error.message : safeStringify(error));
  return;
}
```

**Step 3: Run targeted tests and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-attachment-staging.test.ts src/app/components/session/composer-docx-delegation.test.ts
```

Expected: PASS.

**Step 4: Commit implementation**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/lib/session-attachment-staging.ts packages/app/src/app/components/session/composer-docx-delegation.test.ts
git commit -m "feat(app): stage composer attachments into session directory"
```

### Task 5: Add regression coverage for screenshot hard-fail behavior

**Files:**
- Create: `packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts`
- Modify: `packages/app/src/app/components/session/composer-file-drop-regression.test.ts` (if useful for shared assertions)

**Step 1: Add test for reported bug scenario**

Add source-level assertions ensuring failure path aborts send and keeps draft state contract visible in send logic.

```ts
test("staging failure blocks send and preserves draft attachments", () => {
  assert.match(appSource, /catch \(error\) \{[\s\S]*setError\([\s\S]*return;/);
  assert.doesNotMatch(appSource, /setPrompt\(""\);[\s\S]*catch \(error\)/);
});
```

**Step 2: Run regression tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/composer-file-drop-regression.test.ts src/app/components/session/composer-screenshot-staging-regression.test.ts
```

Expected: PASS.

**Step 3: Commit regression tests**

```bash
git add packages/app/src/app/components/session/composer-screenshot-staging-regression.test.ts packages/app/src/app/components/session/composer-file-drop-regression.test.ts
git commit -m "test(app): cover screenshot staging hard-fail regression"
```

### Task 6: Add desktop E2E for drag-and-drop screenshot flow

**Files:**
- Create: `packages/e2e/specs/attachment-staging.spec.ts`
- Modify: `packages/e2e/helpers/app-launcher.ts` (only if helper for file drop is needed)

**Step 1: Write failing E2E spec first**

Spec should:

1. navigate to `#/session`
2. create/select session
3. drag a real image fixture into composer input
4. click send
5. assert send succeeds (new message appears)
6. assert staged path references session directory, not Inbox path

Skeleton:

```ts
describe("Attachment staging", () => {
  it("stages dropped screenshot to session directory and sends prompt", async () => {
    // arrange fixture and perform drop
    // click send
    // assert timeline updates
    // assert no .opencode/veslo/inbox path usage in resulting context
  });
});
```

**Step 2: Run required desktop build + spec and confirm RED then GREEN**

Build:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e
```

Run spec:

```bash
cd packages/e2e
pnpm test --spec ./specs/attachment-staging.spec.ts
```

Expected first run: FAIL before implementation is complete.  
Expected final run: PASS.

**Step 3: Capture evidence artifacts**

Save screenshots from successful run into repo evidence folder:

- `evidence/2026-04-07-attachment-staging/send-success.png`
- `evidence/2026-04-07-attachment-staging/session-directory-path.png`

**Step 4: Commit E2E + evidence**

```bash
git add packages/e2e/specs/attachment-staging.spec.ts evidence/2026-04-07-attachment-staging
 git commit -m "test(e2e): verify screenshot drop stages into session directory"
```

### Task 7: Full verification gate and final polish (@verification-before-completion)

**Files:**
- Modify only if verification reveals failures

**Step 1: Run complete app unit suite**

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 2: Re-run targeted E2E spec**

```bash
cd packages/e2e
pnpm test --spec ./specs/attachment-staging.spec.ts
```

Expected: PASS.

**Step 3: Run lint/typing gate if used by branch policy**

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 4: Final commit only for any follow-up fixes**

```bash
git add <fixed-files>
git commit -m "fix(app): address attachment staging verification regressions"
```
