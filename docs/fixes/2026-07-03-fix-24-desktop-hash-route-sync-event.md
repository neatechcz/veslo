# Fix 24: Desktop Hash Route Sync Event Crash

## Problem

Desktop/Tauri hash navigation could crash when an E2E/runtime helper changed
`window.location.hash` and dispatched `hashchange`:

```text
index-DBFm7Hsf.js:590 Uncaught TypeError: Cannot read properties of undefined (reading 'hash')
    at A (index-DBFm7Hsf.js:590:12499)
    at navigateToHash (...:196:16)
```

The minified `A` mapped to `syncExternalHashRoute` in
`packages/app/src/app/context/app-route-sync.ts`.

Root cause: `startHashRouteSync` registered `syncExternalHashRoute` directly as
the DOM `hashchange` listener. Browser event dispatch passed a
`HashChangeEvent` into that helper, and the helper interpreted it as an
`AppRouteHashWindowTarget`. The event has no `location.hash`, so the route sync
crashed before it could consume the hash route.

## Fix

- Added a small `AppRouteHashChangeListener` type.
- Added `createAppRouteHashChangeListener`, which ignores DOM event arguments
  and calls `syncExternalHashRoute` with the mounted window target.
- Changed `startHashRouteSync` to register the wrapper listener instead of
  registering `syncExternalHashRoute` directly.
- Kept `syncExternalHashRoute(windowTarget?)` intact for explicit/manual calls.
- Kept cleanup scoped to the same wrapper listener that was registered.
- Added a focused unit regression proving a fake `hashchange` event argument no
  longer crashes and still navigates to the expected hash route.
- Updated the app refactor contract test so future changes do not reintroduce
  direct `syncExternalHashRoute` listener registration.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-07-03-desktop-hash-route-sync-event-kiss-plan.md
```

Top-level `done` and HRS00 through HRS03 are all marked complete.

## Scope Boundaries

- Did not change `packages/e2e/helpers/app-launcher.ts`.
- Did not change Solid router setup or Tauri routing mode.
- Did not change hash route semantics.
- Did not broaden the fix into deep-link, auth, or startup-route handling.
- Did not add browser/jsdom test wiring for this narrow slice.

## Coverage

- `app-route-sync.test.ts` covers the event-argument crash path through the same
  wrapper used by `startHashRouteSync`.
- Existing hash route coverage still verifies absolute Tauri hash routes,
  dashboard tab alias sync, and `{ replace: true }` navigation.
- `app-refactor-contracts.test.ts` guards the source structure so the DOM
  listener remains wrapped and cleanup removes the wrapper.

## Verification

Run on 2026-07-03:

```powershell
corepack pnpm@10.27.0 --dir veslo/packages/app exec node --test --import=tsx/esm src/app/tests/context/app-route-sync.test.ts src/app/tests/app-refactor-contracts.test.ts
corepack pnpm@10.27.0 --dir veslo/packages/app typecheck
git -C veslo diff --check -- packages/app/src/app/context/app-route-sync.ts packages/app/src/app/tests/context/app-route-sync.test.ts packages/app/src/app/tests/app-refactor-contracts.test.ts docs/plans/2026-07-03-desktop-hash-route-sync-event-kiss-plan.md
```

Result:

- Focused app route-sync and contract tests passed: `9` tests.
- App typecheck passed.
- `git diff --check` passed with Windows LF-to-CRLF warnings only.

Note: verification used `corepack pnpm@10.27.0` because the default local
`pnpm` shim invoked `11.5.2`, which the repo rejects.

## Status

Complete for this KISS checkpoint. Desktop hash route sync no longer treats a
DOM `HashChangeEvent` as the route-sync window target, so `navigateToHash` style
navigation can trigger `hashchange` without crashing on `location.hash`.
