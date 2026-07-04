---
title: Desktop Hash Route Sync Event KISS Plan
date: 2026-07-03
target: packages/app/src/app/context/app-route-sync.ts
status: implemented
done: true
hrs00_repro_regression_done: true
hrs01_listener_wrapper_done: true
hrs02_contract_test_update_done: true
hrs03_verification_done: true
---

# Desktop Hash Route Sync Event KISS Plan

## Goal

Stop desktop/Tauri hash navigation from crashing when a `hashchange` event is
delivered to Veslo's route sync listener.

Observed failure:

```text
index-DBFm7Hsf.js:590 Uncaught TypeError: Cannot read properties of undefined (reading 'hash')
    at A (index-DBFm7Hsf.js:590:12499)
    at navigateToHash (...:196:16)
```

The minified `A` maps to `syncExternalHashRoute` in
`packages/app/src/app/context/app-route-sync.ts`.

## Implementation Status Contract

This document starts with every implementation status set to `done: false`.

Agents implementing the plan must mark a task complete only after that task's
code, focused tests, and listed verification are complete. Do not flip the
top-level `done` value until every non-deferred task in this plan is implemented
and verified in the original worktree.

If an agent completes only part of a task, append a dated note under that task
and leave its `done: false` line unchanged.

## Root Cause

`syncExternalHashRoute` is designed as a manually callable sync helper:

```ts
const syncExternalHashRoute = (windowTarget?: AppRouteHashWindowTarget | null) => {
  const target = resolveHashWindowTarget(windowTarget);
  const hashPath = target.location.hash.replace(/^#/, "").trim();
  // ...
};
```

But `startHashRouteSync` registers that helper directly as a DOM event listener:

```ts
mountedWindowTarget?.addEventListener("hashchange", syncExternalHashRoute);
```

When the browser dispatches `hashchange`, it calls the listener with a
`HashChangeEvent`. The helper then treats that event object as an
`AppRouteHashWindowTarget`. `HashChangeEvent.location` is undefined, so reading
`target.location.hash` crashes.

## KISS Shape

Keep the fix app-local and behavior-preserving:

1. Do not change `packages/e2e/helpers/app-launcher.ts`.
2. Do not change Solid router setup or Tauri routing mode.
3. Do not change hash route semantics.
4. Add a regression that proves event arguments are ignored.
5. Wrap the DOM listener so `syncExternalHashRoute` always receives the mounted
   window target, never the event object.

## Non-Goals

- Do not rewrite route synchronization.
- Do not replace `HashRouter`.
- Do not add a global router abstraction.
- Do not normalize every possible malformed hash in this slice.
- Do not broaden the fix into deep-link, auth, or startup-route handling.
- Do not change installed app navigation behavior beyond preventing the crash.

## HRS00: Repro Regression

done: true

Add a focused unit regression in
`packages/app/src/app/tests/context/app-route-sync.test.ts`.

The test should:

- create a fake Tauri `windowTarget` with `location.hash`, `addEventListener`,
  and `removeEventListener`
- create the same hashchange wrapper used by `startHashRouteSync`
- set `fakeWindowTarget.location.hash` to `#/dashboard/settings`
- invoke the wrapper with a fake event object, for example
  `{ type: "hashchange" } as any`
- assert no throw
- assert navigation happened as
  `{ to: "/dashboard/settings", options: { replace: true } }`

`startHashRouteSync` itself uses Solid `onMount`, which is a no-op under the
repo's default Node/server unit-test resolution. Keep listener registration and
cleanup covered by the source contract test in HRS02 instead of adding jsdom or
browser-condition test wiring for this narrow slice.

## HRS01: Listener Wrapper

done: true

Change only `startHashRouteSync` in
`packages/app/src/app/context/app-route-sync.ts`.

Use a wrapper listener instead of registering `syncExternalHashRoute` directly:

```ts
let onHashChange: AppRouteHashChangeListener | null = null;

onHashChange = createAppRouteHashChangeListener(() => mountedWindowTarget, syncExternalHashRoute);
mountedWindowTarget.addEventListener("hashchange", onHashChange);
```

Cleanup must remove the same wrapper:

```ts
if (mountedWindowTarget && onHashChange) {
  mountedWindowTarget.removeEventListener("hashchange", onHashChange);
}
mountedWindowTarget = null;
onHashChange = null;
```

Keep `syncExternalHashRoute(windowTarget?)` intact for explicit test/manual
calls. Do not add broad event-shape parsing unless the wrapper regression shows
it is still needed.

## HRS02: Contract Test Update

done: true

Update
`packages/app/src/app/tests/app-refactor-contracts.test.ts`.

The existing contract currently expects direct listener registration:

```text
addEventListener("hashchange", syncExternalHashRoute)
removeEventListener("hashchange", syncExternalHashRoute)
```

Replace that expectation with the new intended contract:

- `startHashRouteSync` creates an internal wrapper listener
- the wrapper calls `syncExternalHashRoute(mountedWindowTarget)`
- cleanup removes that same wrapper listener

Keep this as a source-structure guard only. The behavior must be covered by
`app-route-sync.test.ts`.

## HRS03: Verification

done: true

Run focused verification from the repo root:

```powershell
corepack pnpm@10.27.0 --dir packages/app exec node --test --import=tsx/esm src/app/tests/context/app-route-sync.test.ts src/app/tests/app-refactor-contracts.test.ts
corepack pnpm@10.27.0 --dir packages/app typecheck
git diff --check -- packages/app/src/app/context/app-route-sync.ts packages/app/src/app/tests/context/app-route-sync.test.ts packages/app/src/app/tests/app-refactor-contracts.test.ts
```

If local dependencies are missing, run `pnpm install --frozen-lockfile` first
and record that in the implementation note.

## Completion Criteria

The fix is complete only when:

- a fake event passed to the hashchange wrapper no longer crashes
- desktop absolute hash routes still navigate with `{ replace: true }`
- dashboard tab alias sync still works
- cleanup removes the registered wrapper listener by source contract
- the focused tests and typecheck pass
- no unrelated files are modified for this slice
