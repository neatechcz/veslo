# Veslo Updates Release Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route Veslo desktop updater artifacts and `latest.json` to `neatechcz/veslo-updates` while keeping builds in the main repository.

**Architecture:** Keep the existing release workflow as the build source of truth, add a public-release mirroring layer for desktop assets, and repoint the app updater endpoint to the public distribution repository. Extract any asset-selection logic into script code so it can be verified locally before the GitHub Actions run.

**Tech Stack:** GitHub Actions, Node.js release scripts, Tauri updater config, pnpm workspace

---

### Task 1: Add release-routing test coverage helpers

**Files:**
- Create: `scripts/release/public-release-assets.mjs`
- Create: `scripts/release/public-release-assets.test.mjs`

**Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { isPublicDesktopReleaseAsset } from "./public-release-assets.mjs";

test("includes macOS and Windows updater artifacts but excludes sidecars", () => {
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-darwin-aarch64.app.tar.gz"), true);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-windows-x86_64.msi"), true);
  assert.equal(isPublicDesktopReleaseAsset("veslo-orchestrator-sidecars.json"), false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: FAIL because `isPublicDesktopReleaseAsset` does not exist yet.

**Step 3: Write minimal implementation**

```js
export function isPublicDesktopReleaseAsset(name) {
  return name.startsWith("veslo-desktop-") || name === "latest.json" || name.endsWith(".sig");
}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/release/public-release-assets.mjs scripts/release/public-release-assets.test.mjs
git commit -m "test: cover public desktop release asset filtering"
```

### Task 2: Repoint the app updater to the public repo

**Files:**
- Modify: `packages/desktop/src-tauri/tauri.conf.json`

**Step 1: Write the failing test**

Use the test file from Task 1 or add a second node test that reads `tauri.conf.json` and asserts the updater endpoint contains `neatechcz/veslo-updates`.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: FAIL because the endpoint still points to the old repo.

**Step 3: Write minimal implementation**

Update the updater endpoint to:

```json
"https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json"
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/tauri.conf.json scripts/release/public-release-assets.test.mjs
git commit -m "fix(desktop): point updater at veslo-updates"
```

### Task 3: Add a public-release mirror script

**Files:**
- Create: `scripts/release/mirror-public-release.mjs`
- Modify: `scripts/release/public-release-assets.mjs`
- Modify: `scripts/release/public-release-assets.test.mjs`

**Step 1: Write the failing test**

Add a test that verifies asset filtering only selects public desktop artifacts and excludes sidecars or npm-related assets.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: FAIL because the filter does not yet match the final public asset policy.

**Step 3: Write minimal implementation**

Implement a mirror script that:

- reads release assets from a source repo/tag
- filters them through `isPublicDesktopReleaseAsset`
- creates or reuses the target release
- uploads the filtered assets to the target repo

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/release/mirror-public-release.mjs scripts/release/public-release-assets.mjs scripts/release/public-release-assets.test.mjs
git commit -m "feat(release): add public desktop release mirroring"
```

### Task 4: Wire the GitHub Actions workflow to the public repo

**Files:**
- Modify: `.github/workflows/release-macos-aarch64.yml`
- Modify: `scripts/release/generate-latest-json.mjs`

**Step 1: Write the failing test**

Add or extend the node test so it asserts the public repo can be passed as the `--repo` target for `latest.json` generation and that the workflow references `VESLO_UPDATES_REPO`.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: FAIL because the workflow still uploads `latest.json` only to the source repo and does not mirror to `VESLO_UPDATES_REPO`.

**Step 3: Write minimal implementation**

Update the workflow to:

- read `VESLO_UPDATES_REPO`
- authenticate with `VESLO_UPDATES_GH_TOKEN`
- mirror desktop artifacts after `publish-tauri`
- generate and upload `latest.json` to the public repo release

**Step 4: Run test to verify it passes**

Run: `node --test scripts/release/public-release-assets.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
git add .github/workflows/release-macos-aarch64.yml scripts/release/generate-latest-json.mjs scripts/release/public-release-assets.test.mjs
git commit -m "feat(release): publish desktop updates to veslo-updates"
```

### Task 5: Verify the release path and document operational prerequisites

**Files:**
- Modify: `docs/plans/2026-03-11-veslo-updates-release-routing-design.md`
- Optionally modify: `README.md` or release docs only if needed for operator clarity

**Step 1: Write the failing test**

Define the verification commands and expected outputs before changing docs.

**Step 2: Run test to verify it fails**

Run: `node scripts/release/review.mjs --strict`
Expected: PASS for version alignment; operator documentation still missing the public release secret/variable details.

**Step 3: Write minimal implementation**

Document:

- `VESLO_UPDATES_REPO=neatechcz/veslo-updates`
- required secret `VESLO_UPDATES_GH_TOKEN`
- release tag `v2026.3.0`
- validation commands

**Step 4: Run test to verify it passes**

Run:
- `node scripts/release/review.mjs --strict`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `node --test scripts/release/public-release-assets.test.mjs`

Expected: all pass

**Step 5: Commit**

```bash
git add docs/plans/2026-03-11-veslo-updates-release-routing-design.md README.md .github/workflows/release-macos-aarch64.yml scripts/release/*
git commit -m "docs: record veslo-updates public release routing"
```
