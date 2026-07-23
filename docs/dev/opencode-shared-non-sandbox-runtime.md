# Shared OpenCode Engine in Non-Sandbox Mode

Veslo retains an explicitly opt-in shared non-sandbox compatibility mode for
trusted local workspaces. It is not the normal desktop topology and is not a
sandbox replacement.

## Enable

Fresh desktop profiles use the normal pooled-per-workspace engine topology.
Existing profiles with `sharedUnsandboxedEngine=true` keep that explicit
compatibility choice until it is disabled. Turning the Settings switch off
persists `sharedUnsandboxedEngine=false`, which emits
`VESLO_DISABLE_SANDBOX=0` and `VESLO_SHARED_OPENCODE_ENGINE=0` for managed
local processes.

For bare orchestrator/server processes, enable it explicitly:

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

- Bare orchestrator and fresh desktop default mode is
  `pooled-per-workspace`; `shared-unsandboxed` is explicit compatibility mode.
- `VESLO_SHARED_OPENCODE_ENGINE=1` without `VESLO_DISABLE_SANDBOX=1` is a
  configuration error.
- WSL sandbox and other sandbox backends cannot use the shared engine.
- If sandbox setup is unavailable and Veslo falls back to unsandboxed mode, it
  still keeps per-workspace engines unless the shared flag is explicitly set.

## Direct Fallback Is Not Shared Mode

On Windows, the configured backend can be `windows-wsl2` while the effective
engine is `direct`. This happens when WSL, the managed `VesloSandbox` distro,
bubblewrap, or the workspace mount is not ready. The orchestrator logs the
sandbox failure, emits the unsandboxed warning, and starts a host engine for the
target workspace.

That fallback is intentionally different from shared non-sandbox mode:

- health/status snapshots report workspace-scoped engines with
  `childKind=direct`,
- Settings devtools show configured backend, effective backend, child kind, and
  `sandboxFallback`,
- managed AI and directory path routing use the effective runtime state,
- `VESLO_SHARED_OPENCODE_ENGINE=1` remains ignored or rejected unless
  `VESLO_DISABLE_SANDBOX=1` is also set.

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

In the default mode, `engineTopology` is `pooled-per-workspace` and workspace
engines continue to appear in `engines`. Only an explicit compatibility
configuration should report `shared-unsandboxed`.

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
