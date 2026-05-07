# Codex Admin Assignment Rotation Design

## Goal

Repair Codex OAuth user access when an assigned credential becomes unavailable, whether the assignment was created automatically or explicitly by an admin.

## Context

The existing repair path only rotates `auto_assigned` Codex policies. Admin-managed rows are marked `admin_assigned`, so users manually assigned to a shared Codex credential remain pinned to that credential when it later becomes unavailable. The standalone AI Gateway runtime also wires the rotation service to the runtime credential repository, but that repository does not expose the admin credential listing API used to find replacement candidates.

## Design

Rotation applies to any enabled `codex_oauth` policy with an assigned credential id. Non-Codex policies keep their current behavior. When rotation updates a policy, it preserves the existing `assignmentOrigin`; an admin-assigned row stays admin-assigned after being moved to a healthy Codex credential.

The AI Gateway runtime credential repository will expose the same admin credential list data already available in DEN so the default runtime can find replacement candidates. This keeps the repair service behavior consistent between DEN managed-AI and standalone AI Gateway deployments.

## Data Flow

1. The Codex proxy loads the user's AI access policy.
2. The rotation service checks whether the policy is enabled, uses `codex_oauth`, and has a credential id.
3. If the assigned credential is missing, non-Codex, unhealthy, permanently unavailable, or currently exhausted, the service selects a healthy eligible replacement.
4. The service writes the replacement credential id back to the same user policy while preserving model fields and assignment origin.
5. The proxy resolves the replacement binding and handles the current request with the repaired credential.

## Testing

Add focused regression coverage for admin-assigned Codex rotation in both AI Gateway and DEN. Add AI Gateway runtime coverage proving the default runtime repository exposes replacement candidates. Keep coverage for non-Codex and no-replacement cases so the broader provider policy remains scoped.
