# Fix 57: `gpt-5.6-sol` AI Gateway Readiness

Date: 2026-07-17

## Scope

This checkpoint records a production incident where the managed-AI desktop
flow could not create a session for the active Codex OAuth model
`gpt-5.6-sol`. It covers the gateway image, Codex CLI runtime, model-capability
verification, and the final production evidence. It does not expose stored
credential material.

## Symptom

The desktop managed-AI authorization prime failed before session creation with
an AI Gateway-not-ready error. The public readiness endpoint returned HTTP 503
with this stable reason:

```json
{
  "credentials": {
    "ok": false,
    "healthyCredentialCount": 2,
    "reason": "no_healthy_credential_for_active_model"
  },
  "modelPolicy": {
    "activeModel": {
      "provider": "codex_oauth",
      "model": "gpt-5.6-sol"
    }
  }
}
```

Provider reachability and enabled access policies were healthy, so this was not
a generic network outage or a missing user entitlement.

## Root Cause

The incident had two layers.

1. The initially running AI Gateway production image did not contain either
   the package-local `codex` executable or the `@openai/codex` package. The
   current Dockerfile correctly installs it, so this was image drift.
2. After the runtime was rebuilt, the capability verifier still had a
   five-second aggregate deadline. Healthy production Codex OAuth checks took
   roughly 5.5 to 9 seconds. The verifier aborted them before they returned
   positive capability evidence and readiness incorrectly treated all healthy
   credentials as incompatible with `gpt-5.6-sol`.

The controlled credential probe proved the distinction: two stored Codex
credentials successfully served `gpt-5.6-sol`; one already-unhealthy credential
failed authentication. The latter is non-blocking while the two healthy
credentials remain available.

## Implemented

- Rebuilt and deployed the owned-server AI Gateway from `main`, restoring the
  package-local Codex runtime.
- Updated the AI Gateway's exact `@openai/codex` dependency from `0.144.1` to
  `0.144.5`.
- Raised the default platform model-capability deadline from 5 seconds to
  15 seconds. Probes remain bounded, parallel, and abort immediately after the
  first supported credential is found.
- Ran the controlled model migration/probe against the unchanged active model
  `gpt-5.6-sol`, with a verified database backup beforehand.

The production commits are:

- `0d7c81a4` — update the Codex CLI dependency.
- `1d256695` — allow normal-duration Codex capability probes to complete.

## Verification

```powershell
pnpm --filter @neatech/ai-gateway typecheck
# passed

pnpm --filter @neatech/ai-gateway test
# passed: 496 tests, 0 failures
```

The final owned-server deployment completed its Compose and public endpoint
checks successfully. Its post-deploy public readiness result was HTTP 200:

```json
{
  "ok": true,
  "status": "ready",
  "credentials": {
    "ok": true,
    "healthyCredentialCount": 2
  },
  "modelPolicy": {
    "activeModel": {
      "provider": "codex_oauth",
      "model": "gpt-5.6-sol"
    }
  }
}
```

## Follow-up

Reconnect or remove the single stale unhealthy Codex credential through the
admin workflow. It does not prevent inference while the two verified healthy
credentials are available.
