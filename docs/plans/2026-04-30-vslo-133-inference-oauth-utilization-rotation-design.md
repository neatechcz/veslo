# VSLO-133 Inference OAuth Utilization and Rotation Design

## Summary

VSLO-133 finishes OAuth-backed inference credential rotation by making real utilization part of assignment. The system should avoid assigning exhausted Codex OAuth credentials to new inference requests, record enough usage data to audit each request, and keep the standalone AI Gateway admin surface useful for inspecting rotated credentials.

The change applies to both managed-AI backends in this repo:

- DEN managed-AI, because signed-in users and managed access policy live there.
- The standalone AI Gateway, because `https://veslo-ai-gateway-dev.onrender.com` is still the default managed-AI base URL and must show credential usage and rotation state.

## Goals

- Track provider-account usage for every inference request.
- Track request, session, user, and organization attribution where available.
- Store input, output, cached, and total token counts.
- Use recorded and upstream usage data when choosing OAuth credentials.
- Skip exhausted Codex credentials when another eligible credential exists.
- Return an explicit, actionable failure when all eligible credentials are exhausted.
- Expose enough admin data to understand why a credential was selected, skipped, or rotated away.

## Non-Goals

- Replace the existing managed Codex worker architecture.
- Make the desktop app talk directly to DEN or AI Gateway for provider traffic.
- Treat temporary Codex 5-hour or weekly exhaustion as permanent credential failure.
- Block assignment only because Codex limit probing is unavailable when a credential is otherwise healthy.
- Add UI-heavy redesign beyond the admin fields needed to inspect eligibility and rotation state.

## Current State

The repo already has the core scaffolding:

- Credential records and credential bindings.
- Sticky session leases per provider/session.
- Usage events tied to credential, binding, user, provider, session, request, and model.
- Admin usage aggregation.
- Codex best-effort upstream limit status in the standalone AI Gateway.
- DEN managed-AI proxy routes for OpenAI, Anthropic, and Codex OAuth.

The main gaps are:

- Codex proxy responses currently do not provide token counts, so usage is recorded without meaningful token totals.
- The usage schema lacks cached and total token fields.
- Organization attribution is incomplete in usage events.
- Credential selection only filters by health/assignment, not by real utilization or upstream exhaustion.
- DEN does not yet have the same Codex limit-status provider shape as the standalone AI Gateway.
- Admin read models do not clearly show whether a credential is eligible, exhausted, or skipped.

## Recommended Approach

Implement the same accounting and selection semantics in both DEN managed-AI and standalone AI Gateway. Keep each service self-contained, but use the same type shapes, tests, and behavior names so the two paths do not drift.

Credential exhaustion should be modeled as temporary selection ineligibility. A credential that is healthy but at a Codex 5-hour or weekly limit should stay healthy, keep its audit history, and become eligible again when its reset time passes. Permanent auth failures such as invalid refresh tokens should continue using the existing unhealthy/revoked paths.

## Data Model

Extend usage events with:

- `org_id`
- `input_tokens`
- `output_tokens`
- `cached_tokens`
- `total_tokens`

Keep `input_tokens` and `output_tokens` for existing aggregation compatibility. Store `total_tokens` explicitly instead of recomputing everywhere, because providers may define totals differently when cached tokens are present.

Use zero for missing numeric token fields. Preserve the request event even when token details are unavailable, because attribution and request counts are still useful.

## Token Extraction

OpenAI-compatible responses should read:

- input from `usage.prompt_tokens` or `usage.input_tokens`
- output from `usage.completion_tokens` or `usage.output_tokens`
- cached from `usage.prompt_tokens_details.cached_tokens`, `usage.input_tokens_details.cached_tokens`, or equivalent nested token detail fields
- total from `usage.total_tokens`, falling back to input plus output

Anthropic responses should continue reading `usage.input_tokens` and `usage.output_tokens`, with cached tokens set to zero unless a compatible cache field appears.

Codex worker responses should return meaningful `usage` when the worker can parse token-count events from the Codex session log. If no token-count event is found, return `usage: null` and record a request-count-only usage event with zero token counts.

## Credential Selection

Add a utilization-aware eligibility layer around the existing binding selector:

1. Load healthy candidate bindings for the provider pool.
2. For Codex OAuth, load upstream status for each candidate credential.
3. Exclude candidates whose 5-hour or weekly Codex window is exhausted.
4. Prefer candidates with fewer active leases, then lower recent recorded token usage, then stable creation order.
5. Record skip reasons for audit/debug output.

For assigned Codex credentials, the required credential remains a hard constraint. If that specific credential is exhausted, fail explicitly instead of silently using another credential the admin did not assign.

For auto-assignment, pick the first non-exhausted eligible Codex credential using the same eligibility model.

## Exhaustion Rules

A Codex credential is exhausted when a parsed 5-hour or weekly window has `usedPercent >= 100`.

If reset time is known and already in the past, the credential should not be considered exhausted by stale status alone. A fresh status check can still reclassify it.

If status probing fails or limits are unknown, the credential remains selectable unless the failure indicates permanent auth trouble, such as invalid grant, reused refresh token, or unauthorized access.

## Error Handling

When no eligible binding exists because every candidate is exhausted, return a structured service error such as:

```json
{
  "error": "no_eligible_codex_credentials",
  "reason": "all_codex_credentials_exhausted",
  "provider": "codex_oauth"
}
```

The admin/debug detail may include non-secret credential ids, names, status labels, and reset times. It must never include auth JSON, access tokens, refresh tokens, or prompt/completion bodies.

## Admin Visibility

The standalone AI Gateway admin UI should show, for every Codex credential:

- recorded request count
- recorded input, output, cached, and total tokens
- current 5-hour and weekly upstream status
- active leases
- eligibility state: eligible, exhausted, unavailable, unhealthy, draining, revoked
- last skip reason when available

DEN admin read models should expose the same data shape so the UI can remain aligned if the runtime base URL moves later.

## Testing

Unit tests should cover:

- cached-token extraction from OpenAI-compatible response shapes
- Codex token-count extraction from session logs
- usage persistence with cached and total token fields
- aggregate usage by credential, user, and org
- exhausted Codex credentials skipped when another eligible credential exists
- assigned exhausted Codex credential returns an explicit failure
- all-Codex-exhausted failure message
- unknown Codex limits remain selectable
- permanent auth failures remain ineligible
- admin read models show zero-use credentials and eligibility state

Run focused tests for both services. Full desktop E2E is not required for the design/doc phase, but final implementation should include a real desktop managed-Codex smoke if runtime behavior changes.

## Risks

- Running a Codex status probe per request would be too slow. Use cached upstream status with a short TTL and fall back conservatively.
- If both services evolve separately, behavior can drift. Keep type names, test scenarios, and user-facing error codes aligned.
- Unique request ids may already exist when upstream retries occur. Usage writes should avoid crashing the proxy path on duplicate usage events.
- Organization attribution may require gateway session enrichment. If org id is unavailable in one path, store null rather than guessing.
