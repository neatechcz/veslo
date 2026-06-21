# Windows Updater Install Recovery Design

## Context

The Windows MSI updater can fail or stall after the installer handoff while the old app version is still able to start and offer the same update again. The previous app flow prepared Veslo-managed services, handed off to the installer, closed the update handle, and immediately relaunched from the frontend.

## Design

Windows updater installs now use a guarded handoff:

- Persist the target version and start time before invoking the Windows installer.
- Move the updater UI into an `installing` state with no action button.
- Do not call the frontend relaunch path after a Windows MSI handoff.
- On startup, clear the marker if the launched app version is the target version.
- If the marker is recent and the app version is still old, keep the UI in `installing` and suppress quiet update checks.
- If the marker is stale, clear it and show a retryable update error.

Non-Windows runtimes keep the existing install-and-relaunch behavior.

## Verification

The primary automated coverage is app-level updater state tests because reproducing a signed two-release Windows MSI update flow is not available in ordinary local development. Real updater validation still needs the documented two-release desktop updater test.
