# Fix 45: Session Flow Runtime Plan Readiness

Date: 2026-07-09

## Scope

This checkpoint records the runtime-log and plan-readiness audit for
`docs/plans/2026-07-09-session-flow-scope-root-cause-kiss-plan.md`.

It covers the latest available manual dev runtime logs in:

```text
dev-specific/tauri-pilot/manual-runtime-20260709-033601-pnpm-dev
```

It also records the follow-up app-side scope fix that changed new materialized
session scope publishing from passive conversation-scope memory to active
selected-session browse scope.

## Problem

The plan now marks the Phase 0-5 implementation slices as done or targeted-test
verified, but the latest available runtime evidence was still captured before
the last app-side materialized-session scope fix.

The runtime audit found that the old high-severity startup symptoms were gone:

- no `MaxListenersExceededWarning`,
- no `spawnSync pnpm.cmd EINVAL`,
- no `invalid_desktop_diagnostics_event`,
- no malformed split NDJSON trace files,
- shared non-sandbox runtime topology was selected.

The remaining runtime signals were narrower:

- two `workspace_scope_unavailable` blocks remained in the pre-fix run for
  `ses_0bb7aff1effe37ZRV68wGhmxTX`;
- `/opencode/mcp` still had high route volume, with 136 upstream GETs returning
  200;
- app-side `workspace-skill-materialization` degraded traces still only showed
  `message`, `code`, and `status` on the catch path, while the Phase 3 plan
  expects registry action/resource/scope diagnostics in runtime logs;
- the plan text had a stale handoff sentence saying only Phase 0 was complete,
  despite the top-level status marking Phase 0-5 slices done or verified.

## Fix

- `packages/app/src/app/app.tsx` now calls `setSessionBrowseScope()` when a
  first send materializes a real session, workspace, and conversation.
- `packages/app/src/app/tests/app-session-creation-flow-contract.test.ts`
  now asserts that materialized-session state publishing uses
  `setSessionBrowseScope()` before sidebar materialization and handoff.
- The runtime audit confirmed that the split send-workflow trace files are now
  parseable per writer: UI, server, orchestrator, runtime trace, and OpenCode
  health diagnostics all had `malformed=0`.
- The plan should be cleaned up before final handoff so the completed/deferred
  boundary is consistent and the post-materialization `setSessionBrowseScope()`
  fix is explicitly recorded.

## KISS Boundary

This checkpoint does not expand the fix into a new owner rewrite.

Still intentionally out of scope:

- E2E/manual desktop validation after the latest `setSessionBrowseScope()` fix;
- adding `/opencode/mcp` caller/source tracing before a fresh post-dedupe run
  proves route volume is still unexplained;
- richer skill registry UI grouping;
- dedicated token/baseUrl/provider-change characterization tests for Managed AI
  routing;
- splitting shared engines or changing the shared non-sandbox runtime topology.

## Verification

Runtime log audit on the latest available manual run:

```powershell
# manual-runtime-20260709-033601-pnpm-dev
# send-workflow-trace.ui.ndjson: malformed=0
# send-workflow-trace.server.ndjson: malformed=0
# send-workflow-trace.orchestrator.ndjson: malformed=0
# runtime-trace.ndjson: malformed=0
# opencode-health.ndjson: malformed=0

# Counts from the same run:
# MaxListenersExceededWarning=0
# spawnSync pnpm.cmd EINVAL=0
# invalid_desktop_diagnostics_event=0
# workspace_scope_unavailable=2
# scoped-workspace-blocked-missing-scope=2
# /opencode/event=6 string matches, with one real proxy upstream start
# /opencode/mcp=136 proxy upstream starts
# fatal=0
# panic=0
# uncaught=0

# Runtime topology:
# engineTopology=shared-unsandboxed
# engineKind=shared
# sandboxBackend=none
```

Targeted tests already run for the latest app-side scope fix:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-session-creation-flow-contract.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/workspace-send-target.test.ts
# 66/66 pass

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-send-prompt-session-creation.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/session-route-client-resume.test.ts src/app/tests/pages/session-navigation.test.ts
# 55/55 pass

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-session-selection.test.ts src/app/tests/pages/session-inline-loading.test.ts
# 25/25 pass

git diff --check -- packages/app/src/app/app.tsx packages/app/src/app/tests/app-session-creation-flow-contract.test.ts
# exit 0, LF/CRLF warnings only
```

## Status

The implementation plan is mostly implementation-complete outside E2E, but it
is not handoff-clean yet.

Required before calling it final:

- run a fresh manual desktop runtime after the `setSessionBrowseScope()` fix;
- update the plan's stale "completed slice is Phase 0 only" handoff sentence;
- record the `setSessionBrowseScope()` materialized-session hotfix in the plan;
- either add app-side registry action/resource/scope details to
  `workspace-skill-materialization` degraded traces or narrow the Phase 3
  runtime claim to server route payloads only;
- re-check whether `/opencode/mcp` remains high after the fresh runtime run.
