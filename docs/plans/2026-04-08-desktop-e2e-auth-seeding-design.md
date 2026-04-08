# Desktop E2E Auth Seeding Design

## Goal

Allow Veslo desktop E2E runs to start from an authenticated, post-onboarding state without adding a fake auth bypass. The desktop app should keep using the same snapshot hydration path that real launches use.

## Problem

The current desktop E2E harness launches the app with a clean profile under `packages/e2e/.tmp-opencode-home`. On a clean profile, Veslo correctly forces the user into the browser sign-in onboarding flow, which means settings-based E2E specs cannot reach the authenticated app shell unless a human completes login first.

The existing desktop auth snapshot path already exists:

- the Tauri side exposes `den_auth_snapshot_read` / `den_auth_snapshot_write`
- the app calls `hydrateDenAuthFromDesktopSnapshot()` before onboarding bootstrap

That path currently restores Den auth only. It does not restore the other persisted flags the app uses to skip onboarding on later launches.

## Recommended Approach

Extend the desktop auth snapshot format to support the minimum extra bootstrap state needed for an authenticated desktop launch:

- persisted Den auth JSON
- `keepSignedIn`
- persisted language preference
- `onboardingComplete`

Then update the E2E harness to optionally write that snapshot into an isolated path inside the E2E temp home before launching the Tauri binary.

## Why This Approach

- It reuses the existing product bootstrap path instead of adding a test-only auth shortcut.
- It remains platform-agnostic because the snapshot file is already the Tauri-facing storage contract.
- It keeps test state isolated to the harness temp directory.
- It supports two modes cleanly:
  - seeded authenticated desktop runs
  - clean-profile onboarding runs

## Scope

### App / desktop runtime

- Extend the Rust snapshot payload and file schema to include:
  - `language`
  - `onboarding_complete`
- Extend the app-side hydration helper to restore those values into local storage before onboarding bootstrap.

### E2E harness

- Add a helper that can write a valid snapshot file into the isolated E2E home before launching the app.
- Support an environment-driven seed so real user auth can be supplied at runtime without hardcoding secrets in the repo.

### Real E2E workflow

- If the operator already has a valid Den auth payload, the harness can seed it directly.
- If not, the operator can complete the browser sign-in once, and we can capture the resulting desktop snapshot for later reruns.

## Explicit Non-Goals

- No fake auth bypass in the app.
- No direct manipulation of WebKit/localStorage files from the harness.
- No changes to the real user-facing login flow.

## Validation

1. Unit tests prove snapshot hydration restores language and onboarding flags.
2. Tauri unit tests prove the extended snapshot file reads and writes the new fields.
3. A targeted WebDriver desktop spec can reach authenticated settings when seeded auth exists.
4. The same spec skips cleanly on an unseeded profile instead of failing ambiguously.
