# Fix 54: Scoped Send-Target Snapshot

Date: 2026-07-16

## Scope

Existing-session send and mutation actions only: normal prompt submit,
compaction, replacement, undo, redo, rename, and delete. This does not change
UI behavior, desktop runtime behavior, or server routes. Session export is
included because it reads a concrete existing session.

## Problem

The client could resolve the selected session's workspace more than once while
one action was in progress. Some mutation paths also derived their server
submission target from the active workspace after that resolution. That makes
the action sensitive to a workspace-selection change during the request and
leaves the UI selection too close to execution ownership.

## Fix

- Resolve the existing session's `SendTargetWorkspaceScope` once at action
  start.
- Pass that same scope to the activation guard, preflight, server submission,
  and the scoped client used by undo/redo.
- Rename and delete use the canonical session scope (or an explicitly supplied
  workspace), never the globally active workspace; delete also preserves the
  canonical directory while issuing its scoped client request.
- Session export uses the same canonical target and fails closed when it is
  unavailable.
- Preserve the guard's existing fail-closed behavior when no authoritative
  selected-session scope exists; an active-workspace fallback is not promoted
  to an authority.
- Keep the server as the final owner of target binding and admission. No
  client-side route or authorization bypass was added.

## Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-send-target.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts
# passed: 75/75

pnpm --filter @neatech/veslo-ui typecheck
# passed

pnpm check:lint
# passed

pnpm check:services
# passed: 13/13 real service-runtime scenarios

git diff --check
# passed; CRLF notices only in the pre-existing dirty worktree
```

## Status

Implemented and locally verified. The change establishes one client-side
target snapshot per action; it is preventive consistency hardening, not a
claim that the earlier injected browse/send mismatch was a confirmed current
production path. The regression suite also proves the activation guard never
re-resolves an explicitly supplied action snapshot, and that send, compact,
replacement, undo, redo, rename, and delete retain their scoped target through
their action; export is likewise prevented from reading via an active-client
fallback.
