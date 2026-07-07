# Fix 39: Server-Owned Composer UI Test Contracts

Date: 2026-07-07

## Scope

This follow-up fixes stale UI source-contract tests that still described the
pre-server-owned composer submit shape. No production app or server code was
changed in this follow-up.

## What Changed

- Updated app wiring contracts to require the normal send workflow to receive
  `submitConversationFromVesloWriteApi` and to reject production
  `legacyConversationRunFallback` / frontend runtime-prep injection.
- Updated first-send and explicit-target send contracts from legacy fallback
  handoff expectations to server-owned submit / typed `SessionSubmitResult`
  expectations.
- Updated pending handoff, optimistic submit, unread event, workspace activation,
  and settings audit source-contract tests to match the current typed and
  server-owned flow.

## Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-refactor-contracts.test.ts src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts
# pass 21, fail 0

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts
# pass 42, fail 0

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-pending-instance.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-navigation.test.ts src/app/tests/context/session-unread-events.test.ts src/app/tests/pages/settings-tabs-layout.test.ts
# pass 87, fail 0

pnpm --filter @neatech/veslo-ui test:unit
# pass 2484, fail 0, skipped 12

pnpm --filter @neatech/veslo-ui typecheck
# exit 0

git diff --check -- packages/app/src/app/tests/app-refactor-contracts.test.ts packages/app/src/app/tests/app-send-prompt-session-creation.test.ts packages/app/src/app/tests/pending-session-send-flow.test.ts packages/app/src/app/pages/session-pending-instance.test.ts packages/app/src/app/tests/pages/session-scroll-behavior.test.ts packages/app/src/app/tests/pages/session-navigation.test.ts packages/app/src/app/tests/context/session-unread-events.test.ts packages/app/src/app/tests/pages/settings-tabs-layout.test.ts
# exit 0
```

## Notes

The original failures were validation blockers, not evidence that the normal UI
composer path was still calling the legacy run fallback. The current contracts
now preserve the intended direction: normal composer submit is server-owned,
typed results drive UI handoff behavior, and legacy fallback remains outside the
production send wiring.
