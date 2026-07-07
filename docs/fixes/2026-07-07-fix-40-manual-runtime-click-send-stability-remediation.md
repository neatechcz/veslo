# Fix 40: Manual Runtime Click Send Stability Remediation

Date: 2026-07-07

## Scope

Implemented the critical stability tasks from
`docs/plans/2026-07-07-manual-runtime-click-send-stability-remediation-plan.md`.

This note covers the non-E2E remediation pass for manual-runtime click-send
stability and runtime observability blockers. It does not claim a live Tauri
Pilot desktop click-send run, force sidecar rebuild, or dev-server launch.

Branch during verification: `sandbox-merge`.

## Fix

- Fixed Chrome DevTools MCP shim recursion by resolving the real vendored
  entrypoint and preserving forwarded watchdog invocations instead of importing
  the shim again.
- Extended dev cleanup detection so recursive Chrome DevTools MCP sidecar
  children are found by vendored package command line, even when Windows omits
  the executable path.
- Changed workspace skill materialization readiness so a configured
  `pending`/`reloadRequired` status with sync auth/route failure blocks runtime
  readiness instead of returning a false-ready success.
- Stopped skill-registry event polling on 401/403, preserved cursor state, and
  routed auth recovery through the existing managed server ensure callback.
- Stabilized managed-AI config sync during active send/run by skipping inactive
  workspace heal before `listWorkspaces`, and by using the last-known config
  snapshot to avoid stale compare churn immediately after our own write.
- Narrowed AI gateway unresolved placeholder fail-closed behavior to
  `/providers/*/v1/chat/completions`, with a regression guard that non-chat
  provider routes keep the existing sessionless fallback behavior.

## Self Review

The post-implementation review found one actionable issue in the first Task 4
implementation: the auth handler cleared the listener key and called
`ensureLocalVesloServerRunning`, but did not immediately re-sync the listener
after a successful reacquire. That meant recovery could depend on a later Solid
signal change. The handler now calls the existing listener sync path after
reacquire, and the orchestrator test verifies a new listener starts from the
auth callback itself.

No additional blocking code-level issues were found in this pass.

Review boundaries and residual risk:

- Live desktop/Tauri Pilot click-send validation was not run in this pass.
- Sidecars were not force rebuilt and `pnpm dev` was not launched in this pass.
- The repo remains broadly dirty from adjacent work; this note covers only the
  manual-runtime click-send stability remediation.
- `git diff --check` passes but reports existing LF/CRLF warnings from the
  Windows checkout.
- Full app `test:unit` was not rerun here; focused behavioral suites plus app
  and server typechecks were run.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo exec node --test scripts/chrome-devtools-mcp-shim.test.mjs scripts/cleanup-dev-processes.test.mjs
# pass 12, fail 0

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts src/app/tests/app-local-veslo-server-ensure.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts
# pass 43, fail 0

pnpm --filter @neatech/veslo-ui typecheck
# exit 0

pnpm --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts
# pass 24, fail 0

pnpm --filter veslo-server typecheck
# exit 0

git diff --check
# exit 0, LF/CRLF warnings only
```

Additional self-review rerun after tightening the skill-registry auth recovery:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/skill-registry-orchestrator.test.ts
# pass 6, fail 0

pnpm --filter @neatech/veslo-ui typecheck
# exit 0

git diff --check -- packages/app/src/app/context/skill-registry-orchestrator.ts packages/app/src/app/tests/context/skill-registry-orchestrator.test.ts
# exit 0, LF/CRLF warnings only
```

## Status

The critical remediation tasks are implemented and covered by focused tests.
The remaining validation gap is a live manual desktop/Tauri Pilot click-send
runtime run after sidecar rebuild and dev-server startup.
