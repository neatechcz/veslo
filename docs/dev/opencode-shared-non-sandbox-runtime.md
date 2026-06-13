# Shared OpenCode Engine in Non-Sandbox Mode

Veslo can run one OpenCode engine for multiple local workspaces, but only when
sandboxing is explicitly disabled. This is an operational mode for trusted local
workspaces, not a sandbox replacement.

## Enable

PowerShell:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
```

The orchestrator also accepts:

```powershell
veslo daemon run --shared-opencode-engine
```

The CLI flag still requires `VESLO_DISABLE_SANDBOX=1`.

## Safety Contract

- Default mode remains `pooled-per-workspace`.
- `VESLO_SHARED_OPENCODE_ENGINE=1` without `VESLO_DISABLE_SANDBOX=1` is a
  configuration error.
- WSL sandbox and other sandbox backends cannot use the shared engine.
- If sandbox setup is unavailable and Veslo falls back to unsandboxed mode, it
  still keeps per-workspace engines unless the shared flag is explicitly set.

Expected warning:

```text
!!! UNSANDBOXED SHARED OPENCODE ENGINE !!!
VESLO_DISABLE_SANDBOX=1 and VESLO_SHARED_OPENCODE_ENGINE=1 are enabled.
One OpenCode process will serve multiple workspaces without filesystem isolation.
Do not use this mode for untrusted workspaces.
```

The existing `UNSANDBOXED OPENCODE ENGINE` warning is also emitted when the
engine process is spawned.

## Verify

Check orchestrator health:

```powershell
Invoke-RestMethod http://127.0.0.1:<daemon-port>/health | ConvertTo-Json -Depth 5
```

Expected fields:

```json
{
  "engineTopology": "shared-unsandboxed",
  "sharedEngine": {
    "mode": "shared-unsandboxed",
    "running": true
  }
}
```

In default mode, `engineTopology` is `pooled-per-workspace` and workspace
engines continue to appear in `engines`.

## Disable

Remove the shared flag and restart:

```powershell
Remove-Item Env:\VESLO_SHARED_OPENCODE_ENGINE
```

Remove `VESLO_DISABLE_SANDBOX` as well to return to sandboxed per-workspace
runtime where available.

## Current Limits

- The app and server still use workspace-scoped URLs:
  `/workspace/:id/opencode`.
- Veslo workspace ids remain the source of truth.
- OpenCode 1.17 project API support is probed and logged, but Veslo does not
  yet migrate workspace identity to upstream OpenCode project ids.
- OpenCodeRouter multi-workspace fanout is not expanded by this mode; it should
  continue through the workspace-scoped route for the active workspace.

