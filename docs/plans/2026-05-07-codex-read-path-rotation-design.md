# Codex Read-Path Rotation Design

## Context

The credential rotation fix repairs `codex_oauth` assignments when the Codex proxy route handles a request. The admin Users page reads the stored AI-access policy through the admin endpoint and then filters the credential selector to healthy assignable credentials. When a stored Codex credential is unhealthy or exhausted, that credential is hidden from the selector, so the editor appears to have no assigned credential until the user makes a Codex request.

## Design

Repair assigned Codex access before serializing AI-access policies from read endpoints. The repair uses the existing Codex rotation service, so the same eligibility checks, audit behavior, assignment-origin preservation, and non-Codex exclusion rules apply.

The repair hook applies to:

- AI Gateway admin `GET /admin/api/users/:userId/ai-access`.
- AI Gateway user self-read routes.
- DEN managed-AI admin `GET /admin/api/users/:userId/ai-access`.
- DEN managed-AI user self-read route.

This keeps OpenAI-compatible and other non-Codex assignments unchanged. If no replacement credential exists, the existing assignment remains unchanged and the endpoint still returns the current policy.

## Verification

Add regression tests that prove an admin read of an admin-assigned Codex policy updates `cred_old` to `cred_new` before returning the response. Keep existing non-Codex rotation tests as the guardrail that only `codex_oauth` policies repair.
