# Fix 62: Managed AI Config Admission and Runtime Recovery Noise

Date: 2026-07-28

## Scope

Fixed an ordinary managed-AI conversation send that could stop before OpenCode
submission with:

```text
Managed AI configuration freshness failed: Request timed out after 10000ms:
GET http://127.0.0.1:8787/workspace/<workspace-id>/config
```

The change is limited to the app-owned managed-config and runtime-presentation
boundaries.
Desktop E2E and manual installed-runtime verification remain user-owned and are
not claimed by this fix.

## Root cause

Every server-owned send created a new freshness flight and unconditionally read
the current workspace config. This put a redundant loopback read on the critical
path of every prompt. When the renderer was delayed, the JavaScript timeout was
also delayed and the nominal 10-second request could complete much later.

Separately, the first healthy SSE connection was treated as reconnect recovery,
and a successful lazy server submit did not update the legacy active-workspace
runtime indicator. This produced recovery work and diagnostics that looked like
a fallback even though no outage had occurred.

## Implemented behavior

- Successful managed-config synchronization records the complete verified
  intent for its workspace scope.
- A later send with the exact same verified intent and no pending server reload
  skips the redundant config read.
- A send-preflight loopback transport failure may continue only when that
  complete intent is unchanged and no reload is pending for the exact server
  workspace.
- The intent covers workspace identity and root, exact server workspace,
  managed profile and model roster, server endpoint and token, provider routing,
  DEN authorization revision, and runtime authorization inputs.
- The fallback is process-local and is cleared with the existing managed-config
  tracking reset when server identity, token, or managed access changes.
- Authorization changes, server API responses such as `403`, missing prior
  verification, and pending config reloads remain fail-closed.
- Required config reads emit separate start and completion events with duration
  and deadline-overrun metadata.
- Runtime diagnostics record main-thread stalls with document visibility/focus,
  allowing a slow server response to be distinguished from a suspended or busy
  renderer.
- Initial SSE `live` does not trigger reconnect recovery. Recovery resumes only
  after a non-live state was observed for the same workspace.
- A successful `submitted` result confirms legacy runtime readiness for the
  active workspace. Queued or merely materialized work does not.

## Validation

Focused app validation:

```powershell
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/managed-ai-runtime-config.test.ts
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Results from this implementation pass:

- `87/87` focused app tests passed, covering exact-intent reuse,
  authorization and pending-reload invalidation, initial-live reconnect
  handling, submitted-versus-queued readiness, and runtime lag telemetry.
- App TypeScript validation passed. The repository lint and all workspace
  typechecks also passed inside `pnpm check`.
- `git diff --check` passed with line-ending warnings only.
- The full repository gate did not complete: the app unit lane remained open in
  the pre-existing full managed-config test process after its preceding tests
  had passed. The stuck test processes started by this verification were
  terminated; this is not recorded as a green `pnpm check`.

## Remaining verification

Run the normal desktop flow against the same workspace and confirm that the
second unchanged send has no config GET, the initial live stream has no recovery
episode, and any remaining long pause has either config-read duration or
`session-ui:main-thread-lag` evidence. This manual E2E evidence is intentionally
not claimed here.
