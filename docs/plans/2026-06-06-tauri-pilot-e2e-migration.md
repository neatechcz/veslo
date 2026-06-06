# Tauri Pilot E2E Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current WebDriver-based Tauri test driver with `tauri-pilot`, migrate two desktop E2E checks to the pilot workflow, and document that legacy WDIO tests must be ported before they are used as the runtime gate.

**Architecture:** Keep Veslo's authoritative runtime as the debug Tauri desktop binary. Replace the debug-only embedded WebDriver plugin with the debug-only `tauri-plugin-pilot` socket server, add a small TypeScript pilot launcher/helper layer, and run new pilot scenarios from `packages/e2e` without WDIO globals.

**Tech Stack:** Tauri v2, Rust Cargo feature `e2e`, `tauri-plugin-pilot` 0.7.1, `tauri-pilot-cli` 0.7.1, TypeScript, Node test runner, pnpm.

---

### Task 1: Add pilot integration contract tests

**Files:**
- Create: `packages/e2e/helpers/pilot-runner.test.ts`
- Modify: `packages/e2e/helpers/app-launcher.test.ts`

**Steps:**
1. Add failing Node tests that expect pilot-specific env names, command construction, and scenario discovery.
2. Run the targeted tests and confirm they fail because pilot helpers do not exist yet.

### Task 2: Replace Rust driver plugin

**Files:**
- Modify: `packages/desktop/src-tauri/Cargo.toml`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Modify: `packages/desktop/src-tauri/capabilities/default.json`
- Update generated Cargo/schema files only as required by Tauri/Cargo.

**Steps:**
1. Replace optional `tauri-plugin-webdriver` with `tauri-plugin-pilot`.
2. Register `tauri_plugin_pilot::init()` behind the existing debug+e2e gate.
3. Add `pilot:default` capability.
4. Run Cargo/Tauri checks to update lockfiles and verify feature build wiring.

### Task 3: Add pilot E2E runner and migrate two checks

**Files:**
- Create: `packages/e2e/helpers/pilot-runner.ts`
- Create: `packages/e2e/pilot-scenarios/smoke.toml`
- Create: `packages/e2e/pilot-scenarios/navigation.toml`
- Modify: `packages/e2e/package.json`
- Modify: root package scripts if needed.

**Steps:**
1. Implement launch/readiness through `tauri-pilot ping`.
2. Add `tauri-pilot run` execution for the two TOML scenarios.
3. Keep legacy WDIO specs out of the default pilot gate.
4. Run the new helper tests and at least one pilot scenario against the real debug Tauri binary when possible.

### Task 4: Document the new testing policy

**Files:**
- Modify: `AGENTS.md`
- Modify: `packages/desktop/AGENTS.md`
- Modify: `docs/dev/testing-playbook.md`
- Modify: `docs/dev/build-and-rebuild-matrix.md`
- Modify: `docs/dev/app-map.md`
- Modify: `.github/instructions/desktop.instructions.md`
- Modify: `.github/workflows/e2e-ui.yml`

**Steps:**
1. Replace WebDriver/WDIO default-gate language with `tauri-pilot`.
2. State explicitly that legacy WDIO tests are historical and must be converted to pilot before they are used for new validation.
3. Update CI/build commands to install/use `tauri-pilot-cli`.
4. Run reference searches to ensure no canonical docs still describe WDIO as the desktop test gate.

### Task 5: Verify

**Steps:**
1. Run focused TypeScript helper tests.
2. Run Cargo feature checks for the desktop crate.
3. Run the desktop preflight, build the debug `e2e` Tauri binary, and execute the two pilot scenarios unless blocked by the Rust/toolchain requirement.
4. Record exact pass/fail/blocker details.
