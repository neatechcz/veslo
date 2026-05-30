# VSLO-205 Windows Updater Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Windows in-app updates reliably replace the installed Veslo build, expose installer diagnostics, and verify the release/update publishing path uses the owned-server workflow.

**Architecture:** Keep the Tauri desktop runtime authoritative. Add updater-specific pre-install cleanup on Windows so managed sidecars cannot keep old bundled files locked, pin WiX upgrade identity in release config, add release-time/updater diagnostics for MSI logs, and document/audit owned-server release responsibilities.

**Tech Stack:** Tauri 2, Solid app shell, Rust desktop commands, WiX MSI bundling, GitHub Actions release workflows, pnpm/node contract tests, cargo tests.

---

### Task 1: Commit the Plan

**Files:**
- Create: `docs/plans/2026-05-30-vslo-205-windows-updater-fixes.md`

**Step 1: Verify plan file exists**

Run: `test -f docs/plans/2026-05-30-vslo-205-windows-updater-fixes.md`

**Step 2: Commit**

Run:

```bash
git add docs/plans/2026-05-30-vslo-205-windows-updater-fixes.md
git commit -m "docs: plan VSLO-205 updater fixes"
```

### Task 2: Stop Managed Services Before Windows Update Install

**Files:**
- Modify: `packages/desktop/src-tauri/src/updater.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/desktop/src-tauri/src/updater.rs`

**Step 1: Write failing tests**

Add unit coverage for a small updater shutdown model:

- updater preinstall waits until supplied managed PIDs are no longer running,
- updater preinstall reports timeout when PIDs remain live.

**Step 2: Run tests to verify failure**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml updater::tests::`

Expected: fails because the preinstall helper does not exist.

**Step 3: Implement minimal code**

Add a Windows-focused preinstall helper in the desktop updater module and wire `tauri_plugin_updater::Builder::on_before_exit` to stop managed services before the updater launches `msiexec`.

**Step 4: Verify**

Run: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml updater::tests::`

**Step 5: Commit**

Run:

```bash
git add packages/desktop/src-tauri/src/updater.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "fix(desktop): stop services before Windows updater install"
```

### Task 3: Pin Windows MSI Upgrade Code

**Files:**
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Modify: `scripts/release/review.mjs`
- Test: `scripts/release/review.mjs`

**Step 1: Write failing release-review check**

Add a check that fails when `bundle.windows.wix.upgradeCode` is missing.

**Step 2: Run test/review to verify failure**

Run: `node scripts/release/review.mjs --strict`

Expected: fails because `upgradeCode` is not configured.

**Step 3: Implement minimal config**

Pin the current intended WiX upgrade code in Tauri config and keep the release review gate.

**Step 4: Verify**

Run: `node scripts/release/review.mjs --strict`

**Step 5: Commit**

Run:

```bash
git add packages/desktop/src-tauri/tauri.conf.json scripts/release/review.mjs
git commit -m "fix(release): pin Windows MSI upgrade code"
```

### Task 4: Add Windows MSI Update Logging

**Files:**
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Test: `packages/desktop/scripts/tauri-config.test.mjs`

**Step 1: Write failing config test**

Assert Windows updater installer args include verbose MSI logging to a stable temp path.

**Step 2: Run test to verify failure**

Run: `node packages/desktop/scripts/tauri-config.test.mjs`

Expected: fails because installer logging args are missing.

**Step 3: Implement minimal config**

Add updater Windows installer arguments for `/l*v` logging.

**Step 4: Verify**

Run: `node packages/desktop/scripts/tauri-config.test.mjs`

**Step 5: Commit**

Run:

```bash
git add packages/desktop/src-tauri/tauri.conf.json packages/desktop/scripts/tauri-config.test.mjs
git commit -m "fix(desktop): log Windows updater MSI installs"
```

### Task 5: Audit Owned-Server Updater Publishing

**Files:**
- Modify: release workflow or docs depending on findings
- Test: release workflow contract tests when workflow changes

**Step 1: Inspect release workflow runner placement**

Check whether Windows bundle build, public release mirroring, and `latest.json` publication run on owned-server runners.

**Step 2: Add failing test if workflow change is needed**

Use the existing release workflow contract test style.

**Step 3: Implement minimal workflow/docs change**

Move missing updater publishing jobs to owned-server runners or document that they intentionally remain GitHub-hosted.

**Step 4: Verify**

Run focused release workflow tests.

**Step 5: Commit**

Run:

```bash
git add <changed files>
git commit -m "chore(release): align updater publishing with owned server"
```
