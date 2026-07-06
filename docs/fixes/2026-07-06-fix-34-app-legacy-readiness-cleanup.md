# Fix 34: App Legacy Readiness Cleanup

Date: 2026-07-06

## Scope

Closed the remaining app-side follow-up items from Fix 33 that were still
capable of preserving legacy Veslo server assumptions. E2E/pilot validation is
intentionally skipped for this checkpoint.

## Problem

Three app paths still outlived the server-access cleanup:

- The old `context/veslo-server.ts` store was no longer wired into runtime, but
  it still preserved the obsolete localStorage-backed server-list model.
- The exported `deriveVesloServerUrl()` helper encoded the old assumption that
  a Veslo server URL can be guessed by rewriting an OpenCode URL to a fixed
  port.
- `runtime-owner` could still let the active workspace's legacy `engineReady`
  signal count as readiness even when that workspace explicitly requires
  orchestrator readiness.

## Fix

- Removed the unused legacy `context/veslo-server.ts` store.
- Removed `deriveVesloServerUrl()` and its tests; callers must use explicit
  Veslo descriptors/settings instead of deriving a local server URL from the
  OpenCode data-plane URL.
- Fenced `activeLegacyEngineReady` in `runtime-owner` so it cannot bypass
  `requiresOrchestratorReadiness`.
- Added a regression test proving a workspace that requires orchestrator
  readiness remains `not-ready` when only the legacy active `engineReady` flag is
  true.

## Verification

Run on 2026-07-06:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts src/app/tests/lib/veslo-server.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app/src/app/context/veslo-server.ts packages/app/src/app/lib/veslo-server/connection.ts packages/app/src/app/tests/lib/veslo-server.test.ts packages/app/src/app/context/runtime-owner.ts packages/app/src/app/tests/context/runtime-owner.test.ts
```

Results:

- Runtime owner and Veslo server library tests: `68` passed.
- App typecheck passed.
- Targeted `git diff --check` passed with LF/CRLF warnings only.

Additional wider app modularization contract tests were not used as a gate for
this checkpoint because the current dirty worktree has unrelated unclassified
source-reader fixtures:

- `app-workspace-folder-access-request.test.ts`
- `pages/plugins-policy-layout.test.ts`
- `pages/session-folder-access-consent.test.ts`

## Status

Implementation is complete for this codebase-only app legacy readiness cleanup
slice. No E2E/pilot validation was run.
