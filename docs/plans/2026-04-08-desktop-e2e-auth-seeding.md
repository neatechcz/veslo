# Desktop E2E Auth Seeding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a supported way to seed authenticated desktop E2E state through the existing Den auth snapshot path, then use it for real desktop verification.

**Architecture:** Extend the existing desktop snapshot contract with onboarding bootstrap fields, hydrate those fields before onboarding bootstrap in the app, and let the E2E harness write an isolated seeded snapshot before launching the Tauri binary. This keeps desktop E2E on the real auth restoration path instead of adding a test-only bypass.

**Tech Stack:** Tauri Rust commands, SolidJS app bootstrap, Node-based WDIO E2E harness, Node test runner.

---

### Task 1: Extend the snapshot contract in desktop and app tests

**Files:**
- Modify: `packages/desktop/src-tauri/src/commands/den_auth.rs`
- Modify: `packages/app/src/app/lib/den-auth.ts`
- Test: `packages/app/src/app/lib/den-auth.test.ts`

**Step 1: Write the failing app-side tests**

Add tests that prove `hydrateDenAuthFromDesktopSnapshot()` restores:
- `veslo.language`
- `veslo.onboardingComplete`

Also add a test that missing/blank values do not stomp existing storage unexpectedly.

**Step 2: Run test to verify it fails**

Run: `cd packages/app && node --test --import=tsx/esm src/app/lib/den-auth.test.ts`

Expected: FAIL because the new snapshot fields are not read or written yet.

**Step 3: Write minimal implementation in app snapshot hydration**

Update `den-auth.ts` to:
- extend the desktop snapshot type
- restore `language` and `onboardingComplete` into local storage before onboarding bootstrap continues

Keep the logic narrow and preserve the current auth import behavior.

**Step 4: Extend the Rust snapshot schema**

Update `den_auth.rs` so the snapshot file and Tauri command payload can carry:
- `language`
- `onboarding_complete`

Preserve backward compatibility for existing snapshot files.

**Step 5: Run the app-side test to verify it passes**

Run: `cd packages/app && node --test --import=tsx/esm src/app/lib/den-auth.test.ts`

Expected: PASS

### Task 2: Add E2E harness support for seeded desktop auth state

**Files:**
- Modify: `packages/e2e/helpers/app-launcher.ts`
- Create or modify: `packages/e2e/helpers/desktop-auth-seed.ts`
- Test: `packages/e2e/specs/admin-managed-ai-access.spec.ts`

**Step 1: Write the failing harness/helper test or spec-level expectation**

Add a focused test or helper contract that proves the harness can:
- derive the snapshot file path from the isolated E2E home
- write seeded auth/onboarding state before launch

If a standalone helper test is simpler, prefer that over making the WDIO spec do all the verification.

**Step 2: Run test to verify it fails**

Run the smallest focused test command for the new helper.

Expected: FAIL because the helper does not exist yet.

**Step 3: Write minimal harness implementation**

Add a helper that:
- reads auth seed input from environment
- writes the extended snapshot JSON into the isolated E2E home
- optionally clears the snapshot when no seed is provided

Integrate it into `startApp()` before spawning the desktop binary.

**Step 4: Tighten the desktop spec**

Update `admin-managed-ai-access.spec.ts` so it:
- verifies settings behavior when seeded auth is present
- still skips cleanly when the profile is unseeded and onboarding is expected

**Step 5: Run focused verification**

Run the smallest relevant E2E/helper test(s).

Expected: PASS for the helper path.

### Task 3: Run desktop verification end to end

**Files:**
- Modify only if required by failed verification diagnostics

**Step 1: Build the Tauri E2E binary**

Run: `cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e`

Expected: PASS and produce `packages/desktop/src-tauri/target/debug/veslo`

**Step 2: Run the targeted desktop spec on a clean profile**

Run: `cd packages/e2e && pnpm test --spec ./specs/admin-managed-ai-access.spec.ts`

Expected:
- seeded run: authenticated settings assertion passes
- unseeded run: explicit skip with onboarding/auth reason

**Step 3: Run the real account flow**

Use the real `michal.sara@neatech.cz` browser sign-in flow and a valid OpenAI-backed admin assignment.

Expected:
- desktop app authenticates successfully
- the settings route is reachable
- the spec proves provider/model controls are replaced by admin-managed AI access copy

**Step 4: Record exact blockers if the environment prevents full completion**

If browser auth, provider assignment, or backend state block completion, record the exact blocker and exact reproduction commands.
