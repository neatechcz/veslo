# Fix 33: App Legacy Server State Cleanup

Date: 2026-07-06

## Scope

Closed the codebase-only follow-up from the deep app audit of legacy server,
event, and workspace-ID paths. E2E/pilot validation is intentionally excluded
from this checkpoint.

## Problem

The app still had several legacy paths that could recreate server-access style
drift even after the desktop/server identity work:

- The global OpenCode SDK event bus consumed direct and payload events, but did
  not unwrap OpenCode v2 `sync` envelopes such as `mcp.tools.changed.2`.
- Desktop startup avoided restoring stale `veslo.baseUrl`, but the older
  `ServerProvider` still restored and persisted `veslo.server.active` and
  `veslo.server.list` in Tauri.
- Managed-AI config sync could treat an app workspace ID fallback as if it were
  an acknowledged Veslo server workspace ID.

## Fix

- `GlobalSDKProvider` now normalizes stream events through the shared
  `normalizeEvent` path before coalescing and emitting them.
- `normalizeEvent` recursively normalizes payload wrappers, so wrapped `sync`
  envelopes produce the same event shape as direct stream events.
- `ServerProvider` now resolves its initial state through a pure helper and
  ignores persisted server targets in Tauri desktop mode. Desktop also removes
  `veslo.server.active` and `veslo.server.list` instead of writing them back.
- Managed-AI server config read/write paths now register local workspaces before
  using a fallback app workspace ID, and then use the acknowledged server
  workspace ID for config calls.

## Scope Boundaries

This checkpoint does not remove every legacy compatibility bridge in the app.
The following remain deliberate follow-up cleanup candidates, not blockers for
this fix:

- `active-legacy-engine-ready` in `runtime-owner`.
- The unused older `context/veslo-server.ts` store.
- The exported/tested `deriveVesloServerUrl()` helper that rewrites an
  OpenCode URL to the default Veslo port.

Existing E2E/pilot file changes in the worktree are outside this checkpoint.

## Verification

Run on 2026-07-06:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/global-sdk-event-normalization.test.ts src/app/tests/utils/messages-normalize-event.test.ts src/app/tests/context/server-workspace-proxy-url.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts src/app/tests/app-veslo-server-state-stability.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/veslo-server-connection.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check -- packages/app
```

Results:

- Focused app legacy cleanup bundle: `16` passed.
- App source-contract bundle: `14` passed.
- Veslo server connection tests: `10` passed.
- App typecheck passed.
- `git diff --check -- packages/app` passed with LF/CRLF warnings only.

## Status

Implementation is complete for the codebase-only legacy cleanup slice covered
by this checkpoint. The remaining items listed under Scope Boundaries are
smaller cleanup work and do not block this fix.
