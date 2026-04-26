# Admin Credential Usage Design

## Goal

Expose usage for every credential on the AI Gateway admin Usage page at `/admin/usage`, with recorded Veslo usage always available and Codex limits status shown best-effort when available.

## Context

The hosted development URL currently serves the `services/ai-gateway` admin shell. The existing usage API reports aggregate usage events, but credentials with no events are absent from filters, charts, and top lists. Credential names are also not part of the usage read model, so the page falls back to raw credential IDs.

Codex credentials are backed by a server-side Codex worker auth JSON. Codex CLI exposes useful account and limits information via interactive `/status`, while the non-interactive CLI exposes only `codex login status`. Because `/status` is interactive and can be slow or unavailable in a hosted service, admin usage must not depend on it for page rendering.

## Recommended Approach

Extend the usage response with a `credentialUsage` list. Each entry represents one admin credential and includes provider, state, request count, token total, active leases, last usage timestamp, and an optional upstream status block. This makes the Usage page the per-credential overview while preserving the existing summary, filters, chart, and top lists.

Historical usage remains authoritative because it comes from `credential_usage_event`. OpenAI and Anthropic entries show recorded usage only. Codex entries also expose a best-effort status block with `available`, `source`, `label`, `checkedAt`, and optional `detail`. The first implementation should support a safe unavailable status and parseable injected status output; a live Codex `/status` probe can be added behind the same interface later without changing the API shape.

## Data Flow

1. The admin service handles `GET /admin/api/usage`.
2. The usage repository aggregates usage events as it does today.
3. The admin service reads all admin credentials.
4. The admin service overlays request and token totals onto every credential.
5. Codex credentials receive a best-effort upstream limits/status object from a status provider.
6. The public admin app renders the existing summary and a new credential usage table.

## Error Handling

The usage endpoint should continue returning historical usage even when upstream Codex status is unavailable. Status probe errors are represented as unavailable status entries instead of failing the endpoint. Secret material must never be returned to the browser or logged.

## Testing

Add API coverage proving that `/admin/api/usage` includes all credentials, including zero-use credentials, and adds Codex status metadata. Add UI coverage proving that the admin shell and script contain the credential usage section and render helpers. Run the focused AI Gateway admin tests, then the AI Gateway typecheck/build.
