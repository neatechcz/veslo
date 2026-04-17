# Windows Azure Signing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sign Veslo Windows release builds in GitHub Actions with Azure Artifact Signing and upload only signed MSI updater assets.

**Architecture:** Split Windows release handling into a dedicated workflow job that uses the `release-signing` GitHub environment, authenticates to Azure with OIDC, and signs Tauri bundles through a repo-local Windows `signCommand` PowerShell script. Keep macOS/Linux release behavior unchanged and preserve the existing updater asset names.

**Tech Stack:** GitHub Actions, Azure OIDC, Azure Artifact Signing, Tauri 2, PowerShell, Node.js release tests

---

### Task 1: Extend signing resolution for Windows releases

**Files:**
- Modify: `scripts/release/release-signing.mjs`
- Modify: `scripts/release/release-signing.test.mjs`

**Step 1: Write the failing test**

Add tests that:

- require Azure signing configuration for `osType: "windows"`
- keep non-Windows non-macOS behavior unchanged

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: FAIL because Windows Azure signing is not enforced yet.

**Step 3: Write minimal implementation**

Teach the resolver to:

- read Azure signing inputs
- mark Windows signing as ready only when all required values exist
- throw a descriptive error when Windows signing config is missing

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: PASS

### Task 2: Add a repo-local Windows sign command

**Files:**
- Create: `scripts/release/windows-sign.ps1`
- Create: `packages/desktop/src-tauri/tauri.windows.release.conf.json`

**Step 1: Write the failing workflow assertion**

Add a workflow/test assertion that Windows release builds use a dedicated Windows signing path instead of the generic non-macOS branch.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: FAIL because the workflow still uses the generic non-macOS Tauri action.

**Step 3: Write minimal implementation**

Create:

- a PowerShell script that finds `signtool.exe`, locates `Azure.CodeSigning.Dlib.dll`, reads a generated metadata JSON path from env, and signs the target file
- a Windows-only Tauri config overlay that sets `bundle.windows.signCommand` to call that script

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: PASS once the workflow points at the new Windows path.

### Task 3: Split Windows into a dedicated release job

**Files:**
- Modify: `.github/workflows/release-macos-aarch64.yml`

**Step 1: Update the workflow structure**

Refactor the existing Tauri matrix so that:

- macOS/Linux stay in `publish-tauri`
- Windows moves to `publish-tauri-windows`

**Step 2: Wire Azure signing**

In the Windows job:

- set `environment: release-signing`
- add `permissions.id-token: write`
- run `azure/login`
- install Artifact Signing Client Tools
- generate metadata JSON from the GitHub environment variables
- build with Tauri using the Windows config overlay
- verify the MSI signature
- upload the MSI and `.sig` assets with the existing release names

**Step 3: Update downstream dependencies**

Make public mirroring/publishing wait for both desktop jobs.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: PASS

### Task 4: Verify the repo-local release checks

**Files:**
- No new files required beyond the changes above

**Step 1: Run release tests**

Run:

- `node --test scripts/release/release-signing.test.mjs`

Expected: PASS

**Step 2: Run release review**

Run:

- `node scripts/release/review.mjs --strict`

Expected: PASS

**Step 3: Inspect diff**

Run:

- `git diff -- .github/workflows/release-macos-aarch64.yml scripts/release packages/desktop/src-tauri docs/plans`

Expected: only Windows signing and plan/doc changes are present.
