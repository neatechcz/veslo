# Fix 07: Managed AI runtime authorization prime

## Problem

In shared unsandboxed engine mode, a managed AI provider request could fail with:

```json
{
  "code": "gateway_runtime_authorization_required",
  "message": "Managed AI gateway authorization is not available in this Veslo server runtime"
}
```

The failure was process-state related. Veslo server stores managed gateway
authorization in memory after `/ai-gateway/me/ai-access`. A local server restart
can keep the same client token and provider config while losing that in-memory
authorization map. Send readiness validated the OpenCode routing config, but it
did not re-prime the current Veslo server runtime before allowing the managed
provider request to proceed.

## Fix

- Send runtime readiness now performs a managed AI runtime authorization prime
  after validating current managed routing config and before allowing Send to
  continue.
- The prime calls `/ai-gateway/me/ai-access` through the same local Veslo server
  routing target used by the managed provider config, so the active server
  process repopulates its in-memory authorization map.
- If runtime authorization cannot be primed, Send blocks with a local readiness
  error instead of leaking into the provider proxy as a later 401.
- Desktop shared-unsandboxed runtime preferences now also affect Veslo server
  spawn. The server launch identity tracks the resolved sandbox backend so a
  healthy but stale server process is not reused after the sandbox/shared-engine
  preference changes.

## Coverage

- `send-runtime-readiness.test.ts` covers successful runtime authorization
  priming and blocking behavior when priming fails.
- `app-managed-ai-bootstrap-gate.test.ts` covers the app wiring from runtime
  readiness to the local Veslo server `/ai-gateway/me/ai-access` prime.
- `veslo_server` Rust unit tests cover sandbox backend resolution from runtime
  preference and server respawn when sandbox backend changes.

