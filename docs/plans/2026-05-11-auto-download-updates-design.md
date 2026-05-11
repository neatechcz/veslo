# Auto-Download Desktop Updates Design

## Goal

Make desktop updates feel automatic by downloading a newly detected version by default, while keeping a Settings preference that lets a user opt out and return to the manual download flow.

## Context

Veslo already uses the Tauri updater plugin in the desktop app. The app checks for updates quietly on startup, keeps updater state in the Solid app updater context, and surfaces detected updates in Settings plus the dashboard/session left menu.

The current flow supports auto-download, but the preference defaults to off. When an update is found, the left menu can show a manual `Download` action before the downloaded update becomes ready to install.

## Selected Approach

Keep the existing updater architecture and make auto-download the default preference.

- New installs and users without a stored preference get auto-download enabled.
- Existing stored preferences remain authoritative.
- Users can still disable auto-download in Settings.
- When auto-download is enabled, a detected update starts downloading automatically.
- The left menu shows download progress and then an `Update` action.
- Manual `Download` remains available only when auto-download is disabled.

This preserves user control without making manual download the default path.

## Architecture

The Tauri updater plugin, release feed, updater signatures, Rust environment gating, and install/relaunch flow do not change.

The change stays in the app layer:

- The updater state machine remains `idle`, `checking`, `available`, `downloading`, `ready`, and `error`.
- The `updateAutoDownload` signal defaults to `true`.
- Startup preference hydration respects stored values:
  - no `veslo.updateAutoDownload` value means enabled
  - `veslo.updateAutoDownload=1` means enabled
  - `veslo.updateAutoDownload=0` means disabled
- Existing automatic effects continue to trigger `downloadUpdate()` when state becomes `available` and auto-download is enabled.
- Enabling auto-download continues to imply automatic update checks.

## UI Behavior

Settings keeps the auto-download control, but the copy should describe the default behavior clearly: Veslo downloads new desktop versions automatically after detecting them.

The dashboard and session left menu should behave as follows:

- `available` with auto-download enabled: no prominent manual `Download` action; if visible briefly, present it as a preparing state.
- `available` with auto-download disabled: show the existing manual `Download` action.
- `downloading`: show progress.
- `ready`: show `Update`.
- `ready` while active runs exist: keep `Update` visible but disabled or blocked by the existing active-run guard.

The product intent is that the normal user path is "notice update is ready, click Update", not "click Download, wait, then click Update".

## Error Handling

Existing behavior remains:

- Unsupported updater environments, such as running from a mounted macOS disk image, block update checks and explain why in Settings.
- Quiet background check failures do not interrupt the user.
- Download failures enter the `error` state and remain diagnosable from Settings.
- Install continues to refuse restart while any run is active.
- If auto-download is disabled, no background download starts after update detection.

## Testing

Implementation should include focused tests for:

- default auto-download state
- stored preference hydration for enabled and disabled values
- left-menu behavior that hides or avoids the manual `Download` action when auto-download is enabled
- manual `Download` behavior when auto-download is disabled
- existing ready/install active-run guard remaining intact

Because this touches desktop updater behavior, final verification should use the real Tauri desktop runtime according to the desktop testing playbook. The release feed and signing pipeline do not need new coverage because this design does not change release artifacts, endpoints, or signatures.
