# Fresh Updater Signing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Re-establish Veslo desktop updater testing with a fresh Tauri signing key and an internal-test release path that can build macOS artifacts without Apple code signing secrets.

**Architecture:** Centralize release signing-mode decisions in a small Node script with tests, keep the existing public `veslo-updates` mirroring pipeline, and update the desktop app to trust a new updater public key. The operational flow will publish one baseline build for manual install and one follow-up build for actual updater validation.

**Tech Stack:** GitHub Actions, Node.js release scripts, Tauri updater, minisign/Tauri signer, pnpm workspace

---

### Task 1: Add failing tests for release signing resolution

**Files:**
- Create: `scripts/release/release-signing.test.mjs`
- Create: `scripts/release/release-signing.mjs`

**Step 1: Write the failing test**

Cover these cases:

```js
test("requires updater signing secrets", () => {});
test("allows signed macOS when Apple secrets exist", () => {});
test("allows unsigned macOS only when explicitly enabled", () => {});
test("rejects unsigned macOS in strict mode", () => {});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: FAIL because `release-signing.mjs` does not exist yet.

**Step 3: Write minimal implementation**

Implement a helper that:

- reads booleans from args/env
- checks for updater signing secrets
- checks for Apple signing secrets
- returns a resolved signing mode object

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: PASS

### Task 2: Wire the release workflow to the signing resolver

**Files:**
- Modify: `.github/workflows/release-macos-aarch64.yml`
- Modify: `scripts/release/release-signing.test.mjs`

**Step 1: Write the failing test**

Add assertions that the workflow references the signing resolver and the new unsigned-mac input.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: FAIL because the workflow does not yet use the resolver.

**Step 3: Write minimal implementation**

Update the workflow to:

- add an explicit workflow-dispatch input for internal unsigned macOS test releases
- resolve signing mode before the Tauri action step
- use separate Tauri steps for:
  - signed/notarized macOS
  - signed macOS without notarization
  - unsigned macOS test builds
  - non-macOS builds
- fail early if updater signing secrets are missing

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/release-signing.test.mjs`
Expected: PASS

### Task 3: Rotate the desktop updater public key

**Files:**
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Modify: `scripts/release/public-release-assets.test.mjs`

**Step 1: Write the failing test**

Add a test that asserts the updater pubkey is present and not the old placeholder value captured in the current repo state.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: FAIL until the new public key is written.

**Step 3: Write minimal implementation**

- generate a fresh updater keypair
- set the new public key in `tauri.conf.json`
- keep the public updater endpoint unchanged

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: PASS

### Task 4: Document operator setup and the two-release updater test flow

**Files:**
- Modify: `docs/plans/2026-03-22-updater-fresh-signing-design.md`
- Optionally modify: release/operator docs if a better home is needed

**Step 1: Write the failing verification checklist**

List the required repo secrets and the exact release order:

- baseline release for manual install
- follow-up release for in-app update

**Step 2: Run verification command**

Run: `node scripts/release/review.mjs --strict`
Expected: PASS for repo release checks; docs still need the new operator steps.

**Step 3: Write minimal implementation**

Document:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- optional Apple signing secrets for strict production releases
- the `allow_unsigned_macos` internal-test path
- the `v2026.3.1 -> install -> v2026.3.2 -> update` validation flow

**Step 4: Run verification**

Run:

- `node scripts/release/review.mjs --strict`
- `node --test scripts/release/release-signing.test.mjs`
- `node --test scripts/release/public-release-assets.test.mjs`

Expected: all PASS

### Task 5: Dispatch and verify a fresh updater test release

**Files:**
- No repo file changes required; operational verification only

**Step 1: Publish baseline**

Run the release workflow for the next version with unsigned macOS allowed only if Apple secrets are still missing.

**Step 2: Verify baseline artifacts**

Check:

- source release assets
- mirrored public release assets
- public `latest.json`

**Step 3: Install baseline manually**

Install the packaged desktop build once.

**Step 4: Publish follow-up release**

Cut the next version and dispatch the same workflow.

**Step 5: Verify updater behavior**

In the desktop app:

- open Settings -> Advanced -> Updates
- click `Check` if needed
- confirm `available -> downloading -> ready`
- install the update and verify relaunch into the newer version
