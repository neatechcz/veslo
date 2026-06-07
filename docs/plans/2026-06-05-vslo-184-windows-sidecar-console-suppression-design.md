# VSLO-184 Windows Sidecar Console Suppression Design

## Context

On Windows first install or first launch, Veslo can show multiple visible terminal windows while local backend sidecars start. Users have reported windows associated with OpenCode and the Veslo server. A related YouTrack issue is `VSLO-184`: "Windows: veslo-server se v idle pravidelne restartuje a problikava terminalove okno".

The desktop app remains the authoritative runtime. Web-only UI startup is out of scope for design, debugging, and verification.

## Goals

- Prevent visible Windows console or terminal windows from appearing when Veslo starts supervised local backend processes.
- Cover the supervised local runtime paths: OpenCode, Veslo server, Veslo orchestrator, and OpenCode router.
- Preserve process supervision, stdout/stderr collection, PID reporting, health checks, and graceful stop behavior.
- Keep antivirus and SmartScreen behavior separate from terminal-window suppression.
- Prepare a simple tester handoff comment for `VSLO-184` after implementation is complete.

## Non-Goals

- Do not disable, bypass, or advise users to disable antivirus protection.
- Do not guarantee that AVG, Avast, Microsoft Defender SmartScreen, or similar reputation checks will never show prompts.
- Do not switch verification to a web-only runtime.
- Do not create a new YouTrack testing task unless `VSLO-184` turns out to be insufficient during implementation.

## Architecture

The fix should live in `packages/desktop`, where Veslo owns the local runtime lifecycle. The desktop layer starts and supervises local backend processes and is therefore responsible for guaranteeing that Windows launches are hidden.

The existing process model should remain intact where possible:

- Tauri shell sidecars or commands start the processes.
- The desktop runtime stores child handles for stop/restart behavior.
- Output is forwarded into the existing debug log pipeline.
- UI state is derived from existing health and info commands.

If the existing Tauri shell behavior is not enough for one of the Windows paths, introduce a Windows-only hidden launch helper that preserves the same observable contract: process ID, kill support, stdout/stderr stream events, and termination events.

## Runtime Paths

Audit and cover these supervised starts:

- OpenCode direct sidecar start.
- Veslo server sidecar start.
- Veslo orchestrator daemon start.
- OpenCode router sidecar start.
- Fallback executable paths used when bundled sidecars are unavailable.

No fallback path should intentionally open `cmd.exe`, PowerShell, or any visible console window as a way to recover from a failed hidden launch.

## Antivirus And Reputation Scope

Terminal windows and antivirus prompts are separate problems.

In scope:

- Ensure Veslo-owned sidecar startup does not create visible console windows.

Mitigated only:

- Reduce antivirus and SmartScreen prompts by signing Windows executables, keeping publisher identity stable, bundling binaries in the installer, avoiding unnecessary runtime downloads, and submitting false positives or new builds to vendors when needed.

Out of direct control:

- AVG, Avast, Microsoft Defender SmartScreen, and similar products may still show prompts for new, rare, or newly changed executables until reputation is established.

## Error Handling

If hidden process startup fails, Veslo should keep the current app-facing behavior: report the runtime as unavailable or starting, capture diagnostics, and surface status through the app UI.

On Windows, fallback startup must either remain hidden with diagnostics preserved or fail explicitly. It must not trade a backend launch failure for a visible terminal window.

Startup timeouts should continue to tolerate first-run delays from sidecar initialization, database migration, cache setup, or antivirus scanning.

## Testing

Testing should use the real Tauri desktop runtime.

Recommended coverage:

- A native or source-level guard that all supervised Windows sidecar start paths use the hidden launch contract.
- Existing desktop E2E startup coverage to confirm OpenCode, Veslo server, orchestrator, and router still start and expose expected health state.
- A Windows first-run probe on a clean profile. The probe should verify sidecar PIDs and health status, and should confirm no visible console windows appeared. If automatic window detection is unreliable, record explicit manual verification instructions and evidence expectations.

Antivirus prompts should be treated as release QA evidence, not as an automated pass/fail gate.

## YouTrack Handoff

After implementation and verification, add a short comment to `VSLO-184` rather than creating a new test task.

The comment should be simple and tester-oriented:

- State that Windows local backend processes now start hidden.
- Ask testers to check first install/first launch, normal relaunch, and idle behavior.
- Mention that antivirus or SmartScreen prompts may still appear because they are vendor reputation checks, not Veslo terminal windows.
