# Auto-Rotate Auto-Assigned Codex Credentials Design

## Goal

Automatically repair managed-AI access for users whose auto-assigned Codex OAuth credential becomes unhealthy, revoked, draining, missing, or temporarily exhausted, without overriding explicit admin assignments.

## Context

New DEN sign-ups are assigned one healthy eligible `codex_oauth` credential with default model `gpt-5.5`. Runtime routing then treats that assigned credential as a hard constraint. This is correct for explicit admin assignments, but it leaves auto-assigned users stuck when their credential later becomes unavailable even though another healthy credential exists.

VSLO-133 already implemented utilization-aware runtime selection for pool-based routing and explicit failures when all Codex credentials are exhausted. This design adds a narrower user-assignment repair path for automatically managed Codex assignments.

## Non-Goals

- Do not silently override explicit admin assignments.
- Do not rotate OpenAI-compatible assignments. Those credentials define an upstream base URL/API key and should remain explicit admin choices.
- Do not make Codex exhaustion a permanent health failure. Exhaustion remains temporary ineligibility.
- Do not expose upstream Codex auth material to desktop clients.

## Policy

Each user AI access policy needs assignment provenance:

- `auto_assigned`: DEN may repair the credential when it becomes ineligible.
- `admin_assigned`: DEN must preserve the selected credential and fail explicitly when it is unavailable.

Existing rows without provenance should be treated as `admin_assigned` to avoid changing legacy explicit assignments. The signup hook writes `auto_assigned` for future auto-created Codex assignments. Admin user-access writes set `admin_assigned`.

## Rotation Trigger

The first implementation should repair on request path before Codex routing:

1. Load the signed-in user's AI access policy.
2. If the policy is enabled, provider is `codex_oauth`, and provenance is `auto_assigned`, evaluate the assigned credential.
3. If the assigned credential is still eligible, continue normally.
4. If it is missing, not healthy, draining/revoked, or temporarily exhausted, select a replacement with the same eligibility and least-loaded ordering used by signup assignment.
5. Update the user's policy to the replacement credential, preserving model fields.
6. Continue the same request using the replacement credential.

This keeps repair lazy and targeted: no background worker is required, and only users who actually send prompts are touched. A future scheduled sweep can reuse the same service if we want proactive repair.

## Eligibility and Selection

Replacement candidates are `codex_oauth` credentials that:

- are stored as `healthy`,
- have an available binding,
- pass Codex status eligibility,
- are not the current failing credential,
- are sorted by active leases, then recent token usage, then deterministic tie-breakers.

If no replacement is available, keep the existing assignment and return the current explicit `no_eligible_codex_credentials` failure. The error should remain actionable rather than silently clearing access.

## Concurrency

Multiple prompts from the same user may notice the same bad credential at once. The repair update should be idempotent:

- Re-read or compare the current policy before updating where practical.
- If another request already repaired the policy, use the current repaired credential.
- Avoid introducing broad locks; small races are acceptable as long as the final policy points to one eligible credential and requests do not corrupt policy data.

## Audit and Visibility

Record an audit event when an auto-assigned policy is repaired:

- entity type: `user_ai_access`
- entity id: user id or policy id
- action: `user.ai_access.auto_rotate`
- summary includes old credential, new credential, and reason category.

Admin UI can show the new assignment through existing user access and credential views. A dedicated UI badge is not required for the first slice.

## Testing

Tests should cover:

- signup writes auto-assignment provenance,
- admin user-access updates write admin-assignment provenance,
- auto-assigned Codex policy rotates away from an exhausted assigned credential when a replacement exists,
- auto-assigned Codex policy rotates away from unhealthy/missing assigned credential when a replacement exists,
- admin-assigned Codex policy still fails explicitly and does not rotate,
- no replacement keeps the existing policy and returns the existing explicit failure,
- docs describe the new auto-managed rotation semantics.

