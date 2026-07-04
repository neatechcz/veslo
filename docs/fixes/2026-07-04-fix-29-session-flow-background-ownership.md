# Fix 29: Session Flow Background Ownership

## Problem

Cold-start, first-send, session creation, queued draft continuation, and
passive conversation reads were still partly owned by mounted UI wiring.
`SessionView` and app-level send/create wiring could continue program flow,
mutate busy state directly, or allow live transcript reads without a narrow
background owner boundary.

Source plan:

```text
docs/plans/2026-07-04-session-flow-background-measurability-plan.md
```

Issue link status:

```text
unlinked
```

## Fix

- Moved send/create busy presentation behind
  `session-flow-progress-presenter.ts`.
- Split session creation into a typed backend result plus app-owned state and
  navigation adapters.
- Moved selected-session/status queue-drain continuation effects into
  `session-queue-drain-controller.ts`.
- Made passive conversation read side effects explicit with
  `ConversationPassiveReadPolicy` intents. Browse/live/status reads do not
  start the local server; write follow-up and write-control paths can.
- Added `live-transcript-read-policy.ts` so send/compact success emits typed
  policy events instead of mutating browse/live transcript policy directly.
- Kept `session-flow-facade.ts` as a thin facade and added boundary tests so it
  does not become a hidden coordinator.
- Retargeted stale source-contract coverage to the current typed runtime and
  creation-flow owners.

## Scope Boundaries

- No new `session-flow-coordinator.ts` was introduced.
- No UI redesign or orchestrator rewrite was included.
- Existing send/create/session UX was preserved behind narrower adapters.
- Tauri pilot validation is not counted as passing for this checkpoint because
  the current E2E/debug configuration failed before useful session-flow
  validation.

## Validation

Focused and regression validation:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-preflight-context.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-flow-facade.test.ts src/app/tests/context/session-flow-progress-presenter.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/app-refactor-contracts.test.ts src/app/tests/app-boot-engine-ready.test.ts src/app/tests/app-send-latency-trace.test.ts src/app/tests/app-conversation-abort.test.ts src/app/tests/app-send-orchestration-controller-contract.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-pending-instance.test.ts src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pending-session-send-flow.test.ts
```

Result: `185` passed, `0` failed.

Typecheck:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
```

Result: passed.

Diff hygiene:

```powershell
git diff --check
```

Result: passed with LF/CRLF warnings only.

E2E debug assets were rebuilt before the skipped pilot attempt:

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
Push-Location packages\desktop; pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e; Pop-Location
```

The attempted `runtime-cold-start-session-handoff` pilot was intentionally not
used as acceptance evidence. It failed with:

```text
Invalid package entry 5 in managed dependencies manifest at ...\opencode-managed-deps.json.exe
```

That is a separate E2E/debug packaging configuration problem, not a validated
session-flow regression.

## Status

The session-flow background ownership and measurability implementation is
complete against the unit/regression/typecheck/diff gates. Installed-runtime
pilot validation remains blocked by the E2E/debug packaging setup and should be
handled separately before using that pilot as a release gate for this area.
