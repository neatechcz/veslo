# Codex Auth Upload Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Codex authentication uploads reliable across the full device-login window, fail safely in non-interactive shells, and prove uploaded authentication remains durable across AI Gateway process reconstruction.

**Architecture:** Keep pre-upload bearer sessions one-time and in memory, but extend their lifetime to 20 minutes in both maintained server implementations. Keep successful authentication in the existing encrypted persistent secret store. Harden only the helper's default confirmation path so interactive users retain the safety prompt while automated callers must opt in with `--yes`.

**Tech Stack:** Node.js CLI, Node test runner, TypeScript, Express admin service, Drizzle-backed encrypted secret storage, pnpm, GitHub Actions owned-server deployment.

---

### Task 1: Reject non-interactive confirmation safely

**Files:**
- Modify: `scripts/admin/codex-auth-upload.test.mjs`
- Modify: `scripts/admin/codex-auth-upload.mjs`

**Step 1: Write the failing subprocess test**

Add `spawn` from `node:child_process` and a test that creates a temporary valid
`auth.json`, starts the helper without `--yes`, gives the child no stdin, and
asserts that it exits nonzero without contacting an upload server:

```js
test("CLI rejects non-interactive confirmation without --yes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-auth-upload-non-interactive-"))
  const authJsonPath = path.join(tempDir, "auth.json")
  await writeFile(authJsonPath, validAuthJson, "utf8")

  try {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./codex-auth-upload.mjs", import.meta.url)),
      "--upload-url",
      "http://127.0.0.1:9/upload-must-not-run",
      "--credential-name",
      "Non-interactive Codex",
      "--auth-json-path",
      authJsonPath,
      "--dry-run",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const [exitCode] = await once(child, "exit")

    assert.equal(exitCode, 1)
    assert.match(stderr, /interactive terminal/i)
    assert.match(stderr, /--yes/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
```

**Step 2: Run the test to verify RED**

Run: `node --test --test-name-pattern='non-interactive confirmation' scripts/admin/codex-auth-upload.test.mjs`

Expected: FAIL because the current process exits with status `0` and prints no
actionable error.

**Step 3: Implement the minimal confirmation guard**

Update the default prompt implementation before creating `readline`:

```js
async function promptConfirm(question) {
  if (!process.stdin.isTTY) {
    throw new Error("Confirmation requires an interactive terminal. Re-run with --yes to continue.")
  }
  // existing readline prompt
}
```

Do not add `--yes` to generated commands; explicit confirmation remains the
interactive default.

**Step 4: Run focused helper tests to verify GREEN**

Run: `node --test scripts/admin/codex-auth-upload.test.mjs`

Expected: all helper tests pass, including the subprocess regression.

**Step 5: Commit the helper fix**

```bash
git add scripts/admin/codex-auth-upload.mjs scripts/admin/codex-auth-upload.test.mjs
git commit -m "fix: fail closed for non-interactive codex upload"
```

### Task 2: Extend the upload-session window to 20 minutes

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/test/admin-managed-ai-credentials.test.ts`

**Step 1: Change active-gateway tests to express the 20-minute contract**

In the selected-credential upload test, replace the fixed `now` dependency with
a mutable timestamp. Create two sessions at `08:00`, assert both expiries are
`08:20`, advance to `08:19:59` and prove one upload succeeds, then advance to
`08:20:00` and prove the other session is rejected. Preserve the existing token
reuse assertion.

**Step 2: Run the active-gateway test to verify RED**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test --test-name-pattern='one-time local helper session' test/admin-actions.test.ts`

Expected: FAIL because the current expiry is `08:10` and the session is missing
at `08:19:59`.

**Step 3: Update the active-gateway TTL**

Change only the upload-session constant:

```ts
const CODEX_AUTH_UPLOAD_SESSION_TTL_MS = 20 * 60 * 1000;
```

**Step 4: Run the active-gateway test to verify GREEN**

Run the command from Step 2.

Expected: PASS, including one-time consumption and boundary expiry.

**Step 5: Mirror the contract in the maintained DEN implementation**

Update the DEN HTTP admin test to expect a 20-minute expiry and add the same
mutable-clock boundary coverage. Run it before changing DEN production code:

```bash
pnpm --filter @neatech/den exec tsx --test --test-name-pattern='Codex auth upload' test/admin-managed-ai-credentials.test.ts
```

Expected: FAIL against the 10-minute constant. Then change the DEN constant to
`20 * 60 * 1000` and rerun for GREEN.

**Step 6: Commit the server contract change**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-actions.test.ts services/den/src/managed-ai/http/admin.ts services/den/test/admin-managed-ai-credentials.test.ts
git commit -m "fix: cover codex device login upload window"
```

### Task 3: Characterize durable uploaded authentication

**Files:**
- Create: `services/ai-gateway/test/mysql-secret-store.test.ts`

**Step 1: Add a restart-oriented persistence characterization**

Build a small fake Drizzle database that retains encrypted credential-secret
rows outside the store instance. Create one `MySqlSecretStore`, insert and
replace a `codex_auth_json` secret, discard that instance, create a second
`MySqlSecretStore` with the same database and encryption key, and assert that
the second instance returns the replacement authentication.

The assertion must compare the full structured secret while never printing real
tokens; use synthetic values only.

**Step 2: Run the new characterization test**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test test/mysql-secret-store.test.ts`

Expected: PASS with the existing production implementation. This is a
characterization of already-shipped persistence rather than a behavior change,
so it does not require a RED production failure.

**Step 3: Commit the persistence proof**

```bash
git add services/ai-gateway/test/mysql-secret-store.test.ts
git commit -m "test: prove codex auth survives gateway restart"
```

### Task 4: Update durable operator documentation

**Files:**
- Modify: `docs/admin-managed-ai-access.md`

**Step 1: Document the two durability boundaries**

State that unused one-time sessions are held in memory for 20 minutes and may
be lost on an AI Gateway restart. State separately that a successful upload is
stored in the encrypted persistent secret store and is available after restart.
Document that non-interactive callers must pass `--yes` explicitly.

**Step 2: Verify documentation and diff hygiene**

Run: `git diff --check`

Expected: exit `0` with no whitespace errors.

**Step 3: Commit the documentation update**

```bash
git add docs/admin-managed-ai-access.md
git commit -m "docs: clarify codex upload durability"
```

### Task 5: Run focused and repository quality gates

**Files:**
- No source changes expected.

**Step 1: Run focused helper coverage**

Run: `node --test scripts/admin/codex-auth-upload.test.mjs`

Expected: all tests pass.

**Step 2: Run focused active-gateway coverage**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test --test-name-pattern='Codex auth upload|codex-auth-upload' test/admin-actions.test.ts`

Expected: all selected tests pass.

**Step 3: Run persistence coverage**

Run: `pnpm --filter @neatech/ai-gateway exec tsx --test test/mysql-secret-store.test.ts`

Expected: all tests pass.

**Step 4: Run focused DEN compatibility coverage**

Run: `pnpm --filter @neatech/den exec tsx --test --test-name-pattern='Codex auth upload' test/admin-managed-ai-credentials.test.ts`

Expected: all selected tests pass.

**Step 5: Run the required repository gate**

Run: `pnpm check`

Expected: exit `0` across lint, types, stable unit/contract tests, Rust checks,
and architecture audits.

**Step 6: Inspect final repository state**

Run: `git status --short` and `git log --oneline --decorate -6`

Expected: no uncommitted changes and the scoped commits are present on the
feature branch.

### Task 6: Push and deploy the exact revision

**Files:**
- No source changes expected.

**Step 1: Push the reviewed feature branch**

```bash
git push -u origin codex/fix-codex-auth-upload-expiry
```

Expected: the branch and exact verified commits exist on `origin`.

**Step 2: Dispatch the production owned-server workflow**

```bash
gh workflow run deploy-owned-server.yml \
  --repo neatechcz/veslo \
  --ref codex/fix-codex-auth-upload-expiry \
  -f branch=codex/fix-codex-auth-upload-expiry \
  -f install_backup_timer=true \
  -f run_backup_now=false \
  -f codex_model_migration= \
  -f probe_codex_credentials=false
```

Expected: GitHub accepts a new manual deployment run for the exact branch.

**Step 3: Wait for the deployment run**

Resolve the new run id with `gh run list`, then run:

```bash
gh run watch <run-id> --repo neatechcz/veslo --exit-status
```

Expected: the owned-server deploy job completes successfully, including Compose
validation, image builds, migrations, stack startup, and public endpoint checks.

**Step 4: Verify the public service**

Run: `curl --fail --silent --show-error https://ai.veslo.work/health`

Expected: `{"ok":true,"service":"ai-gateway"}`.

### Task 7: Verify a real post-deploy upload

**Files:**
- No source changes expected.

**Step 1: Create a fresh production upload session**

Use the authenticated AI Gateway admin UI to prepare a new upload command for
the existing Codex credential. Do not reuse a pre-deploy URL.

**Step 2: Upload the already-saved local authentication immediately**

Append the existing profile's `--auth-json-path` and `--yes` options to the new
command so the verification does not repeat device authorization.

Expected: the helper prints `Uploaded Codex auth` and the server confirms the
same synthetic account identifier display without exposing tokens.

**Step 3: Verify post-upload health across a service restart only if explicitly safe**

The deployment itself already reconstructed the AI Gateway before this upload.
Do not restart production again merely for testing. Confirm durability from the
persistence characterization and the live credential status after upload; use a
future normal deployment as the non-disruptive real restart proof.
