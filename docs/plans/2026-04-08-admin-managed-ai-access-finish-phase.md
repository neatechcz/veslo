# Admin-Managed AI Access Finish Phase Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the branch merge-ready by closing the remaining policy-flow coverage gap, documenting the new verification tooling, syncing with the mounted Windows repo, and using CI workflows for Windows MSI and AI gateway deployment.

**Architecture:** Keep product behavior unchanged. Add one focused backend end-to-end policy test, keep the desktop E2E coverage on the already-working authenticated settings flow, and treat Windows packaging plus hosted deployment as CI orchestration work rather than local WSL-native build work.

**Tech Stack:** Node.js, pnpm, WebdriverIO, Tauri, Express, GitHub Actions, Render

---

### Task 1: Add the missing admin-policy flow test

**Files:**
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write the failing test**

Add a test that:
- updates `user_123` via `PUT /admin/api/users/user_123/ai-access`
- then reads `GET /api/me/ai-access`
- asserts the user-facing payload matches the admin-written values

**Step 2: Run the focused test to verify it fails**

Run:

```bash
cd services/ai-gateway && node --import tsx/esm --test test/admin-user-access.test.ts
```

Expected: FAIL because the combined flow assertion is not implemented yet.

**Step 3: Implement the minimal test scaffolding**

Reuse the existing in-memory admin/user app setup in `admin-user-access.test.ts`.

**Step 4: Run the focused test to verify it passes**

Run:

```bash
cd services/ai-gateway && node --import tsx/esm --test test/admin-user-access.test.ts
```

Expected: PASS

### Task 2: Document the new verification tooling

**Files:**
- Modify: `docs/admin-managed-ai-access.md`

**Step 1: Add brief developer-facing commands**

Document:
- desktop auth seeding
- desktop admin-managed settings E2E
- hosted admin user lookup
- Windows MSI workflow path
- AI gateway deploy workflow path

**Step 2: Verify the doc is consistent with actual commands**

Run:

```bash
cd packages/e2e && pnpm run seed:live-auth --help || true
cd packages/e2e && pnpm run check:live-admin-user -- --email michal.sara@neatech.cz || true
```

Expected: command names match the documentation, even if the live flows require browser interaction.

### Task 3: Re-run verification after cleanup

**Files:**
- Verify: `packages/e2e/**`
- Verify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Run focused helper and package checks**

Run:

```bash
cd packages/e2e && node --test --import=tsx/esm helpers/app-launcher.test.ts helpers/desktop-auth-seed.test.ts helpers/live-admin-check.test.ts helpers/live-desktop-auth.test.ts
cd packages/e2e && pnpm exec tsc --noEmit
cd services/ai-gateway && node --import tsx/esm --test test/admin-user-access.test.ts
```

Expected: PASS

**Step 2: Run the authenticated desktop E2E**

Run:

```bash
cd packages/e2e && pnpm test --spec ./specs/admin-managed-ai-access.spec.ts
```

Expected: PASS against the authenticated desktop profile.

### Task 4: Compare and sync the mounted Windows repo

**Files:**
- Verify/sync: `/mnt/d/my_project/veslo-ai-gateway-auth-migration`

**Step 1: Compare source trees**

Use a directory diff that excludes `.git`, `node_modules`, build outputs, and temp files.

**Step 2: Sync if needed**

Use a non-destructive `rsync`/copy strategy from the WSL worktree to the mounted Windows repo root.

**Step 3: Re-check parity**

Run the same diff again and confirm no remaining source differences.

### Task 5: Prepare CI execution for Windows MSI and AI gateway deploy

**Files:**
- Verify: `.github/workflows/build-windows-msi.yml`
- Verify: `.github/workflows/deploy-ai-gateway.yml`

**Step 1: Ensure branch state is ready for push**

Check:

```bash
git status --short
git diff --stat
```

**Step 2: Commit and push the branch**

Use non-interactive git commands only.

**Step 3: Trigger CI workflows**

Use GitHub CLI:

```bash
gh workflow run "Build Windows MSI" --repo neatechcz/veslo
gh workflow run "Deploy AI Gateway" --repo neatechcz/veslo -f service_name=veslo-ai-gateway-dev -f branch=codex/ai-gateway-auth-migration
```

**Step 4: Verify workflow/run status**

Run:

```bash
gh run list --repo neatechcz/veslo --limit 10
```

Expected: both workflow runs are visible and progressing or completed.

### Task 6: Finish branch handoff

**Files:**
- Verify: branch working tree

**Step 1: Summarize**

Report:
- what changed
- verification results
- whether `/mnt/d/my_project/veslo-ai-gateway-auth-migration` matches
- MSI workflow status
- deploy workflow status
- whether hosted admin needs the new deploy to reflect current code

