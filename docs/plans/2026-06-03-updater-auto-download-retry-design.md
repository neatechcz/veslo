# Updater Auto-Download Retry Design

**Date:** 2026-06-03
**Status:** Approved

## Goal

Make Veslo desktop updates recover from interrupted or invalid downloads without requiring repeated manual clicks. The app should automatically download an available update, retry failed downloads a bounded number of times, and leave installation as an explicit user action.

## Context

Veslo uses the Tauri updater plugin for update checks, artifact download, signature validation, installation, and relaunch handoff. The current app state machine already defaults update auto-download to enabled. When a download fails, however, the state moves to `error` and does not automatically recover, so users can end up clicking download repeatedly.

Recent updater work from the last week addressed Windows installation reliability, MSI upgrade identity, MSI installer logging, and updater hosting documentation. That work helps when a valid update has already downloaded but installation fails. It does not add retry or resume behavior for interrupted or invalid downloads.

The current Tauri updater API downloads the artifact internally and validates the signature before returning a resource that can be installed. It does not expose a supported way for Veslo to resume a partial download. Veslo should therefore retry a clean full download instead of implementing a separate partial-file cache.

## Decisions

- Automatically download updates when auto-download is enabled.
- Do not automatically install or restart after a valid download.
- After a valid download, show the existing `Update` action.
- Retry auto-download failures three times with backoff: 30 seconds, 2 minutes, then 10 minutes.
- Before each retry, run a fresh quiet update check and use the new update handle.
- Treat invalid artifact/signature failures as retryable download failures.
- After retry exhaustion, show a visible error and a manual `Retry` action.
- A manual retry resets the retry counter.
- Manual download actions do not start a long automatic retry loop; they show an explicit error if they fail.

## Alternatives Considered

### 1. Frontend Retry Orchestration

Keep Tauri as the authority for update download, validation, and installation. Veslo adds retry metadata and timers around the existing updater state machine. Each retry performs a fresh check and starts a clean download.

This is the recommended approach because it is small, keeps the plugin's security model intact, and solves the observed repeated-click failure mode.

### 2. Native Partial Download Cache

Add a Rust download layer with `Range` support, partial files, cache cleanup, and explicit signature validation before handing bytes to installation.

This would support real resume behavior, but it duplicates sensitive updater logic and creates more platform-specific risk. It is not warranted for the current failure mode.

### 3. Better Manual Retry Only

Improve the error state and make the `Retry` button more obvious without background recovery.

This is the smallest change, but it leaves users doing the repeated manual work that caused the problem.

## State Model

Keep the existing user-facing states:

- `idle`
- `checking`
- `available`
- `downloading`
- `ready`
- `error`

Extend download/error state data with retry metadata:

- current attempt number
- maximum attempt count
- next retry time, when scheduled
- whether the attempt was automatic or manual
- last download error message

The retry metadata should be modelled in the updater context rather than scattered across UI components.

## Runtime Flow

1. A quiet check detects an available update.
2. The app stores the update handle and marks the update as `available`.
3. If auto-download is enabled, the app starts the first automatic download attempt.
4. The Tauri updater plugin downloads and validates the artifact.
5. On success, Veslo marks the update as `ready`.
6. The UI shows `Update`; installation and restart only happen after the user clicks it.
7. On download or validation failure, Veslo records the error and schedules the next retry if attempts remain.
8. When the retry timer fires, Veslo performs a fresh quiet check. If the update is still available, it starts a new download attempt with the new handle.
9. After three failed automatic attempts, Veslo marks the update as `error` and shows a manual `Retry`.

## Error Handling

Retryable download failures include:

- network errors
- timeouts
- interrupted streams
- non-success artifact responses
- invalid, incomplete, or signature-mismatched artifacts reported by the Tauri plugin
- failed quiet checks during a scheduled retry

Non-retryable conditions include:

- unsupported updater environment, such as running from a mounted macOS disk image
- desktop install failures after the update is already `ready`
- active-run install blocking

Install errors stay separate from download retry. The existing preinstall cleanup before `install()` remains part of the install path.

## UI Behavior

Settings keeps the existing automatic check and automatic download controls. Auto-download remains default-on.

With auto-download enabled:

- `available` is a short preparation state.
- `downloading` shows progress when Tauri reports total bytes.
- scheduled retry shows text such as `Retrying download` or `Retrying in 2 min`.
- exhausted retry shows a visible download failure and a `Retry` action.
- successful download shows `Update downloaded` and an `Update` action.

The dashboard and session sidebar update pill mirrors the same compact state. It must never imply that installation or restart is automatic.

## Testing

Add focused model coverage for:

- retry schedule values: 30 seconds, 2 minutes, 10 minutes
- maximum of three automatic retry attempts
- retry counter reset after manual `Retry`
- no automatic retry loop when auto-download is disabled
- retry metadata clearing after a successful download

Add app state-machine coverage for:

- automatic download starts after a quiet check finds an update
- failed auto-download schedules retry instead of requiring a click
- retry performs a fresh quiet check before downloading
- successful retry moves to `ready`
- exhausted retry moves to visible `error`

Add UI coverage for:

- retrying text
- failed download `Retry`
- `Update downloaded`
- `Update` remaining manual after a valid download

Real updater installation remains a desktop/Tauri validation concern. The full install and relaunch path still requires the existing manual two-release flow because the updater only offers newer published versions to older installed builds.

## Documentation

Update the desktop updater documentation and state/config reference after implementation. The docs must state clearly that Veslo retries clean downloads and does not resume partial files.

## Non-Goals

- No automatic install or restart after download.
- No partial download resume support.
- No custom artifact cache.
- No replacement of Tauri's signature validation.
- No change to release feed generation or artifact hosting.
