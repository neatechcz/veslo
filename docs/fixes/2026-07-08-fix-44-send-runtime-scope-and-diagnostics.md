# Fix 44: Send Runtime Scope And Diagnostics

Date: 2026-07-08

## Scope

This checkpoint records the implementation slice that followed the
`manual-pnpm-dev-20260708-005156` runtime-log root-cause report.

The slice focuses on the send workflow and its prerequisites:

- app-side server submit scope preservation,
- skill registry event auth recovery and diagnostics,
- workspace skill materialization trace diagnostics,
- orchestrator proxy upstream shutdown classification,
- desktop debug-log direct fallback diagnostics.

It does not claim a fresh live Tauri manual send run, sidecar rebuild, or
desktop dev-process launch after the code changes.

## Problem

The captured manual run showed no Zod send-contract failure. The main failure
was runtime identity loss after a server-owned pending submit:

- a pending first send materialized a real conversation and OpenCode session,
- later sends on the same visible session had no selected workspace scope,
- stop/run control could not safely infer the workspace,
- the UI blocked stop with "workspace scope is missing",
- registry event 401s and skill materialization degradation made the logs noisy,
- shutdown-time proxy socket closes and debug-log direct fallback 400s were hard
  to interpret.

## Fix

- Server-accepted conversation submit results now remember scope across the
  pending client id, request OpenCode id, result OpenCode id, request
  conversation id, and result conversation id.
- Queued and submitted submit results also remember the latest run id under the
  same conversation identities so abort and lifecycle lookup have a stable key.
- Skill registry event polling now includes Den context headers in addition to
  the local Veslo server client token.
- Skill registry 401/403 recovery can retry the same listener key once after
  reacquire, while token rotation avoids a double listener restart and duplicate
  error report.
- Workspace skill materialization status and sync traces include
  `registryError` so degraded states carry the concrete registry failure.
- Orchestrator proxy upstream error classification keeps transient event-stream
  closes non-fatal, keeps non-event closes fatal during normal runtime, and
  marks transient non-event closes non-fatal only after orchestrator shutdown
  has started.
- Desktop debug-log direct fallback status failures now include a short
  sanitized response-body excerpt. HTTP 400 is treated as an invalid direct
  fallback payload for that flushing file so direct-eligible events are not
  retried indefinitely.
- Developer docs were updated for the send scope invariant, shutdown proxy trace
  semantics, and debug-log fallback behavior.

## KISS Boundary

This intentionally stays in the smallest runtime path that addresses the
business failure:

- no global strict Zod mode was enabled,
- no broad session-state refactor was added,
- no global TypeScript strictness sweep was started,
- non-event proxy socket closes remain fatal unless shutdown is already in
  progress,
- skill materialization remains fail-open for registry outages,
- debug-log 400 handling drops only direct-fallback events for the invalid file
  and preserves non-direct events when present.

## Verification

Run on 2026-07-08:

```powershell
pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
# pass 21, fail 0

pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
# pass 43, fail 0

pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/context/workspace-session-selection.test.ts
# pass 8, fail 0

pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/context/skill-registry-orchestrator.test.ts
# pass 7, fail 0

pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/lib/skill-registry-events.test.ts
# pass 6, fail 0

pnpm --filter @neatech/veslo-ui exec node --conditions=browser --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts
# pass 13, fail 0

pnpm --filter @neatech/veslo-ui typecheck
# exit 0

pnpm --filter veslo-orchestrator exec bun test src/tests/proxy-upstream-health-policy.test.ts
# pass 5, fail 0

pnpm --filter veslo-orchestrator typecheck
# exit 0

cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml debug_logs_forwarder
# pass 20, fail 0

git diff --check -- docs\features\session-runtime.md docs\dev\state-and-config-reference.md packages\app\src\app\context\conversation-service.ts packages\app\src\app\context\skill-registry-orchestrator.ts packages\app\src\app\context\workspace-skill-materialization.ts packages\app\src\app\lib\skill-registry-events.ts packages\app\src\app\tests\context\conversation-service.test.ts packages\app\src\app\tests\context\skill-registry-orchestrator.test.ts packages\app\src\app\tests\context\workspace-skill-materialization-sync.test.ts packages\app\src\app\tests\lib\skill-registry-events.test.ts packages\orchestrator\src\cli.ts packages\orchestrator\src\proxy-upstream-health-policy.ts packages\orchestrator\src\tests\proxy-upstream-health-policy.test.ts packages\desktop\src-tauri\src\debug_logs_forwarder.rs
# exit 0, LF/CRLF warnings only
```

`graphify update .` was attempted but could not run because the `graphify`
binary was not available in PATH.

## Status

The code and documentation slice is complete and covered by focused tests.

Remaining validation gap: rebuild sidecars and run a fresh manual desktop
runtime send/stop pass to confirm the new runtime logs no longer show missing
workspace scope after pending materialization.
