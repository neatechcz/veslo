# Fix 52: First-Message Send Fanout Single-Flight

Date: 2026-07-16

## Scope

This checkpoint records the completed FMSP01--FMSP05 implementation and the
FMSP06 retain-fallback decision from the first-message send fanout remediation
plan. It covers the control and
configuration requests around a healthy first local message; it does not
change the server-owned prompt contract, queue ownership, or transcript
fallback policy.

## Problem

A cold first message could trigger avoidable overlapping work without sending
a duplicate prompt:

- session materialization and `prompt_async` each registered the same local
  orchestrator workspace;
- an app read registration could not reuse a current live/write registration;
- Managed-AI access used one mutable in-flight slot and could issue work before
  identity/routing context was complete; and
- reactive Managed-AI configuration sync and send readiness could independently
  read/apply the same desired configuration.

The retained trace established the fanout. It did not justify removing retries,
lifecycle recovery, or the defensive initial transcript fallback.

## Fix

- A short-lived opaque registration scope now starts in one conversation-submit
  HTTP request and follows both the session-create and `prompt_async` branches.
  It deduplicates one local orchestrator registration by daemon/workspace/path
  only for that request. Failed registrations are removable; queue drains and
  lifecycle reconciliation do not retain the HTTP scope.
- App workspace registration now lets a read join an in-flight live
  registration. The relation remains one-way: a live write never accepts a
  read-only result without current runtime validation.
- Managed-AI access loading now uses a multi-key in-flight map. Its key requires
  authenticated user, organization, gateway/routing mode, and workspace suffix
  when that changes endpoint semantics. Unknown context makes no request,
  schedules no retry, and clears unscoped access state.
- Managed-AI configuration sync now uses a per-fingerprint in-flight map. The
  semantic fingerprint includes target, config source/capabilities, desired
  model/profile, routing/sandbox state, and authorization revisions/fingerprints.
  Equal active-effect and send-readiness work joins; a changed desired state
  starts a distinct flight and prevents stale work from patching newer state.
- The existing opt-in send-workflow trace now records content-free `:flight`
  start/join/settle/reject events at the four join boundaries. It emits only
  opaque process-local ids, never raw fingerprints, tokens, endpoints, paths,
  or prompt text.

## KISS Boundary

- The app still sends exactly one server-owned conversation submit; the server
  still performs the required separate OpenCode session create and `prompt_async`
  operations.
- Client-message idempotency, lifecycle admission, durable queue draining, and
  recovery remain unchanged.
- There is no process-lifetime orchestrator-registration cache and no debounce
  timer introduced merely to reduce request counts.
- Initial transcript fallback is deliberately unchanged by an explicit FMSP06
  reliability decision: retain its bounded read because it protects delayed or
  absent SSE.
- No MSI, WSL, sandbox-installation, or desktop packaging behavior changed in
  this slice.

## Verification

Focused app and server regression suites covered live/read registration joining,
managed-access key isolation and retry, unknown-context deferral, configuration
fingerprint joins/staleness, and one request-scoped orchestrator registration.

```powershell
pnpm check
# passed

pnpm --filter veslo-server build:bin
# passed

git diff --check
# passed; CRLF notices only
```

## Live Desktop Acceptance

On 2026-07-16, a newly started Tauri development runtime was driven through
Pilot with the explicit send-workflow trace opt-in. One first local managed-AI
prompt completed visibly. Its correlated content-free trace showed:

- one accepted submit, one session create, one `prompt_async`, one actual
  scoped orchestrator registration, and one successful upstream model proxy;
- one registration-flight `start`, one internal `join`, and one `settle`; the
  join reused the in-flight request rather than sending another registration;
- one app registration flight (`start` then `settle`), no traced errors, and no
  background registration that reused the HTTP-submit trace context; and
- one bounded transcript fallback `start`/`done` pair that did not create a
  second submit, registration, session creation, or prompt.

The focused source suites remain the proof for same-key Managed-AI
access/configuration concurrency and retry behavior; those cold paths are not
required to appear in every healthy desktop trace.

## Status

Complete. FMSP01--FMSP05 are implemented and desktop-trace accepted. FMSP06
is resolved by retaining the existing defensive fallback unchanged.
