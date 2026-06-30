# GlitchTip Release Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Embed the public GlitchTip DSN into GitHub-built macOS and Windows desktop releases so frontend and native error monitoring works after install.

**Architecture:** The release workflow owns the DSN. Vite receives it as `VITE_VESLO_GLITCHTIP_DSN`, while Rust receives it as `VESLO_GLITCHTIP_DSN` at compile time and uses `option_env!` as a packaged-app fallback. Release review checks guard the workflow wiring.

**Tech Stack:** GitHub Actions, Tauri v2, Vite, SolidJS, Rust `sentry`, Node release-review tests.

---

### Task 1: Native Compile-Time DSN Fallback

**Files:**
- Modify: `packages/desktop/src-tauri/src/error_monitoring.rs`
- Modify: `packages/app/src/app/tests/lib/error-monitoring.test.ts`

**Step 1: Write the failing test**

Add a source-level assertion to the existing monitoring test that requires `option_env!("VESLO_GLITCHTIP_DSN")` in the native monitoring module.

**Step 2: Run test to verify it fails**

Run: `node --test --import=tsx/esm src/app/tests/lib/error-monitoring.test.ts` from `packages/app`.

Expected: FAIL because the Rust module only reads runtime env.

**Step 3: Implement minimal fallback**

Update Rust monitoring to read runtime env first, then compile-time `option_env!("VESLO_GLITCHTIP_DSN")`.

**Step 4: Run test to verify it passes**

Run the same focused app test.

### Task 2: Release Workflow Env Wiring

**Files:**
- Modify: `.github/workflows/release-macos-aarch64.yml`
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `.github/workflows/build-windows-msi.yml`
- Modify: `scripts/release/review.test.mjs`
- Modify: `scripts/release/review.mjs`

**Step 1: Write failing release-review tests**

Add tests that expect release review to report:

- macOS release build passes GlitchTip DSN to Vite and Rust.
- Windows release build passes GlitchTip DSN to Vite and Rust.
- Manual Windows MSI workflows pass GlitchTip DSN to Vite and Rust.

**Step 2: Run tests to verify failure**

Run: `node --test scripts/release/review.test.mjs`.

Expected: FAIL because no checks exist yet.

**Step 3: Implement workflow wiring and checks**

Add workflow env:

- `VESLO_GLITCHTIP_DSN: ${{ vars.VESLO_GLITCHTIP_DSN }}`
- `VITE_VESLO_GLITCHTIP_DSN: ${{ vars.VESLO_GLITCHTIP_DSN }}`
- `VESLO_GLITCHTIP_ENVIRONMENT: production`
- `VITE_VESLO_GLITCHTIP_ENVIRONMENT: production`

Add early workflow validation steps that fail if the DSN is missing or not an `https://...` URL.

Add release review checks that verify the workflow text contains the expected public variable wiring.

**Step 4: Run tests to verify pass**

Run: `node --test scripts/release/review.test.mjs`.

### Task 3: Documentation

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/veslo-application-logs.md`
- Modify: `RELEASE.md`

**Step 1: Write doc assertions where practical**

Use release-review tests to require that docs mention `VESLO_GLITCHTIP_DSN` and `VITE_VESLO_GLITCHTIP_DSN` for release builds.

**Step 2: Update docs**

Document the public DSN variable, GitHub release requirement, and non-user-configurable policy.

**Step 3: Verify**

Run release-review tests and focused monitoring tests.

### Task 4: Final Verification

**Files:**
- All modified files

**Step 1: Run focused tests**

Run:

- `node --test --import=tsx/esm src/app/tests/lib/error-monitoring.test.ts` from `packages/app`
- `node --test scripts/release/review.test.mjs`
- `node scripts/release/review.mjs --json`

**Step 2: Inspect diff**

Run `git diff --check` and `git diff --stat`.

**Step 3: Report**

Summarize changed behavior and any remaining manual GitHub setup: set repository/environment variable `VESLO_GLITCHTIP_DSN` to the public GlitchTip project DSN.
