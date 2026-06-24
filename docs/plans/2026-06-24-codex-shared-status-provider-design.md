# Codex Shared Status Provider Design

## Problem

AI Gateway keeps Codex OAuth auth JSON server-side and uses Codex probes to read upstream health and capacity. A single `CachedCodexCredentialStatusProvider` already coalesces concurrent probes for the same credential and persists refreshed auth JSON when Codex rotates it, but default runtime wiring can create separate provider instances for admin, capacity, routing, assignment rotation, and user credential surfaces.

Separate provider instances can probe the same credential concurrently. If both probes load the same stored refresh token before either can persist a rotated auth JSON, Codex may accept one refresh and reject the other as a reused refresh token. That is a server-caused path to `codex_refresh_token_reused`.

## Decision

Create one shared Codex status provider on the AI Gateway runtime state and pass it to every default surface that needs Codex status:

- admin credential read/status and reconnect validation
- Codex capacity monitor
- auto-assigned Codex credential rotation
- binding selection for proxy routing
- user credential dependency surface

The existing provider remains the single-flight/cache implementation. The change is ownership and wiring, not a new status algorithm.

## Non-Goals

- Do not hide or downgrade real `codex_refresh_token_reused` failures. If another runtime uses the same ChatGPT/Codex account, the credential should still become unhealthy.
- Do not add distributed locking yet. Production currently runs one AI Gateway container, so a process-wide shared provider addresses the current server-owned race with less risk.
- Do not change credential upload semantics beyond the already deployed reconnect validation.

## Error Handling

The provider continues to map missing auth JSON and probe failures to unavailable status. Reconnect validation still uses `refreshStatus` to bypass cached status and reject reused refresh tokens before a credential is marked healthy.

## Testing

Add a regression test that builds default admin, proxy, and user credential dependencies from the same runtime, triggers concurrent status reads for the same Codex credential, and proves only one underlying provider probe runs. Existing `CachedCodexCredentialStatusProvider` tests continue to cover intra-provider caching, single-flight, refresh bypass, and auth JSON persistence.
